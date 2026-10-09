import { expect, mock, test } from 'claude-code/testing'

import { bigRead, heavy, secrets, shellDumps, trim } from './register'

const FAKE_KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP' // split so the secret guard lets this file be written

test('secrets: blocks .env, lets placeholders and .env writes through', () => {
  expect(secrets('Read', { file_path: '/app/.env' })).toContain('Blocked')
  expect(secrets('Bash', { command: 'cat .env.local' })).toContain('.env.local')
  expect(secrets('Read', { file_path: '/app/.env.example' })).toBeUndefined()
  expect(secrets('Read', { file_path: '/app/.environment' })).toBeUndefined()
  expect(secrets('Write', { file_path: 'a.py', content: `k = "${FAKE_KEY}"` })).toContain('AWS access key')
  expect(secrets('Write', { file_path: '.env', content: `K=${FAKE_KEY}` })).toBeUndefined()
})

test('heavy: blocks generated folders for Read, Grep, Glob and shell reads', () => {
  expect(heavy('Read', { file_path: 'C:\\app\\node_modules\\x\\index.js' })).toContain('node_modules')
  expect(heavy('Grep', { pattern: 'foo', path: 'web/.next' })).toContain('.next')
  expect(heavy('Glob', { pattern: '**/__pycache__/*.pyc' })).toContain('__pycache__')
  expect(heavy('Read', { file_path: 'dist/app.js' })).toContain('dist')
  expect(heavy('Read', { file_path: 'src/node_modules_util.ts' })).toBeUndefined()
  expect(heavy('Bash', { command: 'cat node_modules/react/index.js' })).toContain('node_modules')
  expect(heavy('Bash', { command: 'cd app && grep -rn useState node_modules/react | head' })).toContain('node_modules')
  expect(heavy('PowerShell', { command: 'Get-ChildItem -Recurse build' })).toContain('build')
  expect(heavy('Bash', { command: 'rm -rf node_modules && npm ci' })).toBeUndefined()
  expect(heavy('Bash', { command: 'grep -rn node_modules .gitignore' })).toBeUndefined()
  expect(heavy('Bash', { command: 'grep -r foo --exclude-dir=node_modules .' })).toBeUndefined()
  expect(heavy('Bash', { command: "find . -path '*/node_modules/*' -prune -o -name '*.ts' -print" })).toBeUndefined()
  expect(heavy('Bash', { command: "rg foo -g '!dist'" })).toBeUndefined()
})

test('shellDumps: whole-file dumps only, not piped or limited reads', () => {
  expect(shellDumps('cat logs/app.log')).toEqual(['logs/app.log'])
  expect(shellDumps('Get-Content "C:\\x\\big.log"')).toEqual(['C:\\x\\big.log'])
  expect(shellDumps('cat app.log | grep ERROR')).toEqual([])
  expect(shellDumps('Get-Content app.log -Tail 50')).toEqual([])
  expect(shellDumps('cat > out.txt')).toEqual([])
})

test('bigRead skips lockfiles and huge files', () => {
  expect(bigRead('/a/package-lock.json', 10, {})).toContain('skipped')
  expect(bigRead('/a/big.ts', 50_000, {})).toContain('~12.5k tokens')
  expect(bigRead('/a/big.ts', 50_000, { offset: 1, limit: 50 })).toBeUndefined()
  expect(bigRead('/a/pic.png', 50_000, {})).toBeUndefined()
})

test('trim keeps short output and cuts long output to head and tail', () => {
  expect(trim('ok\n'.repeat(100), 'f')).toBeUndefined()
  const out = trim(Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n'), '/tmp/0.txt')!
  expect(out.text).toContain('line 0\n')
  expect(out.text).toContain('line 4999')
  expect(out.text).toContain('claude-saver: trimmed ~')
  expect(out.text.length).toBeLessThan(6500)
})

test('trim keeps error lines from the cut middle', () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `ok ${i}`)
  lines[2500] = 'FAIL src/a.test.ts > adds: expected 2, got 3'
  lines[2600] = 'TypeError: x is undefined'
  const out = trim(lines.join('\n'), 'f')!
  expect(out.text).toContain('FAIL src/a.test.ts')
  expect(out.text).toContain('TypeError: x is undefined')
  expect(out.text).not.toContain('ok 2500\n')
  expect(out.text.length).toBeLessThan(6500 + 3100)
})

test('a huge log through cat is blocked like a whole Read', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 80_000, mtimeMs: 1, isLink: false } }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'x', stderr: '', interrupted: false } }))
  expect((await $.tool.call({ tool: 'Bash', command: 'cat app.log' })).deny).toContain('~20.0k tokens')
  expect((await $.tool.call({ tool: 'Bash', command: 'tail -50 app.log' })).deny).toBeUndefined()
})

test('an unchanged re-read is answered by the mod once, then read again', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 100, mtimeMs: 1, isLink: false } }))
  let reads = 0
  on('tool.call', { tool: 'Read' }, () => {
    reads++
    return { result: { type: 'text', file: { filePath: 'a.ts', content: 'x', numLines: 1, startLine: 1, totalLines: 1 } } }
  })
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  const again = await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  expect((again.result as { type: string }).type).toBe('file_unchanged')
  expect(reads).toBe(1)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  expect(reads).toBe(2)
})

test('a long Bash output is trimmed and saved in full', async ($, on) => {
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  const written: Record<string, string> = {}
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.write', (_$, e) => { written[e.path] = e.text; return { value: undefined } })
  on('session.cwd', () => ({ value: '/proj' }))
  const long = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: long, stderr: '', interrupted: false } }))

  const ran = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const stdout = (ran.result as { stdout: string }).stdout
  expect(stdout).toContain('claude-saver: trimmed ~')
  // the engine resolves paths before the hooks see them: C:\home\u\... on Windows
  const file = (end: string) => Object.entries(written).find(([path]) => path.replace(/\\/g, '/').endsWith(end))?.[1]
  expect(file('/home/u/.claude/.statusline-ctx/out/0.txt')).toBe(long)
  expect(JSON.parse(file('/home/u/.claude/.statusline-ctx/noisy.json')!)).toEqual({ '/proj': { 'npm test': 1 } })
})

test('the secret guard denies .env, and /toggle secrets off lets it through', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  let cfg = '{}'
  on('fs.read', (_$, e) => (e.path.endsWith('config.json') ? { value: cfg } : { deny: 'ENOENT' }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: { filePath: '.env', content: 'K=1', numLines: 1, startLine: 1, totalLines: 1 } } }))
  expect((await $.tool.call({ tool: 'Read', file_path: '.env' })).deny).toContain('live secrets')
  cfg = '{"secrets": false}'
  expect((await $.tool.call({ tool: 'Read', file_path: '.env' })).deny).toBeUndefined()
})

test('SessionStart shows the /handoff note once, on startup and /clear only', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  mock.clock(on)
  const files: Record<string, string> = { 'handoff/-proj.md': 'Goal: ship it' }
  const key = (path: string) => Object.keys(files).find(k => path.replace(/\\/g, '/').endsWith(k))
  on('fs.read', (_$, e) => { const k = key(e.path); return k && files[k] ? { value: files[k] } : { deny: 'ENOENT' } })
  on('fs.write', (_$, e) => { const k = key(e.path); if (k) files[k] = e.text; return { value: undefined } })
  on('fs.stat', (_$, e) => (key(e.path) ? { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('classic.SessionStart', () => ({})) // the settings hooks beneath
  const first = await $.classic.SessionStart({ source: 'clear' })
  expect(first.additionalContext).toEqual(['claude-saver: handoff note from the last session (from /handoff):\nGoal: ship it'])
  expect(files['handoff/-proj.md']).toBe('')
  expect((await $.classic.SessionStart({ source: 'clear' })).additionalContext).toBeUndefined()
  files['handoff/-proj.md'] = 'Goal: again'
  expect((await $.classic.SessionStart({ source: 'resume' })).additionalContext).toBeUndefined()
})

test('/savings --week answers at once; /token-audit hands its report to Claude', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  const clock = mock.clock(on)
  const ledger = JSON.stringify({ total: 2000, days: { [new Date(clock.now()).toISOString().slice(0, 10)]: 2000 } })
  on('fs.read', (_$, e) => (e.path.endsWith('ledger.json') ? { value: ledger } : { deny: 'ENOENT' }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('session.cwd', () => ({ value: '/proj' }))
  const prompts: string[] = []
  on('prompt.submit', (_$, e) => { prompts.push(e.text); return { text: e.text } })

  const week = (await $.command.run({ command: 'savings', args: '--week' } as never)).text
  expect(week).toContain('Saved per day')
  expect(week).toContain('~2.0k')
  expect(prompts).toEqual([])
  expect((await $.command.run({ command: 'token-audit', args: '' } as never)).text).toBeUndefined()
  await clock.settle()
  expect(prompts[0]).toContain('Always-loaded instructions')
  expect(prompts[0]).toContain('Show each change as a diff')
})

test('the status line draws under the prompt, and steps aside for an older install', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  const clock = mock.clock(on)
  let settings = '{}'
  on('fs.read', (_$, e) => (e.path.endsWith('settings.json') ? { value: settings } : { deny: 'ENOENT' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.root', () => ({ value: '/proj' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'Opus' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 42 }, rateLimits: [] } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Text, {}, 'engine hint') as never) // the engine's own line
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)

  const props = { isDraft: false, isWorking: false, hint: '? for shortcuts' }
  const ui = await $.ui.mount({ plugin: 'ctx-saver', surface: 'terminal', component: 'PromptHint', props })
  expect(await ui.find({ type: 'Text', text: /Opus/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /42%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\? for shortcuts/ })).toBeDefined()
  await ui.unmount()

  settings = JSON.stringify({ statusLine: { command: '"py" "/home/u/.claude/statusline.py"' } })
  await clock.advance(1000)
  const old = await $.ui.mount({ plugin: 'ctx-saver', surface: 'terminal', component: 'PromptHint', props })
  expect(await old.find({ type: 'Text', text: /Opus/ })).toBeUndefined()
  expect(await old.find({ text: 'engine hint' })).toBeDefined()
  await old.unmount()
})
