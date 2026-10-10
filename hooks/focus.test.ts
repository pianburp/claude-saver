import type { RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { STEPS_TOOL } from './focus'

const TODOS = [
  { content: 'Pick the page style', status: 'completed', activeForm: 'Picking' },
  { content: 'Check live weather', status: 'in_progress', activeForm: 'Checking' },
  { content: 'Build the dashboard', status: 'pending', activeForm: 'Building' },
  { content: 'Publish it', status: 'pending', activeForm: 'Publishing' },
] as const

// The engine's own row, as the bottom of the ui.render chain draws it.
const engineDraws = (on: Parameters<typeof mock.env>[0]) =>
  on('ui.render', ($, e) => h($.ui.resolve(e).Text, {}, 'engine row') as RenderElement)

// The band above the prompt, and one Bash tool row.
const band = ($: Engine, isWorking = true) => $.ui.mount({ plugin: 'ctx-saver', surface: 'terminal',
  component: 'AbovePrompt', props: { hasSurvey: false, isWorking, maxRows: 20, bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19, contentRows: 0 }, view: {} } as never })
const toolRow = ($: Engine) => $.ui.mount({ plugin: 'ctx-saver', surface: 'terminal', component: 'ToolUse',
  requestId: 'u1', props: { tool_use_id: 'u1', tool: 'Bash', input: { command: 'ls' },
    isRunning: false, isErrored: false, isInterrupted: false } })

const quiet = (on: Parameters<typeof mock.env>[0]) => {
  mock.env(on, { HOME: '/home/u' })
  on('fs.read', () => ({ deny: 'ENOENT' })) // no config.json: every switch on
  const clock = mock.clock(on, { now: 1_000 })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  engineDraws(on)
  return clock
}

test('focus hides tool rows and in-between text, keeps the answer', async ($, on) => {
  quiet(on)
  await $.turn.start({ text: 'Build a weather dashboard', turnId: 't1' })
  const row = await toolRow($)
  expect((await row.find({ type: 'Box' }))?.props).toMatchObject({ display: 'none' })

  const say = (text: string) => $.ui.mount({ plugin: 'ctx-saver', surface: 'terminal', component: 'AssistantMessage',
    requestId: text, props: { text, isFirstOfReply: true } })
  expect((await (await say('Let me look around.')).find({ type: 'Box' }))?.props).toMatchObject({ display: 'none' })
  await $.turn.complete({ answer: 'All set: the page is live.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await (await say('All set: the page is live.')).find({ text: 'engine row' })).toBeDefined()
})

test('a task with no steps still keeps the one-line summary', async ($, on) => {
  quiet(on)
  await $.turn.start({ text: 'Answer a question', turnId: 't1' })
  await $.turn.complete({ answer: 'Yes.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const ui = await band($, false)
  expect(await ui.find({ text: 'Answer a question' })).toBeDefined()
  expect(await ui.find({ text: /done|steps/ })).toBeUndefined()
  expect(await ui.find({ text: 'engine row' })).toBeUndefined()
})

test('TodoWrite steps fill the band; finishing them clears it, stopping short keeps it', async ($, on) => {
  const clock = quiet(on)
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  on('tool.call', { tool: 'Read' }, () => ({ result: {} }))
  await $.turn.start({ text: 'Build a weather dashboard', turnId: 't1' })
  let ui = await band($)
  expect(await ui.find({ text: 'planning' })).toBeDefined()
  expect(await ui.find({ text: /%/ })).toBeUndefined()

  // No steps yet but Claude reads a file: the band says so, not "planning".
  await $.tool.call({ tool: 'Read', file_path: 'C:\\app\\README.md' })
  ui = await band($)
  expect(await ui.find({ text: 'reading README.md' })).toBeDefined()
  expect(await ui.find({ text: 'planning' })).toBeUndefined()

  // Step 1 runs 4s with nothing timed yet: no bar, no percent.
  await $.tool.call({ tool: 'TodoWrite', todos: TODOS.map((t, i) => ({ ...t, status: i ? 'pending' as const : 'in_progress' as const })) })
  await clock.advance(4_000)
  ui = await band($)
  expect(await ui.find({ text: 'step 1 of 4' })).toBeDefined()
  expect(await ui.find({ text: /%/ })).toBeUndefined()

  await $.tool.call({ tool: 'TodoWrite', todos: [...TODOS] })
  await clock.advance(1_800)
  ui = await band($)
  expect(await ui.find({ text: 'step 2 of 4' })).toBeDefined()
  expect(await ui.find({ text: /\b45%/ })).toBeDefined() // step 2 at 1.8s of step 1's 4s

  await $.tool.call({ tool: 'TodoWrite', todos: TODOS.map(t => ({ ...t, status: 'completed' as const })) })
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(5_000)
  ui = await band($)
  expect(await ui.find({ text: '4 of 4 steps' })).toBeDefined() // one line kept
  expect(await ui.find({ text: /done/ })).toBeUndefined() // Claude's own line says it
  expect(await ui.find({ text: 'Pick the page style' })).toBeUndefined() // steps hidden once done
  expect(await ui.find({ text: /^\d+s$/ })).toBeUndefined() // no clock: Claude's spinner shows it

  // Esc after step 2: the band stays with the steps left.
  await $.turn.start({ text: 'Build it again', turnId: 't2' })
  await $.tool.call({ tool: 'TodoWrite', todos: [...TODOS] })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'answer' })
  ui = await band($)
  expect(await ui.find({ text: 'stopped at 1 of 4' })).toBeDefined()
  expect(await ui.find({ text: 'Publish it' })).toBeDefined()
})

test('the step gate refuses the first change once, and not after steps exist', async ($, on) => {
  quiet(on)
  let edits = 0
  on('tool.call', { tool: 'Edit' }, () => { edits++; return { result: {} } })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  const edit = () => $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' })

  await $.turn.start({ text: 'Fix the bug', turnId: 't1' })
  expect((await $.tool.call({ tool: 'Bash', command: 'cd app && grep -rn foo src' })).deny).toBeUndefined() // reads pass
  expect((await edit()).deny).toContain('write your steps first')
  expect((await edit()).deny).toBeUndefined() // once only: a missing step tool never stalls Claude
  expect(edits).toBe(1)

  await $.turn.start({ text: 'Fix another bug', turnId: 't2' })
  await $.tool.call({ tool: STEPS_TOOL, steps: [{ text: 'Fix it', status: 'in_progress' }] } as never)
  expect((await edit()).deny).toBeUndefined() // steps exist: no refusal
})

test('the steps tool fills the band and rejects a bad list', async ($, on) => {
  quiet(on)
  await $.turn.start({ text: 'Build a weather dashboard', turnId: 't1' })
  const bad = await $.tool.call({ tool: STEPS_TOOL, steps: [{ text: 'x', status: 'done' }] } as never)
  expect(bad.deny).toContain('steps:')
  const ok = await $.tool.call({ tool: STEPS_TOOL, steps: [
    { text: 'Check live weather', status: 'completed' }, { text: 'Build the page', status: 'in_progress' }] } as never)
  expect(ok.result).toBe('Showing 2 steps to the user.')
  const ui = await band($)
  expect(await ui.find({ text: 'step 2 of 2' })).toBeDefined()
  expect(await ui.find({ text: 'Build the page' })).toBeDefined()
})

test('focus registers its steps tool only when the session has no task tool', async ($, on) => {
  quiet(on)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  let tools = ['Read', 'Edit']
  const registered: string[] = []
  on('tool.list', () => ({ value: tools.map(name => ({ name })) as never }))
  on('tool.register', (_$, e) => { registered.push(e.name); return { value: { tool: `mcp__ctx-saver__${e.name}` } } })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['steps'])
  tools = ['Read', 'TaskCreate']
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['steps'])
})

const SPAWN = { tool_use_id: 'u9', prompt: 'p', description: 'Find the focus code', subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false } as never

test('subagents get band rows and never touch the main steps or the step gate', async ($, on) => {
  quiet(on)
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'inherit', agentId: 'a1' }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  on('tool.call', { tool: /^(Read|Edit)$/ }, () => ({ result: {} }))
  await $.turn.start({ text: 'Map the code', turnId: 't1' })
  await $.tool.call({ tool: 'TodoWrite', todos: [...TODOS] })
  await $.agent.spawn(SPAWN)

  // The subagent's own list, read and edit: its row changes, the main steps and gate do not.
  await $.tool.call({ tool: 'TodoWrite', agentId: 'a1', todos: [{ content: 'Sub step', status: 'in_progress', activeForm: 'x' }] } as never)
  await $.tool.call({ tool: STEPS_TOOL, agentId: 'a1', steps: [{ text: 'Sub tool step', status: 'in_progress' }] } as never)
  await $.tool.call({ tool: 'Read', agentId: 'a1', file_path: 'C:\\app\\focus.ts' } as never)
  let ui = await band($)
  expect(await ui.find({ text: 'step 2 of 4' })).toBeDefined()
  expect(await ui.find({ text: /Sub/ })).toBeUndefined()
  expect(await ui.find({ text: /Explore/ })).toBeDefined()
  expect(await ui.find({ text: /Find the focus code/ })).toBeDefined()
  expect(await ui.find({ text: /reading focus\.ts/ })).toBeDefined()

  await $.turn.complete({ answer: 'found', durationMs: 1, isAborted: false, turnId: 's1', reason: 'answer', agentId: 'a1' } as never)
  ui = await band($)
  expect(await ui.find({ text: '✓ ' })).toBeDefined()
  expect(await ui.find({ text: /reading/ })).toBeUndefined()
})

test('a subagent edit before main steps is not refused', async ($, on) => {
  quiet(on)
  on('agent.spawn', () => ({ model: 'inherit', agentId: 'a1' }))
  on('tool.call', { tool: 'Edit' }, () => ({ result: {} }))
  await $.turn.start({ text: 'Fix it', turnId: 't1' })
  await $.agent.spawn(SPAWN)
  const ran = await $.tool.call({ tool: 'Edit', agentId: 'a1', file_path: 'a.ts', old_string: 'a', new_string: 'b' } as never)
  expect(ran.deny).toBeUndefined()
  expect(await (await band($)).find({ text: '1 agent running' })).toBeDefined()
})

test('/toggle route: off by default, read-only types to Haiku when on', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  let cfg = '{}'
  on('fs.read', (_$, e) => (e.path.endsWith('config.json') ? { value: cfg } : { deny: 'ENOENT' }))
  mock.clock(on)
  const asked: (string | undefined)[] = []
  on('agent.spawn', (_$, e) => { asked.push(e.model); return { model: e.model ?? 'inherit', agentId: 'a' } })
  await $.agent.spawn(SPAWN)
  cfg = '{"route": true}'
  await $.agent.spawn(SPAWN)
  await $.agent.spawn({ ...(SPAWN as object), subagentType: 'general-purpose' } as never)
  await $.agent.spawn({ ...(SPAWN as object), model: 'sonnet' } as never)
  await $.agent.spawn({ ...(SPAWN as object), subagentType: 'caveman:cavecrew-investigator' } as never)
  await $.agent.spawn({ ...(SPAWN as object), model: 'opus' } as never) // an explicit model is kept
  expect(asked).toEqual([undefined, 'haiku', undefined, 'sonnet', 'haiku', 'opus'])
})

test('more than four subagents: the band draws four and counts the rest', async ($, on) => {
  quiet(on)
  let n = 0
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'inherit', agentId: `a${n++}` }))
  await $.turn.start({ text: 'Map the code', turnId: 't1' })
  for (let i = 0; i < 6; i++) await $.agent.spawn({ ...(SPAWN as object), tool_use_id: `u${i}`, description: `Task ${i}` } as never)
  const ui = await band($)
  expect(await ui.find({ text: /\+2 more/ })).toBeDefined()
  expect(await ui.find({ text: /Task 3/ })).toBeDefined()
  expect(await ui.find({ text: /Task 4/ })).toBeUndefined()
})

test('the step gate lets reads through and refuses a shell write, as it refuses an edit', async ($, on) => {
  quiet(on)
  on('tool.call', { tool: /^(Bash|PowerShell|Read)$/ }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.turn.start({ text: 'Look around', turnId: 't1' })
  expect((await $.tool.call({ tool: 'Bash', command: 'cd app && ls | grep x' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'PowerShell', command: 'Get-ChildItem src' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: 'a.ts' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'npm test' })).deny).toContain('write your steps first')
})

test('/toggle focus off shows the tool rows again', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  on('fs.read', (_$, e) => (e.path.endsWith('config.json') ? { value: '{"focus": false}' } : { deny: 'ENOENT' }))
  mock.clock(on)
  engineDraws(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'x', turnId: 't1' })
  const row = await toolRow($)
  expect(await row.find({ text: 'engine row' })).toBeDefined()
})
