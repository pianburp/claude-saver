import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { disk } from './fakeio'

type On = Parameters<typeof mock.env>[0]

const SETTINGS = '/h/.claude/settings.json'
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v))

/** Home /h with these files; /saver-setup runs through the mod's command hook, as Claude would run it. */
function world(on: On, files: Record<string, string>) {
  mock.env(on, { HOME: '/h' })
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 5, 12) })
  const d = disk(on, files, () => clock.now())
  on('session.cwd', () => ({ value: '/proj' }))
  return d
}
const saverSetup = ($: Engine, args: string) => $.command.run({ command: 'saver-setup', args } as never).then(r => r.text!)

test('/saver-setup lists the settings it would change; the user\'s own values stay out of the list', async ($, on) => {
  world(on, { [SETTINGS]: JSON.stringify({ env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' } }) })
  const listed = await saverSetup($, '--orchestrate')
  expect(listed).toContain('+ model: "opusplan"')
  expect(listed).toContain('+ statusLine.refreshInterval: 1')
  expect(listed).not.toContain('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')
  expect(listed).toContain('Run /saver-setup --yes --orchestrate to apply.')
  expect(await saverSetup($, '')).not.toContain('opusplan')
})

test('an older install\'s status line, folder deny rules and saver.py hooks are dropped; the user\'s own stay', async ($, on) => {
  const d = world(on, {
    [SETTINGS]: JSON.stringify({
      statusLine: { type: 'command', command: '"py" "/c/statusline.py" --pet' },
      permissions: { deny: ['Read(**/node_modules/**)', 'Bash(rm:*)'] },
      hooks: {
        SessionStart: [{ matcher: 'startup|clear', hooks: [{ command: 'py "/c/saver.py" check' }, { command: 'mine.sh' }] }],
        PostToolUse: [{ matcher: 'Bash', hooks: [{ command: 'py "/c/saver.py" guard' }] }],
        PreToolUse: [{ matcher: 'Read', hooks: [{ command: 'py "/c/saver.py" secrets' }] }],
      },
    }),
  })
  const listed = await saverSetup($, '')
  expect(listed).toContain('~ statusLine.command')
  expect(listed).toContain('- permissions.deny: "Read(**/node_modules/**)"')
  expect(listed).toContain('+ permissions.deny: "Read(**/.env)"')
  expect(listed).toContain('- hooks.PreToolUse')
  expect(listed).not.toContain('Bash(rm:*)')
  expect(d.get(SETTINGS)).toContain('saver.py')

  d.put(SETTINGS, JSON.stringify({ statusLine: { command: 'my-line.sh' } }))
  expect(await saverSetup($, '')).not.toContain('statusLine')
})

test('--uninstall undoes an apply: the user\'s own settings come back as they were', async ($, on) => {
  const mine = { env: { FOO: '1', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' }, permissions: { deny: ['Bash(rm:*)'] },
    hooks: { SessionStart: [{ hooks: [{ command: 'mine.sh' }] }] } }
  const d = world(on, { [SETTINGS]: JSON.stringify(copy(mine)) })
  await saverSetup($, '--yes --orchestrate')
  expect(JSON.parse(d.get(SETTINGS)!).model).toBe('opusplan')

  await saverSetup($, '--yes --uninstall')
  expect(JSON.parse(d.get(SETTINGS)!)).toEqual(mine)
})

test('conflicts: standalone caveman skills and SessionStart hooks are named when plugins are installed', async ($, on) => {
  world(on, {
    [SETTINGS]: JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'python caveman-start.py' }] }] } }),
    '/h/.claude/skills/caveman/SKILL.md': 'mine',
    '/h/.claude/skills/savings/SKILL.md': 'my own',
  })
  const done = await saverSetup($, '--with-plugins --yes')
  expect(done).toContain('Warning: standalone skills in /h/.claude/skills: caveman. Delete them')
  expect(done).toContain('Warning: custom SessionStart hook: python caveman-start.py. Remove it, or the mode loads twice')
  expect(done).not.toContain('savings')
})

test('/saver-setup lists first, then applies: backup, old files removed, --pet carried over', async ($, on) => {
  const settings = JSON.stringify({ statusLine: { command: '"py" "/h/.claude/statusline.py" --pet' } })
  const d = world(on, {
    [SETTINGS]: settings,
    '/h/.claude/statusline.py': 'old',
    '/h/.claude/saver.py': 'old',
    '/h/.claude/skills/savings/SKILL.md': 'Run `py "saver.py" savings`',
    '/h/.claude/skills/pet/SKILL.md': 'my own pet skill',
  })
  const listed = await saverSetup($, '')
  expect(listed).toContain('~ statusLine.command')
  expect(listed).toContain('Run /saver-setup --yes to apply.')
  expect(d.get(SETTINGS)).toBe(settings)
  expect(await saverSetup($, '--bogus')).toContain('Unknown option')

  const done = await saverSetup($, '--yes')
  expect(done).toContain('Updated')
  expect(d.get(SETTINGS + '.bak')).toBe(settings)
  const now = JSON.parse(d.get(SETTINGS)!)
  expect(now.statusLine).toEqual({ type: 'command', command: 'sh "/h/.claude/.statusline-ctx/statusline.sh"', refreshInterval: 1 })
  expect(now.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('50')
  expect(JSON.parse(d.get('/h/.claude/.statusline-ctx/config.json')!)).toEqual({ pet: true })
  const removed = d.runs.map(r => r.at(-1)!.replace(/\\/g, '/'))
  expect(removed).toEqual(['/h/.claude/statusline.py', '/h/.claude/saver.py', '/h/.claude/skills/savings'])

  expect(await saverSetup($, '--yes --orchestrate')).toContain('/toggle route')
  expect(JSON.parse(d.get('/h/.claude/.statusline-ctx/config.json')!)).toEqual({ pet: true, route: true })
})
