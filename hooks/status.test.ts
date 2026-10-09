import { expect, test } from 'claude-code/testing'

import { fakeIo } from './fakeio'
import { BAR_WIDTH, BUSY_SECS, SPINNER, bar, feedLedger, fmtCache, fmtLimit, fmtReset, frame, plain, render } from './status'
import type { Input, State } from './status'

const BASE: Input = { model: 'Opus', effort: '', modes: [], rate: {}, ttl: 3600, lifetime: 0, pet: false, compactPct: 50 }
const text = (d: Partial<Input>, now = 1000, state: State = {}) => render({ ...BASE, ...d }, state, now).map(plain)

test('bar, cache timer and resets', () => {
  const cells = (pct: number) => bar(pct).map(s => s.text).join('').split('█').length - 1
  expect([cells(0), cells(5), cells(100)]).toEqual([0, 1, BAR_WIDTH])
  const cache = (idle: number | undefined) => fmtCache(idle, 0).map(s => s.text).join('')
  expect([cache(60), cache(3600 - 30), cache(3601), cache(undefined)]).toEqual(['● 59m', '◔ 30s', '○ cold', ''])
  expect([20, 32, 48].map(m => cache(m * 60)[0]).join('')).toBe('◕◑◔') // drains
  const now = Date.now() / 1000
  expect(fmtReset(now + 20 * 3600, now)).toContain(':')
  expect(fmtReset(now + 2 * 86400, now)).not.toContain(':')
})

test('limits: a forecast only when the pace runs out before the reset, and not too early', () => {
  const now = Date.now() / 1000
  const fl = (pct: number, opened: number) =>
    fmtLimit('5h', { used_percentage: pct, resets_at: now - opened + 5 * 3600 }, {}, now, 5 * 3600).map(s => s.text).join('')
  expect(fl(63, 3600)).toContain('full ' + fmtReset(now + 37 * 3600 / 63, now))
  expect(fl(10, 3600)).not.toContain('full')
  expect(fl(63, 300)).not.toContain('full')
  expect(fl(0, 3600)).not.toContain('full')
  const week = fmtLimit('7d', { used_percentage: 1, resets_at: now - 3600 + 7 * 86400 }, {}, now, 7 * 86400)
  expect(week.map(s => s.text).join('')).not.toContain('full')
})

test('render: spinner while busy, effort, line 2 order, /compact and /clear hints', () => {
  const busy = new Set(Array.from({ length: SPINNER.length }, (_, i) => text({ idle: 1 }, 1000 + i)[0]![0]))
  expect(busy).toEqual(new Set(SPINNER))
  expect(text({ idle: BUSY_SECS + 1 })[0]![0]).toBe('✻')
  expect(text({ effort: 'xhigh' })[0]).toBe('✻ Opus · xhi')
  expect(text({ effort: 'max' })[0]).toContain('max')
  const two = text({ idle: 60, rate: { seven_day: { used_percentage: 40 } } })[1]!
  expect(two.startsWith('⎿ 7d 40%')).toBe(true)
  expect(two.endsWith('● 59m')).toBe(true)
  expect(text({ ctx: 40 })[1]).toContain('/compact')
  expect(text({ ctx: 39 })[1]).not.toContain('/compact')
  expect(text({ ctx: 30, idle: 3601 })[1]).toContain('/handoff /clear')
  expect(text({ ctx: 19, idle: 3601 })[1]).not.toContain('/clear')
  expect(text({ ctx: 30, idle: 3600 - 120 })[1]).toContain('/compact') // cache about to go cold: compact while warm
  expect(text({ ctx: 30, idle: 3600 - 400 })[1]).not.toContain('/compact')
  expect(text({}, 1000, { saved_n: 1900 })[0]).toContain('saved ~1.9k')
})

test('the ledger is credited once per gain, however often the line redraws', async () => {
  const { io, fs } = fakeIo({}, { HOME: '/h' })
  const st: State = { saved_n: 100 }
  expect(await feedLedger(io, st, 1000)).toBe(100)
  expect(await feedLedger(io, st, 1001)).toBe(100)
  st.saved_n = 150
  expect(await feedLedger(io, st, 1002)).toBe(150)
  const ledger = JSON.parse(fs.get('/h/.claude/.statusline-ctx/ledger.json')!)
  expect(ledger.total).toBe(150)
  expect(Object.values(ledger.days)).toEqual([150])
  expect(ledger.born).toBe(1000)
})

test('frame: nothing while an older install draws; the pet follows /toggle pet', async () => {
  const { io, fs } = fakeIo({ '/h/.claude/settings.json': JSON.stringify({ statusLine: { command: '"py" "statusline.py" --pet' } }) }, { HOME: '/h' })
  expect(await frame(io, { id: 's1' }, 1_000_000)).toBeUndefined()
  fs.set('/h/.claude/settings.json', '{}')
  const rows = (await frame(io, { id: 's1' }, 1_000_000))!.map(plain)
  expect(rows[0]).toBe('✻ Opus')
  fs.set('/h/.claude/.statusline-ctx/config.json', '{"pet": true}')
  expect((await frame(io, { id: 's1' }, 1_000_000))!.length).toBe(3)
})
