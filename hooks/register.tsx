// claude-saver's mod: every guard, the status line, the startup check and every command. The guards run in-process
// and can rewrite a tool's result, which a settings hook cannot. saver.ts holds the commands' logic, status.ts the
// status line's, setup.ts /saver-setup's. Focus mode (/toggle focus) hides tool rows and draws a step band.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run, Step, StepStatus } from '../types'
import { FOCUS_PROMPT, STEPS_SPEC, STEPS_TOOL, activity, isAnswer, parseSteps, stamp, stepFraction, stepLabel } from './focus'
import {
  HEAVY, NOISY, audit, check, claudeDir, cmdKey, fmt, handoffPath, isOn, loadJson, newestTranscript, normcase, openFile,
  pet, projectSlug, savings, toggle, week, wrapped,
} from './saver'
import { setup, USAGE } from './setup'
import { BAR_WIDTH, CLAUDE, DARK, GRAY, GREEN, SPINNER, YELLOW, frame as statusFrame } from './status'
import type { Session } from './status'
import type { Io } from './io'

type Input = Record<string, unknown>

const KEEP_HEAD = 2000 // chars kept from the start of a trimmed output
const KEEP_TAIL = 4000 // chars kept from the end: errors and summaries land there
const KEEP_ERRORS = 3000 // chars of error lines kept from the cut middle
const ERROR_LINE = /error|fail|exception|traceback|panic|fatal|assert|[✗✘]/i // TypeError, FAILED, AssertionError
const OUT_SLOTS = 50 // full outputs kept on disk, oldest overwritten
const BIG_READ = 40_000 // bytes (~10k tokens)
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'cargo.lock',
  'composer.lock', 'gemfile.lock', 'uv.lock', 'bun.lock'])
const MINIFIED = ['.min.js', '.min.css', '.map']
const MEDIA = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.pdf', '.ipynb']
// Shell commands that read or list files; rm, npm and the like are left alone.
const SHELL_READ = /^(?:cat|head|tail|less|more|grep|egrep|rg|ag|find|ls|tree|du|wc|awk|sed|type|dir|gc|gci|sls|get-content|get-childitem|select-string)$/i
// The word after these names a folder to skip, not one to read: find -path, grep --exclude-dir, rg -g, tree -I.
const EXCLUDE_FLAG = /^-(?:path|ipath|wholename|name|iname|not|prune|g|-glob|-exclude|-exclude-dir|-ignore|-ignore-dir|i|exclude|e|pattern)$/i
// Their first plain word is a pattern or script, not a path.
const SHELL_SCRIPT = /^(?:grep|egrep|rg|ag|awk|sed|sls|select-string)$/i
// Whole-file dumpers: a huge log through one of these is blocked like a whole Read.
const SHELL_DUMP = /^(?:cat|type|more|less|gc|get-content)$/i
// .env, .env.local, .env.production.local at a path/word boundary; not .environment.
const ENV_FILE = /(?:^|[\s'"`=:/\\(,|])(\.env(?:\.[\w-]+)*)(?![\w-])/g
const PLACEHOLDER = /\.(example|sample|template|dist)$/i
// ponytail: well-known prefixes only, no entropy scan. Add a pattern when a new key type leaks.
const SECRETS: [string, RegExp][] = [
  ['Anthropic or OpenAI key', /\bsk-(?:ant-|proj-)?[\w-]{20,}/],
  ['Stripe live key', /\b[rs]k_live_[0-9A-Za-z]{20,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[0-9A-Za-z]{36}|github_pat_\w{22,})/],
  ['Google API key', /\bAIza[\w-]{35}/],
  ['Slack token', /\bxox[abprs]-[0-9A-Za-z-]{10,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit']
// Answered at once, no model turn. They run even while Claude works.
const COMMANDS: [string, string, string?][] = [
  ['savings', "This session's tokens and what each saver saved. --week: per day", '[--week]'],
  ['pet', 'The status line pet: stage, age, lifetime tokens saved'],
  ['toggle', 'Turn the pet, check, guard, secrets, reads or focus on or off. No args: list them', '[name [on|off]]'],
  ['wrapped', 'Your Claude Code week as a Wrapped page'],
  ['saver-setup', 'Set auto-compact and the .env deny rules in settings.json, and clean up older installs',
    '[--all] [--with-plugins] [--graphify] [--orchestrate] [--pet] [--yes] [--uninstall]'],
]
// The mod writes the input, then Claude does the work in a turn of its own: [description, prompt].
const MODEL_COMMANDS: Record<string, [string, (out: string) => string]> = {
  'token-audit': ['Audit what Claude Code loads every session (CLAUDE.md, memory, rules, MCP) and prune it', out =>
    `claude-saver's /token-audit report:\n\n${out}\n\n` +
    'Propose concrete cuts for each flagged file: duplicate lines, stale paths, long prose, code blocks that belong ' +
    'in a skill or doc, notes for humans that can become <!-- --> comments. Show each change as a diff and apply ' +
    'nothing until I say yes. Before editing a file, copy it to <file>.bak. If the caveman plugin is installed, ' +
    'offer /caveman:caveman-compress for files still over 500 tokens.'],
  handoff: ['Save a task note before /clear; the next session in this project starts with it', out =>
    `Write a note for the next session to ${out.trim()} with the Write tool, 15 lines max, no preamble: goal, what is ` +
    'done, the next step, key files, gotchas and decisions already made. Then tell me to run /clear. ' +
    'The next session in this project starts with the note, once.'],
}

const base = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? ''

/** Deny reason for touching .env files or writes that hardcode a credential. */
export function secrets(tool: string, ti: Input): string | undefined {
  if (WRITE_TOOLS.includes(tool)) {
    if (base(String(ti.file_path ?? '')).startsWith('.env')) return // a key in .env is where it belongs
    const edits = Array.isArray(ti.edits) ? ti.edits.map(e => (e as Input)?.new_string) : []
    const text = [ti.content, ti.new_string, ...edits].filter(Boolean).map(String).join('\n')
    const kind = SECRETS.find(([, p]) => p.test(text))?.[0]
    return kind && `Blocked: this write hardcodes a ${kind}. Anyone with the repo or its history can use it. ` +
      'Read it from an environment variable and keep the value in .env (gitignored).'
  }
  const hay = ['file_path', 'path', 'pattern', 'command', 'glob'].map(k => ti[k]).filter(v => typeof v === 'string').join('\n')
  const hit = [...hay.matchAll(ENV_FILE)].map(m => m[1] ?? '').find(f => !PLACEHOLDER.test(f))
  return hit && `Blocked: "${hit}" holds live secrets. Printing one into the transcript cannot be undone: ` +
    'the user has to rotate the credential. Read the code default, .env.example or README.md instead. ' +
    'To check a variable is set, print a boolean, never the value. Do not trust a redaction pattern.'
}

const unquote = (w: string) => w.replace(/^['"]+|['"]+$/g, '')
const heavyIn = (p: string) => HEAVY.find(d => p.replace(/\\/g, '/').split('/').includes(d))

/** Each `cmd | cmd && cmd` part of a shell command as words. */
export function shellParts(cmd: string): string[][] {
  return cmd.split(/&&|\|\||[|;&\n]/).map(s => s.trim().split(/\s+/).filter(Boolean)).filter(w => w.length)
}

/** Deny reason for a Read, Grep, Glob or shell read inside a generated folder. Other commands pass (rm -rf node_modules). */
export function heavy(tool: string, ti: Input): string | undefined {
  let dir: string | undefined
  if (tool === 'Bash' || tool === 'PowerShell') {
    // shortcut: a positive `find . -path '*/node_modules/*'` passes as an exclusion; add a check if the model uses it
    for (const [verb = '', ...args] of shellParts(String(ti.command ?? ''))) {
      if (!SHELL_READ.test(verb)) continue
      const paths = args.filter((w, i) => !/^['"]?[-!]/.test(w) && !EXCLUDE_FLAG.test(args[i - 1] ?? ''))
      if (SHELL_SCRIPT.test(verb)) paths.shift() // grep's pattern or awk's script, not a path
      dir = paths.map(w => heavyIn(unquote(w))).find(Boolean)
      if (dir) break
    }
  } else if (['Read', 'Grep', 'Glob'].includes(tool)) {
    const paths = ['file_path', 'path', 'pattern', 'glob'].map(k => ti[k]).filter(v => typeof v === 'string') as string[]
    dir = HEAVY.find(d => paths.some(p => heavyIn(p) === d))
  }
  return dir && `claude-saver: skipped ${dir}/, a generated folder. Read the source or the package's docs instead.`
}

/** Whether a call may change something: an edit, or a shell command that is more than reads (focus mode's step gate). */
export function changes(tool: string, ti: Input) {
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return true
  if (!/^(Bash|PowerShell)$/.test(tool)) return false
  // shortcut: judged by each part's first word, so `cat > x` passes as a read; fine for a nudge, not for a guard
  return shellParts(String(ti.command ?? '')).some(([w = '']) => !SHELL_READ.test(w) && !/^(cd|pwd|set-location)$/i.test(w))
}

/** Files a shell command dumps whole (`cat big.log`, `Get-Content x.log`); none when it pipes or limits lines. */
export function shellDumps(cmd: string): string[] {
  if (cmd.includes('|')) return [] // filtered through grep, tail and the like
  return shellParts(cmd).flatMap(([verb, ...args]) =>
    // `cat a > b` writes a file, nothing reaches Claude
    SHELL_DUMP.test(verb ?? '') && !args.some(a => /^-(?:tail|totalcount|head|first|last)$/i.test(a) || /^1?>/.test(a))
      ? args.filter(a => !a.startsWith('-') && !/[<>]/.test(a)).map(unquote) : [])
}

/** Deny reason for a whole Read of a lockfile, minified file or file over BIG_READ. */
export function bigRead(path: string, size: number, ti: Input): string | undefined {
  if (ti.offset || ti.limit) return
  const name = base(path).toLowerCase()
  if (LOCKFILES.has(name) || MINIFIED.some(s => name.endsWith(s)) || (size > BIG_READ && !MEDIA.some(s => name.endsWith(s))))
    return `claude-saver: skipped ~${fmt(size / 4)} tokens, a whole read of ${base(path)}. ` +
      'Grep it for what you need, or Read it with offset and limit.'
}

/** Head, error lines from the middle, and tail of a long output with a note, or undefined when it is short enough. */
export function trim(text: string, where: string): { text: string; cut: number } | undefined {
  if (text.length / 4 < NOISY) return
  const head = text.slice(0, text.lastIndexOf('\n', KEEP_HEAD) + 1 || KEEP_HEAD)
  const tailFrom = text.length - KEEP_TAIL
  const tail = text.slice(text.indexOf('\n', tailFrom) + 1 || tailFrom)
  let errors = ''
  for (const line of text.slice(head.length, text.length - tail.length).split('\n')) {
    const kept = line.slice(0, 300) + '\n'
    if (ERROR_LINE.test(line) && errors.length + kept.length <= KEEP_ERRORS) errors += kept
  }
  const cut = Math.floor((text.length - head.length - tail.length - errors.length) / 4)
  return {
    cut,
    text: `${head}\n[claude-saver: trimmed ~${fmt(cut)} tokens from the middle. Full output: ${where} ` +
      '(Grep it, or Read it with offset and limit). Next time use quiet flags or pipe through tail or grep.]\n' +
      (errors && `[claude-saver: error lines from the trimmed part]\n${errors}`) + '\n' + tail,
  }
}

/** The engine calls saver.ts, status.ts and setup.ts make, from this hook's $: $ never crosses an import. */
function io($: EngineInterface): Io {
  return {
    read: path => $.fs.read(path) as Promise<string>,
    write: (path, text) => $.fs.write(path, text),
    list: path => $.fs.list(path),
    stat: path => $.fs.stat(path),
    env: name => {
      switch (name) {
        case 'CLAUDE_CONFIG_DIR': return $.env.get('CLAUDE_CONFIG_DIR')
        case 'HOME': return $.env.get('HOME')
        case 'USERPROFILE': return $.env.get('USERPROFILE')
        case 'OS': return $.env.get('OS')
        case 'CLAUDE_CACHE_TTL': return $.env.get('CLAUDE_CACHE_TTL')
        case 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE': return $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')
        case 'ENABLE_TOOL_SEARCH': return $.env.get('ENABLE_TOOL_SEARCH')
        case 'CLAUDE_CODE_SUBAGENT_MODEL': return $.env.get('CLAUDE_CODE_SUBAGENT_MODEL')
        case 'BASH_MAX_OUTPUT_LENGTH': return $.env.get('BASH_MAX_OUTPUT_LENGTH')
        case 'ENABLE_PROMPT_CACHING_1H': return $.env.get('ENABLE_PROMPT_CACHING_1H')
      }
    },
    now: () => $.clock.now(),
    run: argv => $.process.run(argv),
    usage: () => $.session.usage(),
    model: () => $.session.model(),
    cwd: () => $.session.cwd(),
  }
}

// Focus mode's state: the switch, the task the band shows, the clock it reads, and the turns' final answers.
const focus = atom({ plugin: 'ctx-saver', key: 'focus' } as const, true)
const run = atom({ plugin: 'ctx-saver', key: 'run' } as const, null)
const now = atom({ plugin: 'ctx-saver', key: 'now' } as const, 0)
const answers = atom({ plugin: 'ctx-saver', key: 'answers' } as const, [])
// The status line's rows under the prompt; null while an older install's settings.json status line draws instead.
const status = atom({ plugin: 'ctx-saver', key: 'status' } as const, null)
const FRAME = 100 // ms between band frames while a turn runs
const STATUS_FRAME = 1000 // ms between status line frames, as the old refreshInterval
const KEEP_ANSWERS = 100

/** Reads the /toggle focus switch into the atom the rows and the band read; a write redraws them. */
async function refreshFocus($: EngineInterface) {
  const isFocus = await isOn(io($), 'focus')
  await update($, focus, () => isFocus)
}

/** One band frame: the clock moves. True once the turn ended, so frames can stop. */
async function frame($: EngineInterface) {
  const t = await $.clock.now()
  await update($, now, () => t)
  return (await read($, run))?.endedAt != null
}

type TextEl = ReturnType<EngineInterface['ui']['resolve']>['Text']

/** The status line's bar: BAR_WIDTH cells, `█` in Claude orange up to `frac` (0 to 1), `░` after. */
function bar(Text: TextEl, frac: number) {
  const filled = Math.ceil(Math.min(1, Math.max(0, frac)) * BAR_WIDTH)
  return <Text><Text color={CLAUDE}>{'█'.repeat(filled)}</Text><Text color={DARK}>{'░'.repeat(BAR_WIDTH - filled)}</Text></Text>
}

async function setSteps($: EngineInterface, fn: (steps: Step[]) => Step[]) {
  const t = await $.clock.now()
  return update($, run, r => ({ ...(r ?? { title: '', endedAt: null }),
    steps: stamp(r?.steps ?? [], fn(r?.steps ?? []), t) }) as Run)
}

// The status line's session (the transcript it reads and its glows; a new one on /clear) and the rows last drawn.
const live: { sess: Session; drawn: string } = { sess: {}, drawn: 'null' }

/** One status line frame; the atom is written only when a row changed, so an idle line costs no redraw. */
async function statusTickOnce($: EngineInterface) {
  const sess = live.sess
  if (!sess.id) {
    sess.id = await $.session.id()
    sess.transcript ??= `${await claudeDir(io($))}/projects/${projectSlug(await $.session.root())}/${sess.id}.jsonl`
  }
  const rows = (await statusFrame(io($), sess, await $.clock.now())) ?? null
  const json = JSON.stringify(rows)
  if (json !== live.drawn) {
    live.drawn = json
    await update($, status, () => rows)
  }
}

export const register: Register = on => {
  // Path and stamp of every file read this session: an unchanged re-read is answered once without reading.
  const seen = new Map<string, { stamp: string; answered: boolean }>()
  let statusTick: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    for (const [name, description, argumentHint] of COMMANDS)
      await $.command.register({ name, description, argumentHint, immediate: true })
    for (const [name, [description]] of Object.entries(MODEL_COMMANDS)) await $.command.register({ name, description })
    await refreshFocus($)
    // No task tool in this session (it has happened on recent versions): focus mode brings its own.
    try {
      const names = (await $.tool.list()).map(t => t.name)
      if (!names.includes('TaskCreate') && !names.includes('TodoWrite')) await $.tool.register(STEPS_SPEC)
    } catch { /* the gate refuses only once, so a missing step tool never stalls Claude */ }
    statusTick?.cancel()
    // A frame that fails draws nothing new; the next one tries again.
    statusTick = $.clock.every(STATUS_FRAME, () => void statusTickOnce($).catch(() => undefined))
    return next(e)
  })

  on('command.run', { command: [...COMMANDS.map(c => c[0]), ...Object.keys(MODEL_COMMANDS)] }, async ($, e) => {
    const args = e.args.split(/\s+/).filter(Boolean)
    const cwd = await $.session.cwd()
    const t = await $.clock.now()
    switch (e.command) {
      case 'savings':
        return { text: args[0] === '--week' ? await week(io($), new Date(t))
          : await savings(io($), args[0] ?? (live.sess.transcript && (await $.fs.exists(live.sess.transcript)) ? live.sess.transcript : await newestTranscript(io($), cwd)), cwd) }
      case 'pet': return { text: await pet(io($), t) }
      case 'toggle': return { text: await toggle(io($), args) }
      case 'wrapped': {
        const w = await wrapped(io($), new Date(t))
        if (w.page && !(await openFile(io($), w.page))) return { text: `${w.text}\nOpen it in your browser.` }
        return { text: w.text }
      }
      case 'saver-setup': return { text: args.includes('--help') ? USAGE : await setup(io($), args) }
    }
    const task = MODEL_COMMANDS[e.command]!
    const text = e.command === 'token-audit' ? await audit(io($), cwd) : await handoffPath(io($), cwd)
    // A submit inside command.run would wait on itself; a clock callback is a later event.
    $.clock.after(0, () => void $.prompt.submit({ text: task[1](text) }))
    return {}
  })

  // The startup check and /handoff note on new sessions and /clear; after /compact or /resume it would just repeat.
  on('classic.SessionStart', async ($, e, next) => {
    const ran = await next(e)
    if (e.source === 'startup' || e.source === 'clear' || !live.sess.transcript)
      live.sess = { transcript: e.transcript_path || undefined, id: e.session_id || undefined }
    if (e.source !== 'startup' && e.source !== 'clear') return ran
    const cwd = await $.session.cwd()
    const text = (await check(io($), cwd, (await isOn(io($), 'check')) ? e.source : undefined)).trim()
    return text ? { ...ran, additionalContext: [...(ran.additionalContext ?? []), text] } : ran
  })

  // Privacy first: a guard that fails refuses rather than letting a secret through.
  on('tool.call', { tool: /^(Bash|PowerShell|Read|Grep|Glob|Write|Edit|MultiEdit)$/ }, async ($, e, next) => {
    const reason = (await isOn(io($), 'secrets')) && secrets(String(e.tool), e as unknown as Input)
    return reason ? { deny: reason } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'claude-saver: the secret guard failed, so this call is refused.' }))

  on('tool.call', { tool: /^(Read|Grep|Glob|Bash|PowerShell)$/ }, async ($, e, next) => {
    const tool = String(e.tool)
    const ti = e as unknown as Input
    if (!(await isOn(io($), 'reads'))) return next(e)
    const reason = heavy(tool, ti)
    if (reason) return { deny: reason }
    if (tool === 'Bash' || tool === 'PowerShell') { // `cat huge.log`: blocked like a whole Read
      for (const file of shellDumps(String(ti.command ?? ''))) {
        const st = await $.fs.stat(file).catch(() => undefined)
        const big = st?.kind === 'file' && bigRead(file, st.size, {})
        if (big) return { deny: big }
      }
      return next(e)
    }
    if (tool !== 'Read') return next(e)
    const path = String(ti.file_path ?? '')
    const st = await $.fs.stat(path).catch(() => undefined)
    if (st?.kind !== 'file') return next(e)
    const big = bigRead(path, st.size, ti)
    if (big) return { deny: big }
    // Answered once already: let it through, the content likely left context (compaction).
    const key = JSON.stringify([path.replace(/\\/g, '/').toLowerCase(), ti.offset, ti.limit])
    const stamp = `${st.mtimeMs}:${st.size}`
    const old = seen.get(key)
    const repeat = old?.stamp === stamp && !old.answered
    seen.set(key, { stamp, answered: repeat })
    // The result is already known: answer the call with core's own unchanged-file stub, no file read.
    return repeat ? { result: { type: 'file_unchanged', file: { filePath: path } } } as Awaited<ReturnType<typeof next>> : next(e)
  })

  // The output guard, upgraded: a long shell output is cut before Claude reads it, not flagged after.
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || !(await isOn(io($), 'guard'))) return ran
    const r = ran.isError ? undefined : (ran.result as { stdout?: string; stderr?: string })
    const full = ran.isError ? String(ran.text ?? '') : `${r?.stdout ?? ''}${r?.stderr ? `\n${r.stderr}` : ''}`
    if (full.length / 4 < NOISY) return ran

    const dir = await claudeDir(io($))
    const slot = Number((await $.store.get('outSlot')) ?? 0)
    await $.store.set('outSlot', (slot + 1) % OUT_SLOTS)
    // ponytail: rolling slots shared by every session; two sessions can overwrite each other's file.
    const where = `${dir}/.statusline-ctx/out/${slot}.txt`
    await $.fs.write(where, full)

    const command = String((e as unknown as Input).command ?? '')
    const key = cmdKey(command)
    if (key) { // remembered per project for the startup check
      const noisy = await loadJson(io($), `${dir}/.statusline-ctx/noisy.json`)
      const cwd = normcase(await $.session.cwd())
      const project = (noisy[cwd] ?? {}) as Record<string, number>
      project[key] = (project[key] ?? 0) + 1
      noisy[cwd] = project
      await $.fs.write(`${dir}/.statusline-ctx/noisy.json`, JSON.stringify(noisy))
    }

    const cut = trim(full, where)!
    // An errored result cannot be rewritten in place: withholding it shows the model the trimmed text instead.
    if (ran.isError) return { deny: cut.text }
    return { result: { ...(r as object), stdout: cut.text, stderr: '' } } as typeof ran
  })

  // Focus mode: Claude still codes and calls tools, but the transcript hides the tool rows and the text between
  // them; a band above the prompt shows the task, its steps, a timer and what is left. ctrl+o still shows all.
  let tick: { cancel: () => void } | undefined

  // /toggle focus takes effect at once: the rows read the atom and redraw.
  on('command.run', { command: 'toggle' }, async ($, e, next) => {
    const ran = await next(e)
    await refreshFocus($)
    return ran
  })

  // A new prompt starts a new task; a continuation keeps the band's task and clock.
  on('turn.start', async ($, e, next) => {
    await refreshFocus($)
    if (e.text.trim()) {
      const t = await $.clock.now()
      await update($, run, () => ({ title: e.text.trim().split('\n')[0] ?? '', endedAt: null, steps: [] }))
      await update($, now, () => t)
    } else await update($, run, r => r && { ...r, endedAt: null })
    tick?.cancel()
    tick = $.clock.every(FRAME, () => void frame($).then(landed => { if (landed) { tick?.cancel(); tick = undefined } }))
    return next(e)
  })

  // With no steps written, the band names the last tool's work instead of a stuck "planning". It is also the step
  // gate: a task's first change waits for a step list, refused once per task so Claude is never stuck.
  on('tool.call', async ($, e, next) => {
    await update($, run, r => (r && r.endedAt === null ? { ...r, doing: activity(e.tool, e) } : r))
    const r = await read($, run)
    if (!r || r.endedAt !== null || r.steps.length || r.nudged || !changes(String(e.tool), e as unknown as Input)
      || !(await read($, focus))) return next(e)
    await update($, run, x => x && { ...x, nudged: true })
    return { deny: 'Focus mode: write your steps first with TaskCreate (or TodoWrite, or the ctx-saver steps tool), ' +
      'then make this change again.' }
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId) return ran
    const t = await $.clock.now()
    await update($, run, r => r && { ...r, endedAt: t })
    if (e.answer.trim()) await update($, answers, a => [...a, e.answer].slice(-KEEP_ANSWERS))
    return ran
  })

  // shortcut: a subagent's TodoWrite also lands here (tool.call carries no agent id); the prompt asks subagents not to.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.isError && ran.deny === undefined)
      await setSteps($, () => e.todos.map((t, i) => ({ id: String(i), text: t.content, status: t.status })))
    return ran
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const id = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
    if (id) await setSteps($, s => [...s, { id, text: e.subject, status: 'pending' }])
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.isError || ran.deny !== undefined) return ran
    await setSteps($, s => e.status === 'deleted' ? s.filter(x => x.id !== e.taskId) : s.map(x => x.id !== e.taskId ? x
      : { ...x, text: e.subject ?? x.text, status: (e.status as StepStatus | undefined) ?? x.status }))
    return ran
  })

  on('tool.call', { tool: STEPS_TOOL }, async ($, e) => {
    const steps = parseSteps(e)
    if (!steps) return { deny: 'steps: send { steps: [{ text, status }] }, status pending, in_progress or completed.' }
    await setSteps($, () => steps)
    return { result: `Showing ${steps.length} steps to the user.` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return (await read($, focus)) ? { sections: [...composed.sections, FOCUS_PROMPT] } : composed
  })

  // Tool rows: drawn as nothing while focus is on, in full under ctrl+o.
  on('ui.render', { component: /^(ToolUse|ToolResult|ToolGroup|ToolProgress)$/ }, async ($, e, next) => {
    const expanded = 'isExpanded' in e.props && e.props.isExpanded === true
    if (expanded || !(await read($, focus))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  // Claude's text: only the blocks of a finished turn's answer show.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!(await read($, focus)) || isAnswer(e.props.text, await read($, answers))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  // The status line (and Clawd, when on) in the hint line's place under the prompt; the engine's hint stays below it.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const rows = await read($, status)
    if (!rows?.length) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const noColor = Boolean(await $.env.get('NO_COLOR'))
    return (
      <Box flexDirection="column">
        {rows.map((row, i) => (
          <Box key={`status-${i}`}>
            <Text wrap="truncate-end">
              {row.map((s, j) => <Text key={String(j)} color={noColor ? undefined : s.color} bold={s.bold}>{s.text}</Text>)}
            </Text>
          </Box>
        ))}
        {e.props.hint ? <Text dimColor wrap="truncate-end">{e.props.hint}</Text> : null}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await read($, run)
    if (e.props.hasSurvey || !r?.title || !(await read($, focus))) return next(e)
    const t = await read($, now)
    const { Box, Text } = $.ui.resolve(e)

    // Drawn like the status line: a `⎿` under Claude's own spinner, ` · ` parts, a `⎿` list and 6-cell bars.
    // No clock: Claude's spinner and its "Baked for … · done" line show it. A finished task keeps a one-line ✓
    // summary so the record stays; a task stopped short keeps its steps left, with a ■.
    const total = r.steps.length
    const done = r.steps.filter(s => s.status === 'completed').length
    const ended = r.endedAt !== null
    const finished = ended && done === total
    const spin = SPINNER[Math.floor(t / FRAME) % SPINNER.length]
    const current = r.steps.findIndex(s => s.status === 'in_progress')
    // No "done": Claude's own line already says it. No steps leaves just the ✓ and the task.
    const status = finished ? (total ? `${done} of ${total} steps` : '')
      : ended ? `stopped at ${done} of ${total}`
      : total ? `step ${current >= 0 ? current + 1 : Math.min(done + 1, total)} of ${total}` : r.doing ?? 'planning'
    const textW = Math.min(44, Math.max(10, ...r.steps.map(s => s.text.length + 1)))
    const sep = <Text color={DARK}> · </Text>

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={finished ? GREEN : ended ? YELLOW : DARK}>{finished ? '✓' : ended ? '■' : '⎿'} </Text>
          {/* Layout truncates the title: bodyColumns overstates the row (the engine draws its own [-] there) */}
          <Box flexShrink={1}><Text wrap="truncate-end">{r.title}</Text></Box>
          {status && <Box flexShrink={0}>{sep}<Text color={GRAY}>{status}</Text></Box>}
        </Box>
        {finished ? null : r.steps.map((s, i) => {
          const label = stepLabel(r.steps, i)
          const frac = stepFraction(r.steps, s, t)
          const working = label === 'Working' && !ended
          return (
            <Box key={s.id}>
              <Text color={DARK}>{i ? '    ' : '  ⎿ '}</Text>
              <Text color={label === 'Done' ? GREEN : working ? CLAUDE : DARK}>{label === 'Done' ? '✓' : working ? spin : '○'} </Text>
              <Box width={textW}><Text color={working ? undefined : GRAY} wrap="truncate-end">{s.text}</Text></Box>
              {working && frac !== undefined && <Text>{bar(Text, frac)}<Text color={GRAY}> {Math.round(frac * 100)}%</Text></Text>}
            </Box>
          )
        })}
      </Box>
    )
  })
}
