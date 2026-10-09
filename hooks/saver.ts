// The commands' logic, ported from saver.py: /token-audit, the startup check, /savings, /pet, /wrapped, /handoff
// and /toggle. Token counts are chars/4, the same approximation graphify and most tools use.
import type { EnvName, Io } from './io'

type Json = Record<string, unknown>

const LONG_FILE = 500 // tokens; Firecrawl's guide targets 200-500 for CLAUDE.md
const MEMORY_LINES = 200 // auto memory loads only this much of MEMORY.md
const MEMORY_BYTES = 25000
// Published reductions. Sources: caveman README (65% avg output cut), ponytail benchmarks (80-94% fewer lines; low end used).
const CAVEMAN_CUT = 0.65
const PONYTAIL_CUT = 0.8
// shortcut: guess, not measured. Each graph query is assumed to replace this many file reads.
const GRAPHIFY_READS_AVOIDED = 5
const DEFAULT_READ_TOKENS = 1500 // used when the session has no Read calls to average
export const NOISY = 2000 // tokens; a tool result this big rides along on every later call
const NOISY_REPEAT = 3 // the startup check names a command once the mod has trimmed it this often
const CACHE_READ_PRICE = 0.1 // cache reads bill at 10% of input
const HANDOFF_DAYS = 7
const MANY_FILES = 1000 // a gitignored folder this big is flagged like node_modules
// Generated folders the read guards block, so the startup check never flags them.
export const HEAVY = ['node_modules', '__pycache__', '.venv', 'venv', '.next', 'coverage', 'dist', 'build', 'target']

// Clawd as on Claude Code's welcome banner: head with two eye cells, body (arms down, arms up), legs.
const PET_HEAD = (eyes: string) => ` ▐${eyes[0]}███${eyes[1]}▌`
export const PET_BODY = ['▝▜█████▛▘', '▗▟█████▙▖'] as const
const PET_LEGS = '  ▘▘ ▝▝'
// [lifetime tokens saved, what Clawd wears beside its head]. Below the lowest stage it's an egg (whole, then cracked).
export type Stage = readonly [number, string]
export const PET_STAGES: readonly Stage[] = [[2_500_000, '✦✦'], [250_000, '✦'], [10_000, '']]
export const PET_EGG = [['   ▄▄', '  ▟██▙', '  ▜██▛'], ['   ▄▄', '  ▟▚▞▙', '  ▜██▛']] as const
export const PET_CRACK = 5_000 // the egg cracks halfway to hatching
export const PET_WIDTH = 11 // columns Clawd takes left of the status line, gap included

export const SWITCHES: Record<string, string> = {
  pet: 'Clawd on the status line',
  check: 'startup check',
  guard: 'output trim: long shell outputs cut to head, errors and tail',
  secrets: 'secret guard: blocks .env access and hardcoded keys',
  reads: 'read guards: generated folders, lockfiles, huge files, unchanged re-reads',
  focus: 'focus mode: hide tool calls, show steps and what is left',
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// ---------- helpers ----------

export const tokens = (text: string) => Math.floor(text.length / 4)

export const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.floor(n))

const pad2 = (n: number) => String(n).padStart(2, '0')
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

export const slash = (p: string) => p.replace(/\\/g, '/')
export const join = (...parts: string[]) => slash(parts.filter(Boolean).join('/')).replace(/(?<!^)\/{2,}/g, '/')
export const basename = (p: string) => slash(p).replace(/\/+$/, '').split('/').pop() ?? ''
export function dirname(p: string) {
  const s = slash(p)
  const i = s.lastIndexOf('/')
  if (i < 0) return '.'
  const d = s.slice(0, i) || '/'
  return /^[A-Za-z]:$/.test(d) ? d + '/' : d // C:/ stays a root, as os.path.dirname
}

/** os.path.normpath for forward-slash paths: drops `.` and folds `..`. */
export function normpath(p: string) {
  const s = slash(p)
  const lead = /^(?:[A-Za-z]:)?\//.exec(s)?.[0] ?? ''
  const out: string[] = []
  for (const part of s.slice(lead.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop()
    else if (part !== '..' || !lead) out.push(part)
  }
  return lead + out.join('/') || '.'
}

// os.path.normcase, so noisy.json keys match the ones the mod writes and older versions wrote
export const normcase = (p: string) => (/^[A-Za-z]:/.test(p) ? p.replace(/\//g, '\\').toLowerCase() : p)

export const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

export async function claudeDir(io: Io) {
  const dir = (await io.env('CLAUDE_CONFIG_DIR')) || `${await home(io)}/.claude`
  return slash(dir)
}

export async function home(io: Io) {
  return slash((await io.env('HOME')) || (await io.env('USERPROFILE')) || '~')
}

export const ctxFile = async (io: Io, ...parts: string[]) => join(await claudeDir(io), '.statusline-ctx', ...parts)

export async function read(io: Io, path: string): Promise<string | null> {
  try { return await io.read(path) } catch { return null }
}

export async function loadJson(io: Io, path: string): Promise<Json> {
  try {
    const data = JSON.parse((await read(io, path)) ?? '')
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch {
    return {}
  }
}

export const stat = (io: Io, path: string) => io.stat(path).catch(() => undefined)
const isFile = async (io: Io, path: string) => (await stat(io, path))?.kind === 'file'
const isDir = async (io: Io, path: string) => (await stat(io, path))?.kind === 'dir'
const exists = async (io: Io, path: string) => (await stat(io, path)) !== undefined

/** glob(dir/*suffix): full paths of the files in dir whose names end in suffix. */
async function files(io: Io, dir: string, suffix: string) {
  const entries = await io.list(dir).catch(() => [])
  return entries.filter(e => e.kind === 'file' && e.name.endsWith(suffix)).map(e => join(dir, e.name))
}

/** Each [key, count] by count, most first; ties keep first-seen order, as Counter.most_common. */
export function mostCommon<K>(counts: Map<K, number>, n = Infinity) {
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n)
}

const bump = <K>(m: Map<K, number>, k: K, by = 1) => m.set(k, (m.get(k) ?? 0) + by)

/** `npm test` from `cd app && npm test -- --watch | tail`: up to two words, before any flag, quote, pipe or redirect. */
export function cmdKey(cmd: string): string {
  const words: string[] = []
  for (const w of cmd.replace(/^\s*cd\s+\S+\s*(?:&&|;)\s*/, '').split(/\s+/).filter(Boolean)) {
    if (words.length === 2 || `-'"|<>&;$(\``.includes(w[0] ?? '')) break
    words.push(w)
  }
  return words.join(' ')
}

const frontmatter = (text: string) => /^---\n[\s\S]*?\n---/.exec(text)?.[0] ?? ''

// ---------- audit ----------

/** Text Claude actually receives: HTML comments cost nothing. */
export const visible = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '')

async function expanduser(io: Io, p: string) {
  return p.startsWith('~') ? (await home(io)) + p.slice(1) : p
}

/** @path imports outside code, resolved and existing. */
async function imports(io: Io, text: string, base: string) {
  const plain = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, '')
  const found: string[] = []
  for (const m of plain.matchAll(/(?:^|\s)@(~?[\w./\\-]+)/g)) {
    const raw = await expanduser(io, m[1] ?? '')
    const path = normpath(/^(?:[A-Za-z]:)?[\\/]/.test(raw) ? raw : join(base, raw))
    if (await isFile(io, path)) found.push(path)
  }
  return found
}

/** Instruction files Claude Code loads every session, in load order, with @imports. */
export async function alwaysLoaded(io: Io, cwd: string): Promise<[string, string][]> {
  const dir = await claudeDir(io)
  const paths = [join(dir, 'CLAUDE.md'), ...(await files(io, join(dir, 'rules'), '.md'))]
  const chain: string[] = []
  for (let d = normpath(cwd); ;) {
    chain.push(d)
    const parent = dirname(d)
    if (parent === d || !parent || parent === '.') break
    d = parent
  }
  const claudeNames = ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']
  // AGENTS.md loads instead, but only when no CLAUDE.md exists in cwd or above.
  // ~/.claude/CLAUDE.md is global and does not count, though it looks like <home>/.claude/CLAUDE.md.
  const userMd = normcase(normpath(join(dir, 'CLAUDE.md'))).toLowerCase()
  let hasClaude = false
  for (const d of chain) for (const n of claudeNames) {
    const p = join(d, n)
    if (!hasClaude && normcase(normpath(p)).toLowerCase() !== userMd && (await isFile(io, p))) hasClaude = true
  }
  const names = hasClaude ? claudeNames : ['AGENTS.md', '.claude/AGENTS.md']
  for (const d of [...chain].reverse()) paths.push(...names.map(n => join(d, n)))
  paths.push(...(await files(io, join(cwd, '.claude', 'rules'), '.md')))
  paths.push(join(dir, 'projects', projectSlug(cwd), 'memory', 'MEMORY.md'))

  const out: [string, string][] = []
  const seen = new Set<string>()
  const todo = paths.map(p => [p, 0] as [string, number])
  while (todo.length) {
    const [raw, depth] = todo.shift()!
    const path = normpath(raw)
    if (seen.has(path) || !(await isFile(io, path))) continue
    seen.add(path)
    const text = (await read(io, path)) ?? ''
    // Rules with paths: frontmatter load only when matching files are touched.
    if (path.includes('/rules/') && /^paths\s*:/m.test(frontmatter(text))) continue
    out.push([path, text])
    if (depth < 5) todo.push(...(await imports(io, text, dirname(path))).map(p => [p, depth + 1] as [string, number]))
  }
  return out
}

export async function fileFindings(io: Io, path: string, text: string, cwd: string) {
  const out: string[] = []
  const seenText = visible(text)
  const n = tokens(seenText)
  if (n > LONG_FILE) out.push(`long: ${fmt(n)} tokens, target under ${LONG_FILE}`)
  const lines = text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0) // str.splitlines()
  if (basename(path) === 'MEMORY.md' && (lines > MEMORY_LINES ||
      new TextEncoder().encode(text).length > MEMORY_BYTES))
    out.push(`truncated: only the first ${MEMORY_LINES} lines or ${MEMORY_BYTES / 1000}KB load, the rest is dropped`)
  if (slash(path).includes('/rules/')) out.push('loads every session: add `paths:` frontmatter if it only matters for some files')
  for (const block of seenText.match(/```[\s\S]*?```/g) ?? []) {
    const lines = block.split('\n').length - 1
    if (lines > 10) out.push(`code block of ${lines} lines: move to a skill or doc file`)
  }
  const base = dirname(path)
  for (const span of new Set([...seenText.matchAll(/`([^`\s]+)`/g)].map(m => m[1] ?? ''))) {
    if (!/^[\w.~-]*[/\\][\w./\\-]*\.\w{1,5}$/.test(span)) continue
    const rel = await expanduser(io, span)
    let found = false
    for (const b of [cwd, base]) if (!found && (await exists(io, join(b, rel)))) found = true
    if (!found) out.push(`maybe stale path: ${span}`)
  }
  return out
}

export function duplicateLines(loaded: [string, string][]) {
  const where = new Map<string, string[]>()
  for (const [path, text] of loaded)
    for (const line of visible(text).split(/\r?\n/)) {
      const key = line.replace(/\W+/g, ' ').trim().toLowerCase()
      if (key.length > 25) where.set(key, [...(where.get(key) ?? []), path])
    }
  return [...where].filter(([, v]) => v.length > 1)
}

const settingsFiles = async (io: Io, cwd: string) =>
  [join(await claudeDir(io), 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')]

async function envValue(io: Io, name: EnvName, cwd: string) {
  const own = await io.env(name)
  if (own !== undefined) return own
  for (const path of await settingsFiles(io, cwd)) {
    const value = ((await loadJson(io, path)).env as Json | undefined)?.[name]
    if (value !== undefined && value !== null) return String(value)
  }
  return undefined
}

// Project .mcp.json only: ~/.claude.json also holds account and MCP credentials, so it is never read.
const mcpServers = async (io: Io, cwd: string) =>
  Object.keys(((await loadJson(io, join(cwd, '.mcp.json'))).mcpServers as Json | undefined) ?? {}).sort()

/** True once MANY_FILES files are seen; stops early so the startup check stays fast. */
async function manyFiles(io: Io, path: string) {
  let count = 0
  const stack = [path]
  while (stack.length) {
    const dir = stack.pop()!
    for (const e of await io.list(dir).catch(() => [])) {
      if (e.kind === 'dir' && !e.isLink) stack.push(join(dir, e.name))
      else if (e.kind === 'file' && ++count >= MANY_FILES) return true
    }
  }
  return false
}

/** Plain folder names from a .gitignore (`dist/`, `/storage`, `cache/**`); globs and negations skipped. */
export function gitignoredDirs(gitignore: string) {
  const out: string[] = []
  for (const line of gitignore.split(/\r?\n/)) {
    const name = line.trim().replace(/\/\*\*$/, '').replace(/^\/+|\/+$/g, '')
    if (name && !/[#!*?[\]/\\\s]/.test(name) && !name.startsWith('.claude')) out.push(name)
  }
  return out
}

/** Gitignored folders over MANY_FILES files that neither the mod nor permissions.deny blocks. */
export async function unblockedHeavy(io: Io, cwd: string) {
  const rules: string[] = []
  for (const p of await settingsFiles(io, cwd)) {
    const deny = ((await loadJson(io, p)).permissions as Json | undefined)?.deny
    if (Array.isArray(deny)) rules.push(...deny.map(String))
  }
  const deny = rules.join(' ')
  const out: string[] = []
  for (const d of gitignoredDirs((await read(io, join(cwd, '.gitignore'))) ?? ''))
    if (!HEAVY.includes(d) && !deny.includes(d) && (await isDir(io, join(cwd, d))) && (await manyFiles(io, join(cwd, d)))) out.push(d)
  return out
}

/** Custom subagents with no `model:` in their frontmatter: they run on the main model. */
async function unpinnedAgents(io: Io, cwd: string) {
  const out: string[] = []
  for (const path of [...(await files(io, join(await claudeDir(io), 'agents'), '.md')), ...(await files(io, join(cwd, '.claude', 'agents'), '.md'))])
    if (!/^model\s*:/m.test(frontmatter((await read(io, path)) ?? ''))) out.push(basename(path).replace(/\.[^.]*$/, ''))
  return out.sort()
}

const toolSearchOff = async (io: Io, cwd: string) => ['0', 'false'].includes(((await envValue(io, 'ENABLE_TOOL_SEARCH', cwd)) ?? '').toLowerCase())

async function skillFiles(io: Io, dir: string) {
  const out: string[] = []
  for (const e of await io.list(dir).catch(() => []))
    if (e.kind === 'dir' && (await isFile(io, join(dir, e.name, 'SKILL.md')))) out.push(join(dir, e.name, 'SKILL.md'))
  return out
}

const CACHE_WRITE = /"cache_creation":\{([^}]*)\}/g

/** 3600 or 300 from the newest cache write in the transcript's tail, or undefined if there is none yet. */
export function detectTtl(transcript: string | null) {
  if (!transcript) return undefined
  const tail = transcript.slice(-65536)
  for (const body of [...tail.matchAll(CACHE_WRITE)].map(m => m[1] ?? '').reverse())
    for (const [key, ttl] of [['ephemeral_1h_input_tokens', 3600], ['ephemeral_5m_input_tokens', 300]] as const) {
      const m = new RegExp(`"${key}":(\\d+)`).exec(body)
      if (m && Number(m[1])) return ttl
    }
  return undefined
}

export async function audit(io: Io, cwd: string) {
  const loaded = await alwaysLoaded(io, cwd)
  const total = loaded.reduce((n, [, t]) => n + tokens(visible(t)), 0)
  const out = [`Always-loaded instructions: ~${fmt(total)} tokens, re-read on every API call`, '']
  for (const [path, text] of loaded) {
    out.push(`  ${fmt(tokens(visible(text))).padStart(6)}  ${path}`)
    for (const finding of await fileFindings(io, path, text, cwd)) out.push(`          - ${finding}`)
  }
  const dups = duplicateLines(loaded)
  if (dups.length) {
    out.push('', 'Duplicate lines (say it once):')
    for (const [line, paths] of dups.slice(0, 10))
      out.push(`  - "${line.slice(0, 60)}" in ${paths.length} places: ${[...new Set(paths.map(basename))].sort().join(', ')}`)
  }

  const tips: string[] = []
  const servers = await mcpServers(io, cwd)
  if (servers.length) {
    let tip = `${servers.length} MCP server(s): ${servers.join(', ')}. Each can cost 10-20k tokens of tool schemas.`
    if (await toolSearchOff(io, cwd)) tip += ' ENABLE_TOOL_SEARCH is off: turn it on to load schemas on demand.'
    tips.push(tip + ' Disconnect the ones you do not use.')
  }
  tips.push('User-scoped MCP servers are not counted here. Run /mcp to see them all.')
  const heavy = await unblockedHeavy(io, cwd)
  if (await isFile(io, join(cwd, '.claudeignore'))) tips.push('Claude Code does not read .claudeignore. Move its entries to permissions.deny.')
  if (heavy.length)
    tips.push(`Unblocked heavy dirs: ${heavy.join(', ')}. Add to permissions.deny in .claude/settings.json: ${heavy.map(d => `"Read(./${d}/**)"`).join(', ')}`)
  if (!(await envValue(io, 'CLAUDE_CODE_SUBAGENT_MODEL', cwd))) {
    let tip = 'Subagents use your main model. CLAUDE_CODE_SUBAGENT_MODEL=haiku makes exploration and log reading cheaper.'
    const agents = await unpinnedAgents(io, cwd)
    if (agents.length) tip += ` Or add \`model: haiku\` to these agents: ${agents.join(', ')}.`
    tips.push(tip)
  }
  const skills = [...(await skillFiles(io, join(await claudeDir(io), 'skills'))), ...(await skillFiles(io, join(cwd, '.claude', 'skills')))]
  if (skills.length)
    tips.push(`${skills.length} user/project skill(s), ~30-100 tokens each for the description. Skills you only run by hand: add \`disable-model-invocation: true\`.`)
  if (!loaded.some(([, t]) => /^#+\s*compact instructions/im.test(t)))
    tips.push('No "## Compact instructions" section in CLAUDE.md. Add one to say what /compact and auto-compact must keep.')
  if (!(await envValue(io, 'BASH_MAX_OUTPUT_LENGTH', cwd)))
    tips.push('BASH_MAX_OUTPUT_LENGTH is unset. Set it in settings.json env (e.g. 15000 chars) to cap shell output in context.')
  const newest = await newestTranscript(io, cwd)
  if (detectTtl(newest ? await read(io, newest) : null) === 300 && !(await envValue(io, 'ENABLE_PROMPT_CACHING_1H', cwd)))
    tips.push('Prompt cache lasts 5 minutes. ENABLE_PROMPT_CACHING_1H=1 keeps it 1 hour; cache writes then cost 2x input instead of 1.25x.')
  out.push('', 'Other overhead:', ...tips.map(t => `  - ${t}`))
  return out.join('\n')
}

export const handoffPath = async (io: Io, cwd: string) => ctxFile(io, 'handoff', projectSlug(normpath(cwd)) + '.md')

/** {command key: times the mod trimmed it} for this project. */
async function noisyCounts(io: Io, cwd: string): Promise<Record<string, unknown>> {
  const counts = (await loadJson(io, await ctxFile(io, 'noisy.json')))[normcase(normpath(cwd))]
  return counts && typeof counts === 'object' ? counts as Record<string, unknown> : {}
}

/** The settings.json status line an older version installed, if it is still there. */
export async function legacyStatusLine(io: Io) {
  const cmd = ((await loadJson(io, join(await claudeDir(io), 'settings.json'))).statusLine as Json | undefined)?.command
  return typeof cmd === 'string' && cmd.includes('statusline.py') ? cmd : undefined
}

/**
 * The /handoff note once, then (new sessions only) one line when something costs tokens every session.
 * source is SessionStart's: "startup" warns, "clear" only shows the note, undefined (switched off) only the note.
 * Nothing otherwise: hook output costs context.
 */
export async function check(io: Io, cwd: string, source?: string) {
  const out: string[] = []
  const notePath = await handoffPath(io, cwd)
  const note = await read(io, notePath)
  if (note) {
    const st = await stat(io, notePath)
    const fresh = st !== undefined && (await io.now()) - st.mtimeMs < HANDOFF_DAYS * 86400_000
    await io.write(notePath, '') // one-shot: a stale task note misleads more than it helps
    if (fresh && note.trim()) out.push('claude-saver: handoff note from the last session (from /handoff):\n' + note.trim())
  }
  if (source !== 'startup') return out.join('\n')
  const loaded = await alwaysLoaded(io, cwd)
  const flagged: string[] = []
  for (const [p, t] of loaded)
    if ((await fileFindings(io, p, t, cwd)).some(f => f.startsWith('long') || f.startsWith('truncated'))) flagged.push(basename(p))
  const issues: string[] = []
  if (flagged.length) {
    const total = loaded.reduce((n, [, t]) => n + tokens(visible(t)), 0)
    issues.push(`always-loaded instructions ~${fmt(total)} tokens; needs trimming: ${flagged.join(', ')}`)
  }
  const heavy = await unblockedHeavy(io, cwd)
  if (heavy.length) issues.push(`unblocked heavy dirs: ${heavy.join(', ')}`)
  const servers = await mcpServers(io, cwd)
  if (servers.length && (await toolSearchOff(io, cwd))) issues.push(`${servers.length} MCP server(s) with ENABLE_TOOL_SEARCH off`)
  const tip = issues.length ? ' Tell the user to run /token-audit' + (flagged.length ? ' or /doctor prompt-audit (stale or conflicting lines).' : '.') : ''
  // Once the user notes the command in CLAUDE.md (or any always-loaded file), this goes quiet.
  const all = loaded.map(([, t]) => t).join('\n')
  const loud = Object.entries(await noisyCounts(io, cwd))
    .filter(([k, n]) => Number.isInteger(n) && (n as number) >= NOISY_REPEAT && !all.includes(k))
    .map(([k, n]) => [n as number, k] as const)
    .sort((a, b) => b[0] - a[0] || (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
  if (loud[0]) issues.push(`\`${loud[0][1]}\` printed 2k+ tokens ${loud[0][0]} times; add its quiet flag to CLAUDE.md`)
  if (await legacyStatusLine(io)) issues.push('the old Python status line is still set; tell the user to run /saver-setup to switch to the built-in one')
  if (issues.length) out.push(`claude-saver: ${issues.join('; ')}.${tip}`)
  return out.join('\n')
}

// ---------- savings ----------

export async function newestTranscript(io: Io, cwd: string) {
  const projects = join(await claudeDir(io), 'projects')
  const pick = async (dirs: string[]) => {
    let best: [number, string] | undefined
    for (const dir of dirs)
      for (const e of await io.list(dir).catch(() => []))
        if (e.kind === 'file' && e.name.endsWith('.jsonl') && (!best || e.mtimeMs > best[0])) best = [e.mtimeMs, join(dir, e.name)]
    return best?.[1]
  }
  const all = (await io.list(projects).catch(() => [])).filter(e => e.kind === 'dir').map(e => join(projects, e.name))
  return (await pick([join(projects, projectSlug(cwd))])) ?? (await pick(all))
}

const resultText = (content: unknown) =>
  Array.isArray(content) ? content.map(c => (c && typeof c === 'object' ? String((c as Json).text ?? '') : '')).join('')
    : typeof content === 'string' ? content : ''

const SIZE = { '': 1, k: 1e3, M: 1e6 } as Record<string, number>

export type Stats = {
  input: number; cache_write: number; cache_read: number; output: number; calls: number; text: number; code: number
  caveman: boolean; ponytail: boolean; reads: number[]; graph_queries: string[]; graph_results: number
  noisy: [number, string][]; noisy_count: number; model_switches: number; cwd: string | null; stamps: Date[]
  denied: (number | null)[]; compacts: [number, number][]; main_calls: number; trimmed: number[]; guard_saved: number
  tools: Map<string, number>
}

/** Usage deduped by message id (one transcript line per content block) plus content sizes. */
export async function sessionStats(io: Io, path: string): Promise<Stats> {
  const s: Stats = {
    input: 0, cache_write: 0, cache_read: 0, output: 0, calls: 0, text: 0, code: 0, caveman: false, ponytail: false,
    reads: [], graph_queries: [], graph_results: 0, noisy: [], noisy_count: 0, model_switches: 0, cwd: null, stamps: [],
    denied: [], compacts: [], main_calls: 0, trimmed: [], guard_saved: 0, tools: new Map(),
  }
  const seen = new Set<unknown>()
  const toolNames = new Map<string, string>()
  const toolLabels = new Map<string, string>()
  const results = new Map<string, number>()
  const commands = new Map<string, string>()
  let model: string | undefined
  const transcripts = [path, ...(await files(io, join(path.replace(/\.[^./\\]*$/, ''), 'subagents'), '.jsonl'))]
  for (const f of transcripts) {
    // shortcut: a full parse per call; parse only appended bytes if long sessions lag
    for (const line of ((await read(io, f)) ?? '').split('\n')) {
      if (line.includes('CAVEMAN MODE ACTIVE')) s.caveman = true
      if (line.includes('PONYTAIL MODE ACTIVE')) s.ponytail = true
      let entry: Json
      try { entry = JSON.parse(line) } catch { continue }
      if (!entry || typeof entry !== 'object') continue
      const meta = entry.compactMetadata as Json | undefined
      if (f === path && meta && typeof meta === 'object' && meta.trigger === 'auto')
        s.compacts.push([Math.max(0, Number(meta.preTokens ?? 0) - Number(meta.postTokens ?? 0)), s.calls])
      const msg = entry.message as Json | undefined
      if (!msg || typeof msg !== 'object') continue
      if (!s.cwd && typeof entry.cwd === 'string') s.cwd = entry.cwd
      const usage = msg.usage as Record<string, number> | undefined
      if (msg.role === 'assistant' && usage && typeof usage === 'object' && !seen.has(msg.id ?? null)) {
        seen.add(msg.id ?? null)
        s.calls += 1
        s.input += usage.input_tokens || 0
        s.cache_write += usage.cache_creation_input_tokens || 0
        s.cache_read += usage.cache_read_input_tokens || 0
        s.output += usage.output_tokens || 0
        const at = typeof entry.timestamp === 'string' ? new Date(entry.timestamp) : undefined
        if (at && !isNaN(at.getTime())) s.stamps.push(at) // local time of each call, for /wrapped
        // Main thread only: subagents run other models on purpose. The cache is per model.
        const name = msg.model
        if (f === path && typeof name === 'string' && name && !name.startsWith('<')) {
          if (model && name !== model) s.model_switches += 1
          model = name
        }
      }
      for (const block of Array.isArray(msg.content) ? msg.content as Json[] : []) {
        if (!block || typeof block !== 'object') continue
        const id = String(block.id ?? '')
        if (block.type === 'text' && msg.role === 'assistant') s.text += tokens(String(block.text ?? ''))
        else if (block.type === 'tool_use') {
          const name = String(block.name ?? '')
          const args = (block.input ?? {}) as Json
          toolNames.set(id, name)
          const target = basename(String(args.file_path ?? '')) || String(args.pattern ?? '')
          toolLabels.set(id, String(args.command || `${name} ${target}`.trim()).slice(0, 60))
          if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
            let code = String(args.content || args.new_string || args.new_source || '')
            code += (Array.isArray(args.edits) ? args.edits as Json[] : []).map(e => String(e?.new_string ?? '')).join('')
            s.code += tokens(code)
          }
          const cmd = String(args.command ?? '')
          if (name === 'Bash') commands.set(id, cmd)
          if (name.includes('graphify') || /\bgraphify\s+(query|path|explain)\b/.test(cmd)) s.graph_queries.push(id)
        } else if (block.type === 'tool_result') {
          const useId = String(block.tool_use_id ?? '')
          const text = resultText(block.content)
          results.set(useId, tokens(text))
          const cut = /claude-saver: trimmed ~([\d.]+)([kM]?) tokens/.exec(text)
          if (cut) s.trimmed.push(Number(cut[1]) * SIZE[cut[2] ?? '']!) // the mod cut a long shell output before Claude read it
          // The mod's blocks: a sized one ("skipped ~12.5k tokens"), or a generated folder priced at the average read.
          const hit = /claude-saver: skipped (?:[^~\n]*~([\d.]+)([kM]?) tokens|[\w.-]+\/, a generated folder)/.exec(text)
          if (hit) s.denied.push(hit[1] ? Number(hit[1]) * SIZE[hit[2] ?? '']! : null)
          else if (toolNames.get(useId) === 'Read' && /^Permission to read .+ has been denied/.test(text))
            s.denied.push(null) // your own deny rule: size unknown, priced at the average read
        }
      }
    }
    if (f === path) s.main_calls = s.calls
  }
  // Guard: a noisy command run again with less output, e.g. after the hint, saved the difference.
  const first = new Map<string, number>()
  for (const [i, n] of results) {
    const key = commands.has(i) ? cmdKey(commands.get(i)!) : ''
    if (first.has(key)) { s.guard_saved += Math.max(0, first.get(key)! - n); first.delete(key) }
    else if (key && n >= NOISY) first.set(key, n)
  }
  for (const name of toolNames.values()) bump(s.tools, name)
  s.reads = [...results].filter(([i]) => toolNames.get(i) === 'Read').map(([, n]) => n)
  s.graph_results = s.graph_queries.reduce((t, i) => t + (results.get(i) ?? 0), 0)
  s.noisy_count = [...results.values()].filter(n => n >= NOISY).length
  s.noisy = [...results].filter(([, n]) => n >= NOISY).map(([i, n]) => [n, toolLabels.get(i) ?? '?'] as [number, string])
    .sort((a, b) => b[0] - a[0] || (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).slice(0, 3)
  return s
}

const pct0 = (x: number) => `${Math.round(x * 100)}%`

/** Estimated savings as [name, tokens, kind, why]; shared by /savings and the status line. */
export function savedRows(s: Stats): [string, number, string, string][] {
  const rows: [string, number, string, string][] = []
  const perRead = s.reads.length ? Math.floor(s.reads.reduce((a, b) => a + b, 0) / s.reads.length) : DEFAULT_READ_TOKENS
  if (s.caveman && s.text)
    rows.push(['caveman', s.text * CAVEMAN_CUT / (1 - CAVEMAN_CUT), 'output',
      `${pct0(CAVEMAN_CUT)} avg cut on ${fmt(s.text)} reply tokens (caveman benchmark)`])
  if (s.ponytail && s.code)
    rows.push(['ponytail', s.code * PONYTAIL_CUT / (1 - PONYTAIL_CUT), 'output',
      `${pct0(PONYTAIL_CUT)} fewer lines on ${fmt(s.code)} code tokens (ponytail benchmark, low end)`])
  if (s.graph_queries.length) {
    const saved = Math.max(0, s.graph_queries.length * GRAPHIFY_READS_AVOIDED * perRead - s.graph_results)
    rows.push(['graphify', saved, 'input',
      `${s.graph_queries.length} queries × ${GRAPHIFY_READS_AVOIDED} reads of ~${fmt(perRead)} avoided (assumption)`])
  }
  if (s.denied.length)
    rows.push(['reads', s.denied.reduce<number>((t, n) => t + (n || perRead), 0), 'input',
      `${s.denied.length} reads blocked by the read guards or deny rules (folder blocks at ~${fmt(perRead)} each)`])
  if (s.guard_saved) rows.push(['guard', s.guard_saved, 'input', 'noisy commands run again with less output'])
  if (s.trimmed.length)
    rows.push(['trim', s.trimmed.reduce((a, b) => a + b, 0), 'input',
      `${s.trimmed.length} long shell outputs cut to head and tail before Claude read them`])
  // shortcut: credits every auto-compact, not only the head start CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 gives;
  // a second compact does not cut the first one's credit short.
  const compact = s.compacts.reduce((t, [d, at]) => t + d * (s.main_calls - at), 0) * CACHE_READ_PRICE
  if (compact)
    rows.push(['compact', compact, 'input', `${s.compacts.length} auto-compact(s): dropped tokens × later calls, at the 10% cache-read price`])
  return rows
}

export async function savings(io: Io, path: string | undefined, cwd: string) {
  if (!path || !(await isFile(io, path))) return 'No session transcript found.'
  const s = await sessionStats(io, path)
  const out = [
    `Session ${basename(path).slice(0, 8)}: ${s.calls} API calls`,
    `  used     input ${fmt(s.input)} · cache write ${fmt(s.cache_write)} · cache read ${fmt(s.cache_read)} · output ${fmt(s.output)}`,
    '',
    'Saved **estimated',
  ]
  const rows = savedRows(s)
  if (!rows.length) out.push('  nothing yet: no caveman, ponytail or graphify use, blocked reads, quieter reruns or auto-compacts')
  for (const [name, n, kind, why] of rows) out.push(`  ${name.padEnd(9)} ${('~' + fmt(n)).padStart(7)} ${kind.padEnd(6)}  ${why}`)
  if (rows.length) out.push(`  ${'total'.padEnd(9)} ${('~' + fmt(rows.reduce((t, r) => t + r[1], 0))).padStart(7)}`)
  out.push('', `  prompt cache  ${fmt(s.cache_read)} input tokens billed at 10% (exact, built into Claude Code)`)
  if (s.noisy.length) {
    out.push('', 'Biggest tool outputs (re-read on every later call; use quiet flags or a subagent):')
    for (const [n, label] of s.noisy) out.push(`  ${fmt(n).padStart(6)}  ${label}`)
  }
  if (s.model_switches)
    out.push('', `Model switched ${s.model_switches}x: each switch re-writes the conversation to a new cache. Pick /model and /effort at the start.`)
  const memory = (await alwaysLoaded(io, cwd)).reduce((n, [, t]) => n + tokens(visible(t)), 0)
  if (memory)
    out.push('', `Overhead: CLAUDE.md + memory ~${fmt(memory)} tokens × ${s.calls} calls = ~${fmt(memory * s.calls)}. Run /token-audit to trim it.`)
  return out.join('\n')
}

export type Ledger = { total?: number; born?: number; days?: Record<string, number> }

/** The status line's record of tokens saved: {total, born, days: {"YYYY-MM-DD": n}}. */
export const ledger = async (io: Io) => (await loadJson(io, await ctxFile(io, 'ledger.json'))) as Ledger

export const lifetime = (data: Ledger) => (typeof data.total === 'number' ? data.total : 0)

export async function week(io: Io, today: Date) {
  const days = (await ledger(io)).days ?? {}
  const rows = [6, 5, 4, 3, 2, 1, 0].map(i => addDays(today, -i)).map(d => [d, days[isoDay(d)] || 0] as const)
  const top = Math.max(...rows.map(([, n]) => n))
  if (!top) return 'Nothing recorded in the last 7 days. The status line records savings while it runs.'
  const out = ['Saved per day **estimated, recorded by the status line']
  for (const [d, n] of rows)
    out.push(`  ${DAYS[d.getDay()]!.slice(0, 3)} ${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}  ${'█'.repeat(Math.round(n / top * 20)).padEnd(20)}  ${n ? '~' + fmt(n) : '-'}`)
  out.push(`  ${'total'.padEnd(9)}  ${''.padEnd(20)}  ~${fmt(rows.reduce((t, [, n]) => t + n, 0))}`)
  return out.join('\n')
}

export const stageOf = (total: number) => PET_STAGES.find(s => total >= s[0])

/** Clawd's three rows for a PET_STAGES entry; the egg for none. wear replaces the stage's sparkle. */
export function petRows(stage: Stage | undefined, eyes = '▛▜', wear?: string, armsUp = false, cracked = false): readonly string[] {
  if (!stage) return PET_EGG[cracked ? 1 : 0]
  return [PET_HEAD(eyes) + (wear ?? stage[1]), PET_BODY[armsUp ? 1 : 0], PET_LEGS]
}

export async function pet(io: Io, now: number) {
  const data = await ledger(io)
  const total = lifetime(data)
  const age = typeof data.born === 'number' ? `, ${Math.floor((now / 1000 - data.born) / 86400)} days old` : ''
  const ahead = PET_STAGES.filter(s => total < s[0]).map(s => s[0])
  const next = ahead.at(-1)
  const nxt = next ? `next stage at ${fmt(next)} (${pct0(total / next)})` : 'fully grown'
  const texts = [`~${fmt(total)} tokens saved, lifetime${age}`, nxt, '']
  return petRows(stageOf(total), undefined, undefined, false, total >= PET_CRACK)
    .map((row, i) => `${row.padEnd(PET_WIDTH)}${texts[i]}`.trimEnd()).join('\n')
}

const WRAPPED_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Claude Wrapped</title>
<style>
:root{color-scheme:dark;--bg:#14101f;--fg:#f4efe6;--dim:#a99fbd}
*{box-sizing:border-box;margin:0}
body{min-height:100vh;padding:48px 16px;color:var(--fg);font:16px/1.4 system-ui,sans-serif;
 background:radial-gradient(circle at 15% 0,#3b1f5c,transparent 55%),radial-gradient(circle at 90% 100%,#5c2a1f,transparent 50%),var(--bg)}
main{max-width:880px;margin:auto}
header p{color:var(--dim);letter-spacing:.2em;text-transform:uppercase;font-size:13px}
h1{font-size:clamp(44px,10vw,92px);line-height:.95;font-weight:800;margin:8px 0 32px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.card{border-radius:20px;padding:24px;background:var(--a);color:var(--bg);animation:pop .6s both}
.wide{grid-column:1/-1}
small{text-transform:uppercase;letter-spacing:.15em;font-size:12px;font-weight:700;opacity:.7}
.card b{display:block;font-size:clamp(28px,5vw,44px);line-height:1.05;margin:10px 0 6px;overflow-wrap:anywhere}
.card span{font-size:14px;opacity:.8;overflow-wrap:anywhere}
.chart{display:flex;align-items:end;gap:10px;height:140px;margin:16px 0 22px}
.chart div{flex:1;min-height:4px;border-radius:6px 6px 0 0;background:var(--bg);position:relative}
.chart i{position:absolute;bottom:-22px;left:0;right:0;text-align:center;font:600 12px system-ui}
pre{font:22px/1.05 ui-monospace,Consolas,monospace;color:#d97757;margin:12px 0}
@keyframes pop{from{opacity:0;transform:translateY(16px) scale(.97)}}
@media (prefers-reduced-motion:reduce){.card{animation:none}}
</style>
<main><header><p>$range</p><h1>Your week<br>with Claude</h1></header><div class="grid">$cards</div></main>
`
const WRAPPED_COLORS = ['#f7c948', '#7ee0b3', '#ff8fa3', '#8ab4ff', '#c9a7ff', '#ffb27a', '#b8f27c', '#f4efe6']

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
const comma = (n: number) => n.toLocaleString('en-US')
const monthDay = (d: Date) => `${MONTHS[d.getMonth()]} ${pad2(d.getDate())}`

/** The last 7 days across every project as a Wrapped-style HTML page; returns [summary, page path] or a reason. */
export async function wrapped(io: Io, today: Date): Promise<{ text: string; page?: string }> {
  const start = addDays(today, -6)
  const projectsDir = join(await claudeDir(io), 'projects')
  const stats: Stats[] = []
  for (const dir of (await io.list(projectsDir).catch(() => [])).filter(e => e.kind === 'dir'))
    for (const e of await io.list(join(projectsDir, dir.name)).catch(() => []))
      if (e.kind === 'file' && e.name.endsWith('.jsonl') && e.mtimeMs >= start.getTime()) {
        const s = await sessionStats(io, join(projectsDir, dir.name, e.name))
        s.stamps = s.stamps.filter(t => isoDay(t) >= isoDay(start) && isoDay(t) <= isoDay(today))
        if (s.stamps.length) stats.push(s)
      }
  if (!stats.length) return { text: 'No Claude Code activity in the last 7 days.' }
  const stamps = stats.flatMap(s => s.stamps)
  const projects = new Map<string, number>()
  for (const s of stats) bump(projects, basename((s.cwd ?? '?').replace(/[/\\]+$/, '')) || (s.cwd ?? '?'), s.stamps.length)
  const byDay = new Map<string, number>()
  const hours = new Map<number, number>()
  for (const t of stamps) { bump(byDay, isoDay(t)); bump(hours, t.getHours()) }
  const toolTotals = new Map<string, number>()
  for (const s of stats) for (const [k, n] of s.tools) bump(toolTotals, k, n)
  const tools = mostCommon(toolTotals, 3)
  const [busiestKey, busiestN] = mostCommon(byDay, 1)[0]!
  const busiest = new Date(`${busiestKey}T12:00:00`)
  const peak = mostCommon(hours, 1)[0]![0]
  const loud = stats.flatMap(s => s.noisy).sort((a, b) => b[0] - a[0] || (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))[0]
  const data = await ledger(io)
  const saved = [0, 1, 2, 3, 4, 5, 6].reduce((t, i) => t + ((data.days ?? {})[isoDay(addDays(start, i))] || 0), 0)
  const total = lifetime(data)
  const [topProject, topN] = mostCommon(projects, 1)[0]!
  const sum = (k: 'output' | 'cache_read') => stats.reduce((t, s) => t + s[k], 0)

  // [kicker, big, sub]; shortcut: tokens are whole sessions, a session that began before the week counts in full
  const cards: [string, string, string][] = [
    ['You and Claude', comma(stamps.length), `API calls across ${stats.length} sessions`],
    ['Top project', topProject, `${comma(topN)} calls · ${projects.size} projects this week`],
    ['Busiest day', DAYS[busiest.getDay()]!, `${comma(busiestN)} calls on ${monthDay(busiest)}`],
    ['Your type', peak >= 22 || peak < 5 ? 'Night owl' : peak < 9 ? 'Early bird' : 'Daylight builder', `Most calls at ${pad2(peak)}:00`],
  ]
  if (tools[0]) cards.push(['Favourite tool', tools[0][0], `${comma(tools[0][1])} uses` + tools.slice(1).map(([t]) => ` · then ${t}`).join('')])
  cards.push(['Claude wrote', `${fmt(sum('output'))} tokens`, `and re-read ${fmt(sum('cache_read'))} from cache at a tenth of the price`])
  if (saved) cards.push(['Saved', `~${fmt(saved)}`, 'tokens, estimated: modes, graphify, guards and auto-compact'])
  if (loud) cards.push(['Loudest command', `${fmt(loud[0])} tokens`, loud[1]])

  const html = cards.map(([k, big, sub], i) =>
    `<div class="card" style="--a:${WRAPPED_COLORS[i % WRAPPED_COLORS.length]};animation-delay:${(i * 0.08).toFixed(2)}s">` +
    `<small>${escape(k)}</small><b>${escape(big)}</b><span>${escape(sub)}</span></div>`)
  const top = Math.max(...byDay.values())
  const bars = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(start, i)).map(d => {
    const n = byDay.get(isoDay(d)) ?? 0
    return `<div style="height:${(n / top * 100).toFixed(0)}%" title="${n} calls"><i>${DAYS[d.getDay()]!.slice(0, 3)}</i></div>`
  }).join('')
  html.push(`<div class="card wide" style="--a:#e8ddff"><small>Calls per day</small><div class="chart">${bars}</div></div>`)
  const art = escape(petRows(stageOf(total), undefined, undefined, false, total >= PET_CRACK).join('\n'))
  html.push('<div class="card wide" style="--a:#1f1830;color:var(--fg)"><small>Your pet</small>' +
    `<pre>${art}</pre><span>~${fmt(total)} tokens saved, lifetime</span></div>`)

  const page = await ctxFile(io, 'wrapped.html')
  const range = `${monthDay(start)} – ${monthDay(today)}, ${today.getFullYear()}`
  await io.write(page, WRAPPED_PAGE.replace('$range', range).replace('$cards', () => html.join('\n')))
  return { text: `${comma(stamps.length)} calls, top project ${topProject}, busiest ${DAYS[busiest.getDay()]}. Wrapped: ${page}`, page }
}

// ---------- toggle ----------

/** config.json wins; else the pet follows an older install's --pet and the guards are on. */
export async function isOn(io: Io, name: string) {
  const value = (await loadJson(io, await ctxFile(io, 'config.json')))[name]
  if (typeof value === 'boolean') return value
  if (name === 'pet') return ((await legacyStatusLine(io)) ?? '').endsWith(' --pet')
  return true
}

/** toggle [NAME [on|off]]: flip or set a switch, then list them all. No restart needed. */
export async function toggle(io: Io, args: string[]) {
  if (args.length) {
    const name = args[0]!.toLowerCase()
    const value = args[1]?.toLowerCase()
    if (!(name in SWITCHES) || (value !== undefined && value !== 'on' && value !== 'off'))
      return `Usage: /toggle [${Object.keys(SWITCHES).join('|')} [on|off]]`
    const path = await ctxFile(io, 'config.json')
    const cfg = await loadJson(io, path)
    cfg[name] = value === undefined ? !(await isOn(io, name)) : value === 'on'
    await io.write(path, JSON.stringify(cfg))
  }
  const out = ['Switches (take effect now, no restart):']
  for (const [name, what] of Object.entries(SWITCHES)) out.push(`  ${name.padEnd(8)} ${(await isOn(io, name)) ? 'on ' : 'off'}  ${what}`)
  out.push('caveman / ponytail: `stop caveman`, `stop ponytail` for this session; /plugin to disable them for every session.')
  return out.join('\n')
}

/** Opens a file in the default app; false when no opener ran. */
export async function openFile(io: Io, path: string) {
  const ok = (argv: string[]) => io.run(argv).then(r => r.exitCode === 0, () => false)
  if (await isWindows(io)) return ok(['cmd', '/c', 'start', '', path.replace(/\//g, '\\')])
  const mac = await io.run(['uname']).then(r => r.stdout.trim() === 'Darwin', () => false)
  return ok([mac ? 'open' : 'xdg-open', path])
}

export const isWindows = async (io: Io) => (await io.env('OS')) === 'Windows_NT'
