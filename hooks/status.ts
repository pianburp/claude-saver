// The status line, ported from statusline.py and drawn by the mod into a per-session file.
//
// ✻ model · effort · active modes (ponytail, caveman) · saved · prompt cache
// ⎿ context · 5h limit · 7d limit (each with "full <time>" when the pace so far runs out before the reset)
//
// Tokens saved are credited to ~/.claude/.statusline-ctx/ledger.json (lifetime and per day) for /pet and /savings --week.
// With the pet on (/toggle pet), Clawd stands left of the lines on three rows and earns a sparkle per stage.
// Animates on the clock (one frame per second): ✻ spins while Claude works, rising values glow then fade,
// a low prompt cache breathes red.
import type { EnvName, Io } from './io'

import {
  PET_CRACK, PET_EGG, PET_STAGES, PET_WIDTH, claudeDir, ctxFile, detectTtl, fmt, isOn, isoDay, join,
  legacyStatusLine, lifetime, loadJson, petRows, read, savedRows, sessionStats, stat,
} from './saver'

import type { Seg } from '../types'

export type State = Record<string, unknown>
export type Row = Seg[]

// xterm-256 indexes, as the Python status line painted them; drawn as their hex.
const X = { CLAUDE: 173, GRAY: 246, WHITE: 255, DARK: 238, GREEN: 114, YELLOW: 179, RED: 167, PEACH: 223 }

/** xterm-256 index (16-255) to RGB. */
export function toRgb(c: number): [number, number, number] {
  if (c >= 232) { const v = 8 + 10 * (c - 232); return [v, v, v] }
  const L = [0, 95, 135, 175, 215, 255]
  c -= 16
  return [L[Math.floor(c / 36)]!, L[Math.floor(c / 6) % 6]!, L[c % 6]!]
}

const hex = (rgb: readonly number[]) => '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
const xhex = (c: number) => hex(toRgb(c))
const unhex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))

export const CLAUDE = xhex(X.CLAUDE)
export const GRAY = xhex(X.GRAY)
export const WHITE = xhex(X.WHITE)
export const DARK = xhex(X.DARK)
export const GREEN = xhex(X.GREEN)
export const YELLOW = xhex(X.YELLOW)
export const RED = xhex(X.RED)
export const PEACH = xhex(X.PEACH) // glow start; fades smoothly into the segment's own color
const PULSE = [X.RED, 131, 95, 131].map(xhex)

export const BAR_WIDTH = 6
export const SPINNER = '·✢✳✶✻✽✻✶✳✢' // forward then back, like Claude Code's own
export const GLOW_SECS = 15
const ROLL_SECS = 3 // a rising number counts up from its old value over this long
export const BUSY_SECS = 10
const CLEAR_PCT = 20 // cold cache past this much context: the next message re-bills it all, /clear is cheaper
const PIE = '○◔◑◕●' // cache timer: drains as the cache runs down, empty once cold
const EFFORT: Record<string, string> = { low: 'lo', medium: 'med', high: 'hi', xhigh: 'xhi' }
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/
const PET_BLINK = 7 // Clawd blinks once every this many seconds

// No undefined keys: plugin state holds plain JSON.
const seg = (text: string, color?: string, bold?: boolean): Seg => ({ text, ...(color && { color }), ...(bold && { bold }) })
const label = (text: string) => seg(text, GRAY)
const SEP = seg(' · ', DARK)

export const levelColor = (pct: number) => (pct < 50 ? GREEN : pct < 80 ? YELLOW : RED)

/** Serialize status rows for Claude Code's command statusLine. */
export function ansi(rows: readonly Row[], noColor: boolean): string {
  return rows.map(row => row.map(s => {
    if (noColor) return s.text
    const rgb = s.color ? unhex(s.color) : undefined
    const color = rgb ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : ''
    const bold = s.bold ? '\x1b[1m' : ''
    return `${color}${bold}${s.text}\x1b[0m`
  }).join('')).join('\n')
}

function toPct(value: unknown) {
  const n = Number(value)
  return value === null || value === undefined || value === '' || isNaN(n) ? undefined : Math.max(0, Math.min(100, n))
}

/** PEACH blended into base as age goes 0 to GLOW_SECS; base once there is no change. */
export function glow(age: number | undefined, base: string) {
  if (age === undefined || age >= GLOW_SECS) return base
  const w = 1 - Math.max(0, age) / GLOW_SECS
  const [a, b] = [unhex(PEACH), unhex(base)]
  return hex(a.map((v, i) => w * v + (1 - w) * b[i]!))
}

/** Cells from glowFrom up to the fill edge glow, fading with age. */
export function bar(pct: number, glowFrom?: number, age?: number): Seg[] {
  const filled = Math.ceil(pct / 100 * BAR_WIDTH)
  const color = pct < 50 ? CLAUDE : levelColor(pct)
  const start = glowFrom === undefined ? filled : Math.min(glowFrom, filled)
  return [seg('█'.repeat(start), color), seg('█'.repeat(filled - start), glow(age, color)), seg('░'.repeat(BAR_WIDTH - filled), DARK)]
}

/** [value before the last change, its age in seconds] while under GLOW_SECS old, else undefined. */
export function track(state: State, key: string, value: unknown, now: number): [unknown, number] | undefined {
  const prev = state[key]
  let [old, cur, at] = Array.isArray(prev) && prev.length === 3 ? prev as [unknown, unknown, number] : [value, value, 0]
  if (JSON.stringify(value) !== JSON.stringify(cur)) [old, cur, at] = [cur, value, now] // first sight: no glow
  state[key] = [old, cur, at]
  return JSON.stringify(old) !== JSON.stringify(cur) && now - at < GLOW_SECS ? [old, now - at] : undefined
}

/** [value to show, age of the rise]: counts up from the old value over ROLL_SECS. Drops show at once. */
export function rose(state: State, key: string, value: number, now: number): [number, number | undefined] {
  const hit = track(state, key, value, now)
  if (!hit || (hit[0] as number) >= value) return [value, undefined]
  const [old, age] = hit as [number, number]
  return [old + (value - old) * Math.min(1, age / ROLL_SECS), age]
}

/** '4:32p' when under 24h away, 'Fri' otherwise. */
export function fmtReset(epoch: number, now: number) {
  if (!isFinite(epoch)) return ''
  const dt = new Date(epoch * 1000)
  if (0 <= epoch - now && epoch - now < 24 * 3600)
    return `${dt.getHours() % 12 || 12}:${String(dt.getMinutes()).padStart(2, '0')}${dt.getHours() < 12 ? 'a' : 'p'}`
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()]!
}

export type Window = { used_percentage?: number; resets_at?: number }

/** '5h 63% 4:32p', plus 'full 3:10p' when the pace so far hits 100% before the reset. */
export function fmtLimit(name: string, window: Window | undefined, state: State, now: number, span: number): Seg[] {
  const pct = toPct(window?.used_percentage)
  if (pct === undefined) return []
  const [shown, age] = rose(state, name, Math.round(pct), now)
  const out = [label(name), seg(' '), seg(`${shown.toFixed(0)}%`, glow(age, levelColor(pct)))]
  const resets = Number(window?.resets_at)
  const reset = window?.resets_at === undefined ? '' : fmtReset(resets, now)
  if (reset) {
    out.push(seg(' '), label(reset))
    // shortcut: average pace since the window opened, not the last few minutes; sample pct in state if it lags
    const elapsed = now - (resets - span)
    // A tenth of the window (30m of 5h, ~17h of 7d): earlier, one rounded percent swings the forecast by days
    if (elapsed >= span / 10 && pct > 0) {
      const full = now + (100 - pct) * elapsed / pct
      if (full < resets) out.push(seg(' '), seg('full ' + fmtReset(full, now), RED))
    }
  }
  return out
}

/** Time left on the prompt cache, behind a pie that drains with it. Gray, then its last 5 minutes breathe through PULSE. */
export function fmtCache(idle: number | undefined, frame: number, ttl = 3600): Seg[] {
  if (idle === undefined) return []
  const left = ttl - idle
  if (left < 1) return [seg(PIE[0] + ' cold', RED)]
  const m = Math.floor(left / 60)
  const s = Math.floor(left) % 60
  const pie = PIE[Math.min(4, Math.max(1, Math.ceil(left / ttl * 4)))]
  return [seg(m ? `${pie} ${m}m` : `${pie} ${s}s`, left > 300 ? GRAY : PULSE[frame % PULSE.length])]
}

/** Clawd's three rows: eyes, arms and color from the session's signals; glows when it grows a stage. */
export function fmtPet(state: State, total: number, now: number, frame: number, idle: number | undefined, left: number,
  bloated: boolean): Seg[] {
  const stage = PET_STAGES.find(s => total >= s[0])
  const hit = track(state, 'pet_stage', stage ? stage[0] : 0, now)
  const grew = hit?.[1]
  const busy = idle !== undefined && idle < BUSY_SECS
  const paint = (rows: readonly string[], color: string) => rows.map(r => seg(r.padEnd(PET_WIDTH), glow(grew, color)))
  if (!stage) // rocks while Claude works
    return paint(PET_EGG[total >= PET_CRACK ? 1 : 0].map(r => (busy && frame % 2 ? ' ' : '') + r), CLAUDE)
  let [eyes, armsUp, wear, color] = ['▛▜', false, undefined as string | undefined, CLAUDE]
  const noisy = Number(state.noisy_n) || 0
  const sick = track(state, 'noisy', noisy, now)
  if (sick && (sick[0] as number) < noisy) [eyes, color] = ['▚▞', RED] // a 2k+ token tool output just landed
  else if (idle !== undefined && left <= 0) [eyes, wear, color] = ['▀▀', ' z', GRAY] // asleep
  else if (bloated) color = RED
  else if (idle !== undefined && left <= 300) color = PULSE[frame % PULSE.length]!
  else if (busy) armsUp = frame % 2 === 1 // waves while Claude works
  if (eyes === '▛▜' && idle !== undefined && Math.floor(idle) % PET_BLINK === PET_BLINK - 1) eyes = '▀▀' // blink
  return paint(petRows(stage, eyes, wear, armsUp), color)
}

function fmtModes(modes: [string, string][], age: number | undefined): Seg[] {
  return modes.flatMap(([name, level], i) => [
    ...(i ? [seg(' + ', DARK)] : []),
    seg(name, glow(age, GRAY)),
    ...(level ? [seg(' '), seg(level, glow(age, WHITE))] : []),
  ])
}

/** What the status line shows, gathered from the session. */
export type Input = {
  model: string
  effort: string
  modes: [string, string][]
  ctx?: number
  rate: { five_hour?: Window; seven_day?: Window }
  idle?: number // seconds since the transcript was last written
  ttl: number
  lifetime: number
  pet: boolean
  compactPct: number
}

/** `claude-opus-5-5[1m]` to `Opus 5.5 (1M)`; an alias or unknown id is shown as is. */
export function modelName(id: string) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(id)
  if (!m) return id
  const [, family, major, minor, long] = m
  return `${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor ? '.' + minor : ''}${long ? ' (1M)' : ''}`
}

/** The status line as rows of colored runs; state carries the glows between frames. */
export function render(d: Input, state: State, now: number): Row[] {
  // Frames follow the clock, not the redraw count.
  const frame = Math.floor(now)
  const { idle, ttl, ctx } = d
  const busy = idle !== undefined && idle < BUSY_SECS // transcript written recently: Claude is working
  const star = busy ? SPINNER[frame % SPINNER.length] : '✻'
  const modesHit = track(state, 'modes', d.modes, now)
  const saved = Number(state.saved_n) || 0
  const [savedShown, savedAge] = saved ? rose(state, 'saved', saved, now) : [0, undefined]
  const line1: Seg[][] = [
    [seg(`${star} ${modelName(d.model) || 'Claude'}`, CLAUDE, true)],
    d.effort ? [seg(EFFORT[d.effort] ?? d.effort, GRAY)] : [],
    fmtModes(d.modes, modesHit?.[1]),
    saved ? [label('saved '), seg('~' + fmt(savedShown), glow(savedAge, GREEN))] : [],
  ]

  const left = idle !== undefined ? ttl - idle : ttl
  const clawd = d.pet ? fmtPet(state, d.lifetime, now, frame, idle, left, ctx !== undefined && ctx >= d.compactPct - 10) : undefined
  const ctxPart: Seg[] = []
  if (ctx !== undefined) {
    const cells = Math.ceil(ctx / 100 * BAR_WIDTH)
    const hit = track(state, 'ctx', cells, now)
    const [glowFrom, age] = hit && (hit[0] as number) < cells ? hit as [number, number] : [undefined, undefined]
    const [shown] = rose(state, 'ctx_pct', Math.round(ctx), now)
    ctxPart.push(label('ctx '), ...bar(ctx, glowFrom, age), seg(' '), seg(`${shown.toFixed(0)}%`, levelColor(ctx)))
    // 10 points before auto-compact: compact by hand at a clean break instead of mid-task.
    // Also when the cache is about to expire: compacting while warm costs a fraction of re-billing it cold.
    if (left <= 0 && ctx >= CLEAR_PCT) ctxPart.push(seg(' '), seg('/handoff /clear', YELLOW))
    else if (ctx >= d.compactPct - 10 || (left <= Math.min(300, ttl / 6) && idle !== undefined && idle >= BUSY_SECS && ctx >= CLEAR_PCT))
      ctxPart.push(seg(' '), seg('/compact', YELLOW))
  }
  const line2 = [
    ctxPart,
    fmtLimit('5h', d.rate.five_hour, state, now, 5 * 3600),
    fmtLimit('7d', d.rate.seven_day, state, now, 7 * 86400),
    fmtCache(idle, frame, ttl),
  ]

  const joined = (parts: Seg[][]) => parts.filter(p => p.length).flatMap((p, i) => (i ? [SEP, ...p] : p))
  const top = joined(line1)
  const bottom = joined(line2)
  const lines: Row[] = [top, ...(bottom.length ? [[seg('⎿ ', DARK), ...bottom]] : [])]
  return clawd ? clawd.map((cell, i) => [cell, ...(lines[i] ?? [])]) : lines
}

/** A row as plain text, for tests and the screen reader. */
export const plain = (row: Row) => row.map(s => s.text).join('')

// ---------- what render() reads, gathered through the engine ----------

async function readFlag(io: Io, path: string) {
  const st = await stat(io, path)
  if (!st || st.isLink || st.size > 64) return undefined
  const mode = ((await read(io, path)) ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
  return mode && mode !== 'off' ? mode : undefined
}

/** [name, level] for active modes; level is "" for caveman's default. */
export async function readModes(io: Io, sessionId: string | undefined): Promise<[string, string][]> {
  const dir = await claudeDir(io)
  const modes: [string, string][] = []
  const pony = await readFlag(io, join(dir, '.ponytail-active'))
  if (pony) modes.push(['pony', pony])
  // Per-session caveman flag wins over the machine-wide mirror.
  const cavePaths = [join(dir, '.caveman-active')]
  if (sessionId && SESSION_RE.test(sessionId)) cavePaths.unshift(join(dir, '.caveman-sessions', sessionId + '.mode'))
  for (const path of cavePaths)
    if (await stat(io, path)) {
      const cave = await readFlag(io, path)
      if (cave) modes.push(['cave', cave === 'caveman' ? '' : cave])
      return modes
    }
  // Skill-only caveman (npx skills add) writes no flag; say so instead of showing nothing.
  if ((await stat(io, join(dir, 'skills', 'caveman')))?.kind === 'dir') modes.push(['cave', 'no plugin'])
  return modes
}

/** Project local > project > user settings, per model first. */
export async function readEffort(io: Io, cwd: string, model: string) {
  for (const path of [join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json'), join(await claudeDir(io), 'settings.json')]) {
    const cfg = await loadJson(io, path)
    const perModel = (((cfg.modelSettings ?? {}) as Record<string, Record<string, unknown>>)[model] ?? {}).effortLevel
    const value = perModel || cfg.effortLevel
    if (typeof value === 'string' && value) return value.toLowerCase()
  }
  return ''
}

/** Credit this session's new savings to ledger.json (lifetime and today); return the lifetime total. */
export async function feedLedger(io: Io, state: State, now: number) {
  const path = await ctxFile(io, 'ledger.json') // the dot file name keeps it apart from session ids
  const data = await loadJson(io, path)
  let total = lifetime(data)
  const n = Number(state.saved_n) || 0
  const fed = Number(state.ledger_fed) || 0
  if (n !== fed) {
    state.ledger_fed = n
    if (n > fed) {
      // shortcut: read-modify-write, two sessions saving in the same instant can drop one gain; lock if it matters
      const days = data.days && typeof data.days === 'object' ? { ...(data.days as Record<string, number>) } : {}
      const day = isoDay(new Date(now * 1000))
      days[day] = (days[day] || 0) + n - fed
      total += n - fed
      const kept = Object.fromEntries(Object.entries(days).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-60))
      await io.write(path, JSON.stringify({ total, born: data.born || now, days: kept }))
    }
  }
  return total
}

/** One session's status line: the transcript it reads and the glow state it keeps between frames. */
export type Session = { transcript?: string; id?: string; state?: State; saved?: string; ttl?: number }

const envNumber = async (io: Io, name: EnvName) => {
  const raw = await io.env(name)
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
  return isNaN(n) ? undefined : n
}

/** The status line's rows for this frame, or undefined while an older install's settings.json status line still draws. */
export async function frame(io: Io, sess: Session, nowMs: number): Promise<Row[] | undefined> {
  if (await legacyStatusLine(io)) return undefined
  const now = nowMs / 1000
  const statePath = sess.id && SESSION_RE.test(sess.id) ? await ctxFile(io, sess.id) : undefined
  sess.state ??= statePath ? await loadJson(io, statePath) : {}
  const state = sess.state
  const before = JSON.stringify(state)

  const st = sess.transcript ? await stat(io, sess.transcript) : undefined
  const idle = st ? now - st.mtimeMs / 1000 : undefined
  if (st && sess.saved !== `${st.mtimeMs}:${st.size}`) {
    // Re-parsed only when the transcript changes.
    try {
      const stats = await sessionStats(io, sess.transcript!)
      state.saved_n = Math.floor(savedRows(stats).reduce((t, r) => t + r[1], 0))
      state.noisy_n = stats.noisy_count
    } catch {
      state.saved_n = state.noisy_n = 0
    }
    sess.ttl = detectTtl(await read(io, sess.transcript!))
    sess.saved = `${st.mtimeMs}:${st.size}`
  }
  const usage = await io.usage().catch(() => undefined)
  const limit = (kind: string): Window | undefined => {
    const r = usage?.rateLimits.find(l => l.kind === kind)
    return r && { used_percentage: r.percentUsed, resets_at: r.resetsAt ? Date.parse(r.resetsAt) / 1000 : undefined }
  }
  const model = await io.model().catch(() => '')
  const cwd = await io.cwd()
  const ttlEnv = await envNumber(io, 'CLAUDE_CACHE_TTL')
  const rows = render({
    model,
    effort: await readEffort(io, cwd, model),
    modes: await readModes(io, sess.id),
    ctx: toPct(usage?.context.percent),
    rate: { five_hour: limit('five_hour'), seven_day: limit('seven_day') },
    idle,
    ttl: ttlEnv !== undefined ? Math.max(1, Math.floor(ttlEnv)) : (idle !== undefined && sess.ttl) || 3600,
    lifetime: statePath ? await feedLedger(io, state, now) : 0,
    pet: await isOn(io, 'pet'),
    // Same variable Claude Code reads to auto-compact early; /saver-setup sets it to 50.
    compactPct: (await envNumber(io, 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')) ?? 50,
  }, state, now)
  if (statePath && JSON.stringify(state) !== before) await io.write(statePath, JSON.stringify(state))
  return rows
}
