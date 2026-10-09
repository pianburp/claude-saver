import { expect, test } from 'claude-code/testing'

import { fakeIo } from './fakeio'
import {
  alwaysLoaded, basename, check, cmdKey, fileFindings, gitignoredDirs, isOn, pet, savedRows,
  sessionStats, toggle, tokens, visible, week, wrapped,
} from './saver'

const HOME = { HOME: '/h' }
const jsonl = (lines: unknown[]) => lines.map(l => JSON.stringify(l)).join('\n')
const names = (loaded: [string, string][]) => loaded.map(([p]) => basename(p)).sort()

test('audit: HTML comments are free, @imports follow, path-scoped rules are skipped', async () => {
  const { io } = fakeIo({
    '/h/proj/CLAUDE.md': '<!-- ' + 'x'.repeat(400) + ' -->\nSee @extra.md and `src/gone.py`\n',
    '/h/proj/extra.md': 'y'.repeat(4000),
    '/h/proj/.claude/rules/py.md': "---\npaths: ['**/*.py']\n---\nz",
    '/h/proj/AGENTS.md': 'ignored while a CLAUDE.md exists',
    '/h/bare/AGENTS.md': 'agents',
  }, HOME)
  const loaded = await alwaysLoaded(io, '/h/proj')
  expect(names(loaded)).toEqual(['CLAUDE.md', 'extra.md'])
  expect(tokens(visible(loaded.find(([p]) => p.endsWith('CLAUDE.md'))![1]))).toBeLessThan(20)
  expect(await fileFindings(io, '/h/proj/CLAUDE.md', '`src/gone.py`', '/h/proj')).toContain('maybe stale path: src/gone.py')
  expect((await fileFindings(io, '/h/proj/extra.md', 'y'.repeat(4000), '/h/proj'))[0]).toMatch(/^long/)
  expect(names(await alwaysLoaded(io, '/h/bare'))).toEqual(['AGENTS.md'])
  expect((await fileFindings(io, '/h/MEMORY.md', '- x\n'.repeat(201), '/h/proj')).some(f => f.startsWith('truncated'))).toBe(true)
  expect(await fileFindings(io, '/h/MEMORY.md', '- x\n'.repeat(200), '/h/proj')).toEqual([])
  expect((await fileFindings(io, '/h/proj/.claude/rules/a.md', 'z', '/h/proj')).some(f => f.includes('paths:'))).toBe(true)
})

test('savings: usage counted once per message id, modes and graph queries credited', async () => {
  const { io } = fakeIo({
    '/t/s.jsonl': jsonl([
      { message: { role: 'user', content: 'CAVEMAN MODE ACTIVE' } },
      { message: { id: 'm1', role: 'assistant', usage: { input_tokens: 5, output_tokens: 100 }, content: [{ type: 'text', text: 'a'.repeat(400) }] } },
      { message: { id: 'm1', role: 'assistant', usage: { input_tokens: 5, output_tokens: 100 },
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: "graphify query 'auth'" } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'b'.repeat(800) }] } },
    ]),
  })
  const s = await sessionStats(io, '/t/s.jsonl')
  expect([s.calls, s.input, s.output]).toEqual([1, 5, 100])
  expect([s.caveman, s.ponytail, s.text]).toEqual([true, false, 100])
  expect([s.graph_queries, s.graph_results]).toEqual([['t1'], 200])
  expect(savedRows(s).map(r => r[0])).toEqual(['caveman', 'graphify'])
})

test('savings: blocked reads, quieter reruns, trims and auto-compacts each get a row', async () => {
  const result = (id: string, content: string) => ({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } })
  const use = (id: string, name: string, input: object) => ({ message: { id, role: 'assistant', usage: {}, content: [{ type: 'tool_use', id, name, input }] } })
  const { io } = fakeIo({
    '/t/s.jsonl': jsonl([
      use('r1', 'Read', { file_path: 'a.ts' }), result('r1', 'x'.repeat(4000)),
      use('r2', 'Read', { file_path: 'b.ts' }), result('r2', 'claude-saver: skipped ~12.5k tokens, a whole read of b.ts.'),
      use('r3', 'Read', { file_path: 'c' }), result('r3', 'claude-saver: skipped node_modules/, a generated folder.'),
      use('b1', 'Bash', { command: 'npm test' }), result('b1', 'y'.repeat(12000)),
      use('b2', 'Bash', { command: 'npm test -- --silent' }), result('b2', 'y'.repeat(400)),
      result('b3', 'head\n[claude-saver: trimmed ~4.5k tokens from the middle. Full output: x]\ntail'),
      { compactMetadata: { trigger: 'auto', preTokens: 9000, postTokens: 1000 } },
      use('z', 'Read', { file_path: 'z' }),
    ]),
  })
  const s = await sessionStats(io, '/t/s.jsonl')
  const per = Math.floor(s.reads.reduce((a, b) => a + b, 0) / s.reads.length) // the folder block is priced at the average read
  const rows = Object.fromEntries(savedRows(s).map(r => [r[0], r[1]]))
  expect(rows).toEqual({ reads: 12500 + per, guard: 3000 - 100, trim: 4500, compact: 8000 * 1 * 0.1 })
})

test('gitignoredDirs and cmdKey', () => {
  expect(gitignoredDirs('# c\n/storage\nsmall/\nnode_modules\n*.log\n!keep\n.claude/x\ncache/**\na/b')).toEqual(['storage', 'small', 'node_modules', 'cache'])
  expect(['cd app && npm test -- --watch', 'git log --oneline | head', 'pytest', "echo 'x y'", ''].map(cmdKey))
    .toEqual(['npm test', 'git log', 'pytest', 'echo', ''])
})

test('check: the handoff note once, a noisy command, and an older install', async () => {
  const { io, fs } = fakeIo({
    '/h/.claude/.statusline-ctx/handoff/-h-proj.md': 'Goal: ship it',
    '/h/.claude/.statusline-ctx/noisy.json': JSON.stringify({ '/h/proj': { 'npm test': 3, 'ls': 1 } }),
    '/h/.claude/settings.json': JSON.stringify({ statusLine: { command: '"py" "/h/.claude/statusline.py"' } }),
  }, HOME)
  const out = await check(io, '/h/proj', 'startup')
  expect(out).toContain('Goal: ship it')
  expect(out).toContain('`npm test` printed 2k+ tokens 3 times')
  expect(out).toContain('/saver-setup')
  expect(out).not.toContain('/token-audit')
  expect(fs.get('/h/.claude/.statusline-ctx/handoff/-h-proj.md')).toBe('')
  expect(await check(io, '/h/proj', 'clear')).toBe('')
  fs.set('/h/.claude/settings.json', '{}')
  fs.set('/h/proj/CLAUDE.md', 'npm test -- --silent')
  expect(await check(io, '/h/proj', 'startup')).toBe('') // noted in CLAUDE.md: quiet
})

test('week and pet read the ledger', async () => {
  const today = new Date(2026, 9, 5)
  const { io, setClock } = fakeIo({
    '/h/.claude/.statusline-ctx/ledger.json': JSON.stringify({ total: 300_000, born: new Date(2026, 9, 2).getTime() / 1000,
      days: { '2026-10-05': 2000, '2026-10-03': 500 } }),
  }, HOME)
  const w = await week(io, today)
  expect(w).toContain('█'.repeat(20) + '  ~2.0k')
  expect(w).toContain('█'.repeat(5) + ' ')
  expect(w).toContain('~2.5k')
  expect(await week(io, new Date(2027, 0, 1))).toContain('Nothing recorded')
  setClock(today.getTime())
  expect(await pet(io, new Date(2026, 9, 5, 1).getTime())).toBe(
    ' ▐▛███▜▌✦  ~300.0k tokens saved, lifetime, 3 days old\n▝▜█████▛▘  next stage at 2.5M (12%)\n  ▘▘ ▝▝')
})

test('wrapped: a week of sessions as an escaped HTML page', async () => {
  const at = new Date(2026, 9, 5, 10).toISOString()
  const call = (id: string, tool: string) => ({ timestamp: at, cwd: '/x/<b>',
    message: { id, role: 'assistant', usage: { output_tokens: 10 }, content: [{ type: 'tool_use', id: id + 't', name: tool, input: {} }] } })
  const { io, fs } = fakeIo({
    '/h/.claude/projects/p/s.jsonl': jsonl([call('a', 'Grep'), call('b', 'Grep'), call('c', 'Read')]),
    '/h/.claude/.statusline-ctx/ledger.json': JSON.stringify({ total: 2500, days: { '2026-10-05': 2500 } }),
  }, HOME)
  const w = await wrapped(io, new Date(2026, 9, 5))
  expect(w.text.startsWith('3 calls, top project <b>, busiest Monday')).toBe(true)
  const page = fs.get(w.page!)!
  expect(page).toContain('&lt;b&gt;')
  expect(page).toContain('<b>Grep</b>')
  expect(page).toContain('~2.5k')
  expect(page).not.toContain('$')
  expect((await wrapped(io, new Date(2027, 0, 1))).text).toContain('No Claude Code activity')
})

test('toggle: config.json beats an older install\'s --pet; the guards read the same switches', async () => {
  const { io } = fakeIo({ '/h/.claude/settings.json': JSON.stringify({ statusLine: { command: 'py "statusline.py" --pet' } }) }, HOME)
  expect([await isOn(io, 'pet'), await isOn(io, 'guard')]).toEqual([true, true])
  await toggle(io, ['pet'])
  const out = await toggle(io, ['guard', 'off'])
  expect([await isOn(io, 'pet'), await isOn(io, 'guard'), await isOn(io, 'secrets')]).toEqual([false, false, true])
  expect(out).toContain('guard    off')
  expect(await toggle(io, ['nope'])).toContain('Usage')
})
