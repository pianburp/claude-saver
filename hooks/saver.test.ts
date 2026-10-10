import { expect, mock, test } from 'claude-code/testing'

import { disk } from './fakeio'

type On = Parameters<typeof mock.env>[0]

const jsonl = (lines: unknown[]) => lines.map(l => JSON.stringify(l)).join('\n')

/** A session in cwd with these files on disk; the commands read and write the same disk the test checks. */
function session(on: On, files: Record<string, string>, { cwd = '/h/proj', now = Date.UTC(2026, 9, 5, 12) } = {}) {
  mock.env(on, { HOME: '/h' })
  const clock = mock.clock(on, { now })
  const d = disk(on, files, () => clock.now())
  const where = { cwd } // a test moves the session to another folder by setting this
  on('session.cwd', () => ({ value: where.cwd }))
  const prompts: string[] = []
  on('prompt.submit', (_$, e) => { prompts.push(e.text); return { text: e.text } })
  return { d, clock, prompts, where }
}

test('/token-audit: HTML comments are free, @imports follow, path-scoped rules are skipped, long files and stale paths flagged; AGENTS.md is the fallback; MEMORY.md is flagged past 200 lines', async ($, on) => {
  const { d, clock, prompts, where } = session(on, {
    '/h/proj/CLAUDE.md': '<!-- ' + 'x'.repeat(400) + ' -->\nSee @extra.md and `src/gone.py`\n',
    '/h/proj/extra.md': 'y'.repeat(4000),
    '/h/proj/.claude/rules/py.md': "---\npaths: ['**/*.py']\n---\nz",
    '/h/proj/AGENTS.md': 'ignored while a CLAUDE.md exists',
    '/h/bare/AGENTS.md': 'agents',
    '/h/.claude/projects/-h-proj/memory/MEMORY.md': '- x\n'.repeat(201),
  })
  await $.command.run({ command: 'token-audit', args: '' } as never)
  await clock.settle()
  const report = prompts[0]!
  expect(report).toContain('/h/proj/extra.md')
  expect(report).toContain('long: 1.0k tokens')
  expect(report).toContain('maybe stale path: src/gone.py')
  expect(report).not.toContain('AGENTS.md')
  expect(report).not.toContain('py.md')
  expect(Number(/(\d+)\s+\/h\/proj\/CLAUDE\.md/.exec(report)![1])).toBeLessThan(20) // the comment costs nothing
  expect(report).toContain('truncated: only the first 200 lines')

  d.put('/h/.claude/projects/-h-proj/memory/MEMORY.md', '- x\n'.repeat(200))
  await $.command.run({ command: 'token-audit', args: '' } as never)
  await clock.settle()
  expect(prompts[1]).not.toContain('truncated')

  where.cwd = '/h/bare' // no CLAUDE.md here: AGENTS.md loads instead
  await $.command.run({ command: 'token-audit', args: '' } as never)
  await clock.settle()
  expect(prompts[2]).toContain('/h/bare/AGENTS.md')
})

test('/token-audit: a gitignored folder of 1000+ files is named; a small one and node_modules are not', async ($, on) => {
  const many = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`/h/proj/storage/f${i}.txt`, 'x']))
  const { clock, prompts } = session(on, {
    ...many,
    '/h/proj/.gitignore': '# c\n/storage\nsmall/\nnode_modules\n*.log\n!keep\n.claude/x\ncache/**\na/b',
    '/h/proj/small/a.txt': 'x',
  })
  await $.command.run({ command: 'token-audit', args: '' } as never)
  await clock.settle()
  expect(prompts[0]).toContain('Unblocked heavy dirs: storage')
  expect(prompts[0]).not.toMatch(/Unblocked heavy dirs: [^\n]*small/)
})

test('/savings: usage counted once per message id; modes and graph queries credited', async ($, on) => {
  session(on, {
    '/t/s.jsonl': jsonl([
      { message: { role: 'user', content: 'CAVEMAN MODE ACTIVE' } },
      { message: { id: 'm1', role: 'assistant', usage: { input_tokens: 5, output_tokens: 100 }, content: [{ type: 'text', text: 'a'.repeat(400) }] } },
      { message: { id: 'm1', role: 'assistant', usage: { input_tokens: 5, output_tokens: 100 },
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: "graphify query 'auth'" } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'b'.repeat(800) }] } },
    ]),
  })
  const text = (await $.command.run({ command: 'savings', args: '/t/s.jsonl' } as never)).text!
  expect(text).toContain('Session s.jsonl: 1 API calls')
  expect(text).toContain('input 5 ·')
  expect(text).toContain('output 100')
  expect(text).toMatch(/caveman\s+~185/) // 100 reply tokens cut 65%, as caveman's benchmark
  expect(text).toMatch(/graphify\s+~7\.3k/) // 1 query x 5 reads x 1.5k, less the 200-token result
  expect(text).not.toContain('ponytail')
})

test('/savings: blocked reads, quieter reruns, trims and auto-compacts each get a row', async ($, on) => {
  const result = (id: string, content: string) => ({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } })
  const use = (id: string, name: string, input: object) => ({ message: { id, role: 'assistant', usage: {}, content: [{ type: 'tool_use', id, name, input }] } })
  session(on, {
    '/t/s2.jsonl': jsonl([
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
  const text = (await $.command.run({ command: 'savings', args: '/t/s2.jsonl' } as never)).text!
  expect(text).toMatch(/reads\s+~12\.8k/) // 12.5k skipped, plus a folder block at the average read
  expect(text).toMatch(/guard\s+~2\.9k/) // npm test: 3000 tokens, then 100
  expect(text).toMatch(/trim\s+~4\.5k/)
  expect(text).toMatch(/compact\s+~800/) // 8000 dropped x 1 later call x 10%
})

test('startup check: a noisy command and an old status line are named; a CLAUDE.md note quiets the command', async ($, on) => {
  const { d } = session(on, {
    '/h/.claude/.statusline-ctx/noisy.json': JSON.stringify({ '/h/proj': { 'npm test': 3, ls: 1 } }),
    '/h/.claude/settings.json': JSON.stringify({ statusLine: { command: '"py" "/h/.claude/statusline.py"' } }),
  })
  on('classic.SessionStart', () => ({}))
  const first = (await $.classic.SessionStart({ source: 'startup' })).additionalContext!.join('\n')
  expect(first).toContain('`npm test` printed 2k+ tokens 3 times')
  expect(first).toContain('/saver-setup')
  expect(first).not.toContain('/token-audit')

  d.put('/h/.claude/settings.json', '{}')
  d.put('/h/proj/CLAUDE.md', 'npm test -- --silent')
  expect((await $.classic.SessionStart({ source: 'startup' })).additionalContext).toBeUndefined()
})

test('/savings --week and /pet read the ledger', async ($, on) => {
  const { clock } = session(on, {
    '/h/.claude/.statusline-ctx/ledger.json': JSON.stringify({ total: 300_000, born: new Date(2026, 9, 2).getTime() / 1000,
      days: { '2026-10-05': 2000, '2026-10-03': 500 } }),
  }, { now: new Date(2026, 9, 5, 1).getTime() })

  expect((await $.command.run({ command: 'pet', args: '' } as never)).text).toBe(
    ' ▐▛███▜▌✦  ~300.0k tokens saved, lifetime, 3 days old\n▝▜█████▛▘  next stage at 2.5M (12%)\n  ▘▘ ▝▝')

  const week = (await $.command.run({ command: 'savings', args: '--week' } as never)).text!
  expect(week).toContain('█'.repeat(20) + '  ~2.0k')
  expect(week).toContain('█'.repeat(5) + ' ')
  expect(week).toContain('~2.5k')

  await clock.set(new Date(2027, 0, 1).getTime())
  expect((await $.command.run({ command: 'savings', args: '--week' } as never)).text).toContain('Nothing recorded')
})

test('/wrapped: a week of sessions as an escaped HTML page; a quiet week says so', async ($, on) => {
  const at = new Date(2026, 9, 5, 10).toISOString()
  const call = (id: string, tool: string) => ({ timestamp: at, cwd: '/x/<b>',
    message: { id, role: 'assistant', usage: { output_tokens: 10 }, content: [{ type: 'tool_use', id: id + 't', name: tool, input: {} }] } })
  const { d, clock } = session(on, {
    '/h/.claude/projects/p/s.jsonl': jsonl([call('a', 'Grep'), call('b', 'Grep'), call('c', 'Read')]),
    '/h/.claude/.statusline-ctx/ledger.json': JSON.stringify({ total: 2500, days: { '2026-10-05': 2500 } }),
  }, { now: new Date(2026, 9, 5, 10).getTime() })

  const text = (await $.command.run({ command: 'wrapped', args: '' } as never)).text!
  expect(text.startsWith('3 calls, top project <b>, busiest Monday')).toBe(true)
  const page = d.get('/h/.claude/.statusline-ctx/wrapped.html')!
  expect(page).toContain('&lt;b&gt;')
  expect(page).toContain('<b>Grep</b>')
  expect(page).toContain('~2.5k')
  expect(page).not.toContain('$')

  await clock.set(new Date(2027, 0, 1).getTime())
  expect((await $.command.run({ command: 'wrapped', args: '' } as never)).text).toContain('No Claude Code activity')
})

test('/toggle: config.json beats an older install\'s --pet; switching one off leaves the rest on', async ($, on) => {
  session(on, { '/h/.claude/settings.json': JSON.stringify({ statusLine: { command: 'py "statusline.py" --pet' } }) })
  const toggle = async (args: string) => (await $.command.run({ command: 'toggle', args } as never)).text!

  expect(await toggle('')).toMatch(/pet\s+on\s/)
  expect(await toggle('pet')).toMatch(/pet\s+off\s/)
  const out = await toggle('guard off')
  expect(out).toMatch(/guard\s+off\s/)
  expect(out).toMatch(/secrets\s+on\s/)
  expect(await toggle('nope')).toContain('Usage')
})
