import { expect, test } from 'claude-code/testing'

import { fakeIo } from './fakeio'
import { DENY_READS, applySettings, changes, conflicts, removeSettings, setup } from './setup'

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v))

test('applySettings keeps the user\'s values and adds only what was asked', () => {
  const st = applySettings({ env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' } }, ['--orchestrate'])
  expect(st.env).toEqual({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70', CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' })
  expect(st.model).toBe('opusplan')
  expect('statusLine' in st).toBe(false)
  expect('model' in applySettings({}, [])).toBe(false)
  expect(applySettings({}, ['--all']).enabledPlugins).toEqual({ 'ponytail@ponytail': true, 'caveman@caveman': true })
  expect('enabledPlugins' in applySettings({}, [])).toBe(false)
})

test('an older install\'s status line, folder deny rules and saver.py hooks are dropped; the user\'s own stay', () => {
  const old = {
    statusLine: { type: 'command', command: '"py" "/c/statusline.py" --pet' },
    permissions: { deny: ['Read(**/node_modules/**)', 'Bash(rm:*)'] },
    hooks: {
      SessionStart: [{ matcher: 'startup|clear', hooks: [{ command: 'py "/c/saver.py" check' }, { command: 'mine.sh' }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ command: 'py "/c/saver.py" guard' }] }],
      PreToolUse: [{ matcher: 'Read', hooks: [{ command: 'py "/c/saver.py" secrets' }] }],
    },
  }
  const st = applySettings(old, [])
  expect('statusLine' in st).toBe(false)
  expect(st.permissions.deny).toEqual(['Bash(rm:*)', ...DENY_READS])
  expect(st.hooks).toEqual({ SessionStart: [{ matcher: 'startup|clear', hooks: [{ command: 'mine.sh' }] }] })
  expect(applySettings({ statusLine: { command: 'my-line.sh' } }, []).statusLine).toEqual({ command: 'my-line.sh' })
})

test('uninstall undoes install; changes() lists what moves', () => {
  const mine = { env: { FOO: '1', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' }, permissions: { deny: ['Bash(rm:*)'] },
    hooks: { SessionStart: [{ hooks: [{ command: 'mine.sh' }] }] } }
  const st = applySettings(copy(mine), ['--orchestrate'])
  const diff = changes(mine, st)
  expect(diff).toContain('+ model: "opusplan"')
  expect(diff).toContain('+ permissions.deny: "Read(**/.env)"')
  expect(diff.some(d => d.includes('FOO'))).toBe(false)
  expect(removeSettings(st)).toEqual(mine)
  expect(changes(mine, mine)).toEqual([])
})

test('conflicts flags standalone caveman copies and hooks', () => {
  const found = conflicts({ hooks: { SessionStart: [{ hooks: [{ command: 'python caveman-start.py' }] }] } }, ['caveman', 'savings'], '/s')
  expect(found.length).toBe(2)
  expect(found[0]).toContain('caveman')
  expect(found[0]).not.toContain('savings')
  expect(found[1]).toContain('caveman-start')
  expect(conflicts({}, [], '/s')).toEqual([])
})

test('/saver-setup lists first, then applies: backup, old files removed, --pet carried over', async () => {
  const settings = JSON.stringify({ statusLine: { command: '"py" "/h/.claude/statusline.py" --pet' } })
  const { io, fs, runs } = fakeIo({
    '/h/.claude/settings.json': settings,
    '/h/.claude/statusline.py': 'old',
    '/h/.claude/saver.py': 'old',
    '/h/.claude/skills/savings/SKILL.md': 'Run `py "saver.py" savings`',
    '/h/.claude/skills/pet/SKILL.md': 'my own pet skill',
  }, { HOME: '/h' })
  const listed = await setup(io, [])
  expect(listed).toContain('- statusLine.command')
  expect(listed).toContain('Run /saver-setup --yes to apply.')
  expect(fs.get('/h/.claude/settings.json')).toBe(settings)
  expect(await setup(io, ['--bogus'])).toContain('Unknown option')

  const done = await setup(io, ['--yes'])
  expect(done).toContain('Updated')
  expect(fs.get('/h/.claude/settings.json.bak')).toBe(settings)
  const now = JSON.parse(fs.get('/h/.claude/settings.json')!)
  expect('statusLine' in now).toBe(false)
  expect(now.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('50')
  expect(JSON.parse(fs.get('/h/.claude/.statusline-ctx/config.json')!)).toEqual({ pet: true })
  const removed = runs.map(r => r.at(-1)!.replace(/\\/g, '/'))
  expect(removed).toEqual(['/h/.claude/statusline.py', '/h/.claude/saver.py', '/h/.claude/skills/savings'])
})
