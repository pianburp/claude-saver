import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { disk } from './fakeio'

type On = Parameters<typeof mock.env>[0]
type Usage = { startedAt: number; context: { window: number; percent?: number }; rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[] }

const NOW = Date.UTC(2026, 9, 5, 12)
const TRANSCRIPT = '/h/.claude/projects/-proj/s1.jsonl'
const LINE = '/h/.claude/.statusline-ctx/line/s1.txt'
const LEDGER = '/h/.claude/.statusline-ctx/ledger.json'
const SETTINGS = '/h/.claude/settings.json'
const ANSI = /\x1b\[[0-9;]*m/g
const usage = (percent?: number, rateLimits: Usage['rateLimits'] = []): Usage => ({ startedAt: 0, context: { window: 200_000, percent }, rateLimits })
const jsonl = (lines: unknown[]) => lines.map(l => JSON.stringify(l)).join('\n')

/**
 * Session s1 in /proj starts its status line. The transcript is written now; idleAt(s) moves its mtime so the
 * line reads `s` seconds idle on the next tick. The line file is read back as the status line prints it.
 */
async function startLine($: Engine, on: On, { files = {}, env = {}, transcript = true }: {
  files?: Record<string, string>; env?: Record<string, string>; transcript?: boolean
} = {}) {
  mock.env(on, { HOME: '/h', ...env })
  const clock = mock.clock(on, { now: NOW })
  const d = disk(on, { ...(transcript ? { [TRANSCRIPT]: 'x' } : {}), ...files }, () => clock.now())
  const state = { usage: usage(42) }
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/proj' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.model', () => ({ value: 'Opus' }))
  on('session.usage', () => ({ value: state.usage }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)

  const shown = () => d.get(LINE)
  const idleAt = async (idle: number) => {
    d.touch(TRANSCRIPT, clock.now() + 1000 - idle * 1000)
    await clock.advance(1000)
    return shown()?.replace(ANSI, '') ?? ''
  }
  return { d, clock, state, shown, idleAt }
}

test('status line: model, spinner while the transcript is written, effort, the cache timer, and the /compact, /handoff and /clear hints', async ($, on) => {
  const { state, idleAt } = await startLine($, on, { files: { [SETTINGS]: JSON.stringify({ effortLevel: 'xhigh' }) } })
  const busy = (await idleAt(0)).split('\n')[0]!
  expect('·✢✳✶✻✽'.includes(busy[0]!)).toBe(true)
  expect(busy).toContain('Opus · xhi')
  const quiet = (await idleAt(60)).split('\n')
  expect(quiet[0]!.startsWith('✻ Opus · xhi')).toBe(true)
  expect(quiet[1]!.endsWith('● 59m')).toBe(true)

  state.usage = usage(40)
  expect(await idleAt(60)).toContain('/compact')
  state.usage = usage(39)
  expect(await idleAt(60)).not.toContain('/compact')
  state.usage = usage(30)
  expect(await idleAt(3601)).toContain('/handoff /clear')
  state.usage = usage(19)
  expect(await idleAt(3601)).not.toContain('/clear')
  state.usage = usage(30)
  expect(await idleAt(3480)).toContain('/compact') // cache about to go cold: compact while warm
  expect(await idleAt(3200)).not.toContain('/compact')
})

test('status line: the cache timer drains, then goes cold', async ($, on) => {
  const { idleAt } = await startLine($, on)
  expect(await idleAt(3570)).toContain('◔ 30s')
  expect(await idleAt(3601)).toContain('○ cold')
  expect(await idleAt(1200)).toContain('◕')
  expect(await idleAt(1920)).toContain('◑')
})

test('status line: a limit shows a forecast only when the pace runs out before the reset', async ($, on) => {
  const { state, idleAt } = await startLine($, on)
  const resetIn = (hours: number) => new Date(NOW + hours * 3600_000).toISOString()
  state.usage = usage(42, [{ kind: 'five_hour', percentUsed: 63, resetsAt: resetIn(4) }])
  expect(await idleAt(0)).toContain('full ')
  state.usage = usage(42, [{ kind: 'five_hour', percentUsed: 10, resetsAt: resetIn(4) }])
  expect(await idleAt(0)).not.toContain('full')
  state.usage = usage(42, [{ kind: 'five_hour', percentUsed: 63, resetsAt: resetIn(4.9) }]) // only 5 minutes in
  expect(await idleAt(0)).not.toContain('full')
  state.usage = usage(42, [{ kind: 'five_hour', percentUsed: 0, resetsAt: resetIn(4) }])
  expect(await idleAt(0)).not.toContain('full')
})

test('the ledger is credited once per gain, however often the line redraws', async ($, on) => {
  const caveman = (text: number) => [{ message: { role: 'user', content: 'CAVEMAN MODE ACTIVE' } },
    { message: { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(text * 4) }] } }]
  const { d, clock } = await startLine($, on, { files: { [TRANSCRIPT]: jsonl(caveman(100)) } })
  await clock.advance(5000) // many redraws, one credit: 100 reply tokens cut 65%, floored
  expect(JSON.parse(d.get(LEDGER)!).total).toBe(185)

  d.put(TRANSCRIPT, jsonl(caveman(200)))
  await clock.advance(3000)
  const ledger = JSON.parse(d.get(LEDGER)!)
  expect(ledger.total).toBe(371)
  expect(Object.values(ledger.days)).toEqual([371])
})

test('an older install\'s status line draws nothing; the pet follows /toggle pet', async ($, on) => {
  const { d, clock, shown } = await startLine($, on, {
    files: { [SETTINGS]: JSON.stringify({ statusLine: { command: '"py" "statusline.py" --pet' } }) },
  })
  expect(shown()).toBeUndefined()

  d.put(SETTINGS, '{}')
  await clock.advance(1000)
  expect(shown()!.replace(ANSI, '').split('\n')[0]).toMatch(/^[·✢✳✶✻✽] Opus/) // a spinner frame: the transcript was just written

  d.put('/h/.claude/.statusline-ctx/config.json', '{"pet": true}')
  await clock.advance(1000)
  expect(shown()!.split('\n')).toHaveLength(3)
})
