import { expect, mock, test } from 'claude-code/testing'

import { disk } from './fakeio'

const FAKE_KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP' // split so the secret guard lets this file be written

/** Every tool call goes through, with an empty result, unless a test overrides it. */
const allow = (on: Parameters<typeof mock.env>[0]) =>
  on('tool.call', { tool: /^(Read|Grep|Glob|Bash|PowerShell|Write|Edit)$/ }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

test('secret guard: .env reads and hardcoded keys are blocked; placeholders and .env writes pass', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  disk(on)
  allow(on)
  const deny = async (tool: string, input: object) => (await $.tool.call({ tool, ...input } as never)).deny
  expect(await deny('Read', { file_path: '/app/.env' })).toContain('Blocked')
  expect(await deny('Bash', { command: 'cat .env.local' })).toContain('.env.local')
  expect(await deny('Read', { file_path: '/app/.env.example' })).toBeUndefined()
  expect(await deny('Read', { file_path: '/app/.environment' })).toBeUndefined()
  expect(await deny('Write', { file_path: 'a.py', content: `k = "${FAKE_KEY}"` })).toContain('AWS access key')
  expect(await deny('Write', { file_path: '.env', content: `K=${FAKE_KEY}` })).toBeUndefined()
})

test('generated folders are skipped for Read, Grep, Glob and shell reads; other shell commands pass', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  disk(on)
  allow(on)
  const deny = async (tool: string, input: object) => (await $.tool.call({ tool, ...input } as never)).deny
  expect(await deny('Read', { file_path: 'C:\\app\\node_modules\\x\\index.js' })).toContain('node_modules')
  expect(await deny('Grep', { pattern: 'foo', path: 'web/.next' })).toContain('.next')
  expect(await deny('Glob', { pattern: '**/__pycache__/*.pyc' })).toContain('__pycache__')
  expect(await deny('Read', { file_path: 'dist/app.js' })).toContain('dist')
  expect(await deny('Read', { file_path: 'src/node_modules_util.ts' })).toBeUndefined()
  expect(await deny('Bash', { command: 'cat node_modules/react/index.js' })).toContain('node_modules')
  expect(await deny('Bash', { command: 'cd app && grep -rn useState node_modules/react | head' })).toContain('node_modules')
  expect(await deny('PowerShell', { command: 'Get-ChildItem -Recurse build' })).toContain('build')
  expect(await deny('Bash', { command: 'rm -rf node_modules && npm ci' })).toBeUndefined()
  expect(await deny('Bash', { command: 'grep -rn node_modules .gitignore' })).toBeUndefined()
  expect(await deny('Bash', { command: 'grep -r foo --exclude-dir=node_modules .' })).toBeUndefined()
  expect(await deny('Bash', { command: "find . -path '*/node_modules/*' -prune -o -name '*.ts' -print" })).toBeUndefined()
  expect(await deny('Bash', { command: "rg foo -g '!dist'" })).toBeUndefined()
})

test('a huge log through cat is blocked like a whole Read', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  disk(on, { '/proj/app.log': 'x'.repeat(80_000) })
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, () => ({ result: { stdout: 'x', stderr: '', interrupted: false } }))
  expect((await $.tool.call({ tool: 'Bash', command: 'cat /proj/app.log' })).deny).toContain('~20.0k tokens')
})

test('shell reads that pipe, tail or redirect pass the huge-log guard', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  disk(on, { '/proj/app.log': 'x'.repeat(80_000) })
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, () => ({ result: { stdout: 'x', stderr: '', interrupted: false } }))
  expect((await $.tool.call({ tool: 'Bash', command: 'tail -50 /proj/app.log' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'cat /proj/app.log | grep ERROR' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'PowerShell', command: 'Get-Content /proj/app.log -Tail 50' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'cat > out.txt' })).deny).toBeUndefined()
})

test('a whole Read of a lockfile or a file over 40 KB is blocked; offset and limit, and images, pass', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  disk(on, {
    '/a/package-lock.json': 'x'.repeat(10),
    '/a/big.ts': 'x'.repeat(50_000),
    '/a/pic.png': 'x'.repeat(50_000),
  })
  allow(on)
  const read = (file_path: string, extra = {}) => $.tool.call({ tool: 'Read', file_path, ...extra } as never)
  expect((await read('/a/package-lock.json')).deny).toContain('skipped')
  expect((await read('/a/big.ts')).deny).toContain('~12.5k tokens')
  expect((await read('/a/big.ts', { offset: 1, limit: 50 })).deny).toBeUndefined()
  expect((await read('/a/pic.png')).deny).toBeUndefined()
})

test('a long Bash output keeps its head, tail and error lines from the middle', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  mock.store(on)
  disk(on)
  on('session.cwd', () => ({ value: '/proj' }))
  let stdout = ''
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout, stderr: '', interrupted: false } }))
  const run = async () => ((await $.tool.call({ tool: 'Bash', command: 'npm test' })).result as { stdout: string }).stdout

  const lines = Array.from({ length: 5000 }, (_, i) => `ok ${i}`)
  lines[2500] = 'FAIL src/a.test.ts > adds: expected 2, got 3'
  lines[2600] = 'TypeError: x is undefined'
  stdout = lines.join('\n')
  const cut = await run()
  expect(cut).toContain('FAIL src/a.test.ts')
  expect(cut).toContain('TypeError: x is undefined')
  expect(cut).not.toContain('ok 2500\n')
  expect(cut.length).toBeLessThan(9600)
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
