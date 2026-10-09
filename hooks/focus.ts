// Focus mode's pure parts; its hooks live in register.tsx, since $ never crosses an import.
import type { Step } from '../types'

/** Asks Claude to keep the step list the focus band draws, and to end on a short summary. */
export const FOCUS_PROMPT = {
  id: 'ctx-saver:focus',
  scope: 'session',
  text: 'Focus mode is on: the user does not see your tool calls or the text you write between them, only a ' +
    'step list with a timer and your final message. In the main conversation (not as a subagent), for any task ' +
    'that needs more than one tool call, first write 3 to 6 steps with TaskCreate (or TodoWrite, or the ctx-saver ' +
    'steps tool when you have neither), each in plain words someone who does not code understands, like "Check how ' +
    'the page gets live weather". Your first edit or command is refused until the steps exist. Keep exactly one ' +
    'step in_progress and, as soon as it is done, mark it completed and the next one in_progress in the same ' +
    'update: one step at a time, never several at the end. End with a short plain summary: what you ' +
    'did, where to find it, and anything the user must check.',
} as const

/** The step tool the mod adds when the session has no TaskCreate or TodoWrite; Claude calls it as STEPS_TOOL. */
export const STEPS_SPEC = {
  name: 'steps',
  description: 'Focus mode: show the user your step list. Send the whole list each time, in order, with exactly ' +
    'one step in_progress while you work.',
  inputSchema: {
    type: 'object',
    required: ['steps'],
    properties: { steps: { type: 'array', items: { type: 'object', required: ['text', 'status'], properties: {
      text: { type: 'string' }, status: { enum: ['pending', 'in_progress', 'completed'] } } } } },
  },
  isDeferred: false, // in the prompt's tool list, so Claude sees it without ToolSearch
} as const
export const STEPS_TOOL = 'mcp__ctx-saver__steps'

/** The steps tool's input as band steps, or undefined when it is not a list of { text, status }. */
export function parseSteps(input: unknown): Step[] | undefined {
  const steps = (input as { steps?: unknown } | undefined)?.steps
  if (!Array.isArray(steps)) return undefined
  const ok = steps.every(s => typeof s?.text === 'string' && ['pending', 'in_progress', 'completed'].includes(s?.status))
  return ok ? steps.map((s, i) => ({ id: String(i), text: s.text, status: s.status })) : undefined
}

/** The last tool call in plain words, for the band while there are no steps: "editing README.md". */
export function activity(tool: string, input: Record<string, unknown>) {
  const file = String(input.file_path ?? input.notebook_path ?? '').split(/[\\/]/).pop()
  const on = (verb: string) => (file ? `${verb} ${file}` : verb)
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return on('editing')
  if (tool === 'Read') return on('reading')
  if (/^(Grep|Glob)$/.test(tool)) return 'searching'
  if (/^(Bash|PowerShell)$/.test(tool)) return 'running a command'
  if (/^(WebFetch|WebSearch)$/.test(tool)) return 'looking online'
  if (/^(Agent|Task)$/.test(tool)) return 'handing off a part'
  return 'working'
}

/** Whether a transcript block is part of a turn's final answer (else it is text between tool calls). */
export function isAnswer(text: string, done: readonly string[]) {
  // shortcut: matches on the block's first 80 normalized chars; a markdown-heavy answer the engine reflows could miss
  const norm = (s: string) => s.replace(/[\s*_`#>]+/g, ' ').trim()
  const head = norm(text).slice(0, 80)
  return head === '' || done.some(a => norm(a).includes(head))
}

/** Carries each step's `since` and `took` over from the last list (by id) and stamps the ones that just started or finished. */
export function stamp(prev: readonly Step[], steps: readonly Step[], t: number): Step[] {
  return steps.map(s => {
    const old = prev.find(o => o.id === s.id)
    const since = old?.since ?? (s.status === 'in_progress' ? t : undefined)
    const took = s.status !== 'completed' ? undefined : old?.took ?? (since === undefined ? undefined : t - since)
    return { ...s, since, took }
  })
}

/**
 * How far the step in progress is, 0 to 0.9: its time so far against the steps already timed.
 * Undefined until one step is timed (the row shows no bar then).
 */
// shortcut: an estimate from past steps' pace, so a long step parks at 90%; upgrade if TodoWrite ever carries progress
export function stepFraction(steps: readonly Step[], s: Step | undefined, t: number) {
  const timed = steps.flatMap(x => (x.took ? [x.took] : []))
  if (s?.status !== 'in_progress' || s.since === undefined || !timed.length) return undefined
  return Math.min(0.9, (t - s.since) / (timed.reduce((a, b) => a + b, 0) / timed.length))
}

/** A step row's state: Done, Working, Next or Up next. */
export function stepLabel(steps: readonly Step[], i: number) {
  const s = steps[i]
  if (s?.status === 'completed') return 'Done'
  if (s?.status === 'in_progress') return 'Working'
  return i === steps.findIndex(x => x.status === 'pending') ? 'Next' : 'Up next'
}
