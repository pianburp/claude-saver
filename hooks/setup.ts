// /saver-setup, ported from install.py: auto-compact, the .env deny rules and the optional extras in settings.json,
// and the clean-up of what older versions installed (the Python status line, saver.py, settings hooks and skills).
import type { Io } from './io'

import { claudeDir, ctxFile, home, isWindows, join, loadJson, read, stat } from './saver'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export const FLAGS = ['--with-plugins', '--graphify', '--orchestrate', '--pet', '--all', '--yes', '--dry-run', '--uninstall']
export const USAGE = `Usage: /saver-setup [${FLAGS.join('] [')}]
  --with-plugins  also install the ponytail + caveman plugins (via the claude CLI)
  --graphify      also install graphify (PyPI: graphifyy) and its skill
  --orchestrate   plan on Opus, execute on Sonnet (model: opusplan), subagents on Haiku
  --all           plugins + graphify (not --orchestrate: that changes your model)
  --pet           a pet on the status line, fed by tokens saved
  --yes           apply the changes; without it they are only listed
  --uninstall     remove what setup added; your own settings stay`

export const MARKETPLACES: Record<string, string> = { ponytail: 'DietrichGebert/ponytail', caveman: 'JuliusBrussee/caveman' }

// Secrets stay out of the API even where the mod is not loaded. Named files, not .env.*, so .env.example stays readable.
export const DENY_READS = ['Read(**/.env)', 'Read(**/.env.local)', 'Read(**/.env.*.local)']

// What older versions installed and the mod now does: removed on install and uninstall.
const OLD_DENY_READS = ['node_modules', '__pycache__', '.venv', 'venv', '.next', 'coverage'].map(d => `Read(**/${d}/**)`)
const OLD_HOOKS: Record<string, string> = { SessionStart: 'check', PostToolUse: 'guard', PreToolUse: 'secrets' } // event: saver.py subcommand
const OLD_SKILLS = ['token-audit', 'savings', 'pet', 'handoff', 'toggle', 'wrapped']
const OLD_FILES = ['statusline.py', 'saver.py']

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const withPlugins = (args: string[]) => args.includes('--with-plugins') || args.includes('--all')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The status line command an older version wrote, if settings still has it. */
const legacyCommand = (settings: Json): string | undefined => {
  const cmd = settings.statusLine?.command
  return typeof cmd === 'string' && cmd.includes('statusline.py') ? cmd : undefined
}

/** Remove the deny rules, saver.py hooks and Python status line older versions added; the mod does their job now. */
export function dropOld(settings: Json) {
  if (legacyCommand(settings)) delete settings.statusLine
  const deny = settings.permissions?.deny
  if (Array.isArray(deny)) settings.permissions.deny = deny.filter(r => !OLD_DENY_READS.includes(r))
  const hooks: Json = settings.hooks ?? {}
  for (const [event, sub] of Object.entries(OLD_HOOKS)) {
    if (!Array.isArray(hooks[event])) continue
    for (const group of hooks[event])
      group.hooks = (group.hooks ?? []).filter((h: Json) => !(String(h.command ?? '').includes('saver.py') && String(h.command ?? '').endsWith(' ' + sub)))
    hooks[event] = hooks[event].filter((g: Json) => g.hooks.length)
    if (!hooks[event].length) delete hooks[event]
  }
  if ('hooks' in settings && !Object.keys(hooks).length) delete settings.hooks
}

/** Merge claude-saver's keys into settings.json; keep the user's own values. */
export function applySettings(settings: Json, args: string[]) {
  const env: Json = (settings.env ??= {})
  // Undocumented but read by Claude Code: auto-compact at 50% of the window instead of near full.
  env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ??= '50'
  if (args.includes('--orchestrate')) {
    settings.model = 'opusplan'
    env.CLAUDE_CODE_SUBAGENT_MODEL ??= 'haiku'
  }
  const deny: string[] = ((settings.permissions ??= {}).deny ??= [])
  deny.push(...DENY_READS.filter(r => !deny.includes(r)))
  dropOld(settings)
  if (withPlugins(args)) {
    const markets: Json = (settings.extraKnownMarketplaces ??= {})
    const plugins: Json = (settings.enabledPlugins ??= {})
    for (const [name, repo] of Object.entries(MARKETPLACES)) {
      markets[name] ??= { source: { source: 'github', repo } }
      plugins[`${name}@${name}`] ??= true
    }
  }
  return settings
}

/** Undo applySettings, dropping only values that match what it writes. */
export function removeSettings(settings: Json) {
  const env: Json = settings.env ?? {}
  for (const [key, value] of [['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', '50'], ['CLAUDE_CODE_SUBAGENT_MODEL', 'haiku']] as const)
    if (env[key] === value) delete env[key]
  if (settings.model === 'opusplan') delete settings.model
  const deny = settings.permissions?.deny
  if (Array.isArray(deny)) settings.permissions.deny = deny.filter(r => !DENY_READS.includes(r))
  dropOld(settings)
  return settings
}

/** One line per added (+), removed (-) or changed (~) setting, nested keys dotted. */
export function changes(before: Json, after: Json, path = ''): string[] {
  const out: string[] = []
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const [a, b] = [before[key], after[key]]
    const p = path ? `${path}.${key}` : key
    if (same(a, b)) continue
    if ((isObj(a) || isObj(b)) && (a === undefined || isObj(a)) && (b === undefined || isObj(b))) {
      out.push(...changes(a ?? {}, b ?? {}, p))
      continue
    }
    if ((Array.isArray(a) || Array.isArray(b)) && (a === undefined || Array.isArray(a)) && (b === undefined || Array.isArray(b))) {
      out.push(...(b ?? []).filter((x: unknown) => !(a ?? []).some((y: unknown) => same(x, y))).map((x: unknown) => `+ ${p}: ${JSON.stringify(x)}`))
      out.push(...(a ?? []).filter((x: unknown) => !(b ?? []).some((y: unknown) => same(x, y))).map((x: unknown) => `- ${p}: ${JSON.stringify(x)}`))
      continue
    }
    const sign = a === undefined ? '+' : b === undefined ? '-' : '~'
    out.push(`${sign} ${p}: ${JSON.stringify(b === undefined ? a : b)}`)
  }
  return out
}

/** Standalone caveman/ponytail setups: they duplicate the plugins and write no flag the status line reads. */
export function conflicts(settings: Json, skillNames: string[], skillsDir: string) {
  const found: string[] = []
  const names = skillNames.filter(n => /^(cave|ponytail|ultracave|megacave)/.test(n)).sort()
  if (names.length) found.push(`standalone skills in ${skillsDir}: ${names.join(', ')}. Delete them; the plugins ship their own`)
  for (const group of settings.hooks?.SessionStart ?? [])
    for (const h of group.hooks ?? []) {
      const cmd = String(h.command ?? '')
      if (cmd.includes('caveman') || cmd.includes('ponytail')) found.push(`custom SessionStart hook: ${cmd}. Remove it, or the mode loads twice`)
    }
  return found
}

const run = (io: Io, argv: string[]) =>
  io.run(argv).then(r => r.exitCode, () => -1)

/** Deletes a file or folder; there is no fs.remove, so it goes through the shell. */
async function remove(io: Io, path: string) {
  const st = await stat(io, path)
  if (!st) return false
  const win = path.replace(/\//g, '\\')
  const argv = (await isWindows(io)) ? (st.kind === 'dir' ? ['cmd', '/c', 'rmdir', '/s', '/q', win] : ['cmd', '/c', 'del', '/f', '/q', win])
    : ['rm', '-rf', path]
  return (await run(io, argv)) === 0
}

/** Delete the skills older versions wrote; the mod answers these commands now. A skill of your own stays. */
async function removeOldSkills(io: Io, out: string[]) {
  for (const name of OLD_SKILLS) {
    const folder = join(await claudeDir(io), 'skills', name)
    if (((await read(io, join(folder, 'SKILL.md'))) ?? '').includes('saver.py') && (await remove(io, folder)))
      out.push(`Removed the old /${name} skill (the mod runs it now)`)
  }
}

async function removeOldFiles(io: Io, out: string[]) {
  const dir = await claudeDir(io)
  for (const name of OLD_FILES)
    if (await stat(io, join(dir, name)))
      out.push((await remove(io, join(dir, name))) ? `Removed ${name}` : `Could not remove ${join(dir, name)}; it is no longer used, delete it by hand`)
  if (await stat(io, join(dir, 'statusline.py.bak')))
    out.push('Your status line from before claude-saver is in statusline.py.bak. Point statusLine at it to use it again.')
}

/** True when the claude CLI installed every plugin; else the user finishes in /plugin. */
async function installPlugins(io: Io) {
  let ok = true
  for (const [name, repo] of Object.entries(MARKETPLACES)) {
    await run(io, ['claude', 'plugin', 'marketplace', 'add', repo]) // fails harmlessly when the marketplace is already known
    if ((await run(io, ['claude', 'plugin', 'install', `${name}@${name}`])) !== 0) ok = false
  }
  return ok
}

async function installGraphify(io: Io, out: string[]) {
  const uv = (await run(io, ['uv', '--version'])) === 0
  const py = (await isWindows(io)) ? ['py', '-3'] : ['python3']
  const cmd = uv ? ['uv', 'tool', 'install', '--upgrade', 'graphifyy'] : [...py, '-m', 'pip', 'install', '--user', '--upgrade', 'graphifyy']
  if ((await run(io, cmd)) !== 0) return out.push(`graphify install failed. Run it yourself: ${cmd.join(' ')}`)
  // A fresh install may not be on PATH yet: uv and pip --user put it in ~/.local/bin.
  for (const exe of ['graphify', `${await home(io)}/.local/bin/graphify`])
    if ((await run(io, [exe, 'install'])) === 0) return out.push('Installed graphify')
  out.push('Installed graphifyy, but `graphify install` failed. Open a new terminal and run: graphify install')
}

/** /saver-setup: lists the settings.json changes, applies them with --yes. */
export async function setup(io: Io, args: string[]) {
  const unknown = args.filter(a => !FLAGS.includes(a))
  if (unknown.length) return `Unknown option: ${unknown.join(' ')}\n${USAGE}`
  const dir = await claudeDir(io)
  const path = join(dir, 'settings.json')
  const text = await read(io, path)
  let settings: Json = {}
  try {
    if (text?.trim()) settings = JSON.parse(text)
  } catch (e) {
    return `Could not read ${path}: ${(e as Error).message}\nFix the JSON, then run /saver-setup again.`
  }
  const uninstall = args.includes('--uninstall')
  const legacyPet = legacyCommand(settings)?.endsWith(' --pet') ?? false
  const before = JSON.parse(JSON.stringify(settings))
  if (uninstall) removeSettings(settings)
  else applySettings(settings, args)
  const diff = changes(before, settings)
  const out = diff.length ? [`Changes to ${path}:`, ...diff.map(l => '  ' + l)] : [`No changes to ${path}.`]
  if (!args.includes('--yes') || args.includes('--dry-run')) {
    out.push('', uninstall ? 'Also removes ~/.claude/.statusline-ctx (pet and ledger included) and the old Python files.'
      : 'Also removes the Python status line and saver.py an older version installed, if present.')
    out.push(`Run ${['/saver-setup', '--yes', ...args.filter(a => a !== '--dry-run' && a !== '--yes')].join(' ')} to apply.`)
    return out.join('\n')
  }

  if (diff.length) {
    if (text !== null && !(await stat(io, path + '.bak'))) {
      await io.write(path + '.bak', text)
      out.push(`Backed up settings to ${path}.bak`)
    }
    await io.write(path, JSON.stringify(settings, null, 2) + '\n')
    out.push(`Updated ${path}`)
  }
  await removeOldFiles(io, out)
  await removeOldSkills(io, out)
  if (uninstall) {
    if (await remove(io, join(dir, '.statusline-ctx'))) out.push('Removed .statusline-ctx (pet, ledger and switches)')
    out.push('To remove the mod itself: /plugin uninstall ctx-saver. Plugins stay; to remove them: ' +
      '/plugin uninstall ponytail@ponytail and caveman@caveman, graphify uninstall.')
    return out.join('\n')
  }

  // The pet now follows /toggle pet; carry over an older install's --pet.
  const cfgPath = await ctxFile(io, 'config.json')
  const cfg = await loadJson(io, cfgPath)
  if ((args.includes('--pet') || legacyPet) && typeof cfg.pet !== 'boolean') {
    await io.write(cfgPath, JSON.stringify({ ...cfg, pet: true }))
    out.push('Pet on (/toggle pet to hide it)')
  }
  if (args.includes('--graphify') || args.includes('--all')) await installGraphify(io, out)
  if (withPlugins(args)) {
    if (await installPlugins(io)) out.push('Installed ponytail and caveman plugins')
    else {
      out.push('Could not install the plugins with the claude CLI. In Claude Code, run:')
      for (const [name, repo] of Object.entries(MARKETPLACES)) out.push(`  /plugin marketplace add ${repo}`, `  /plugin install ${name}@${name}`)
    }
    const skillsDir = join(dir, 'skills')
    const names = (await io.list(skillsDir).catch(() => [])).map(e => e.name)
    for (const c of conflicts(settings, names, skillsDir)) out.push('Warning: ' + c)
  }
  out.push('Restart Claude Code for the settings to apply.' + (args.includes('--all') ? '' : ' Run with --all to add ponytail, caveman and graphify.'))
  return out.join('\n')
}
