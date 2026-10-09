![claude-saver status line in Claude Code](image.png)

# claude-saver

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg)

Spend fewer tokens in [Claude Code](https://claude.com/claude-code) without changing how you work.

Every API call re-sends your CLAUDE.md, memory, tool schemas and the whole conversation.
claude-saver trims what gets re-sent, shows you when it's about to get expensive,
and tells you what each saver actually saved. One Claude Code [mod](#mod): nothing else to install, no daemon.

In Claude Code:

```
/plugin marketplace add pianburp/claude-saver
/plugin install ctx-saver@pianburp
```

The plugin is the mod: the status line, the guards, the startup check and every command.
A line starting with `✻` shows up under the prompt. It updates with the plugin.

Then run `/saver-setup` once for the `settings.json` half: auto-compact at 50% and the `.env` deny rules.
It lists every change; `/saver-setup --yes` writes them. Add `--all` for the ponytail, caveman and graphify plugins.
Restart Claude Code after it writes.

Upgrading from an older version? Run `/saver-setup --yes`. It removes the old status line and scripts
(`statusline.py`, `saver.py`), and keeps your pet, ledger and switches. Until then the old line keeps drawing and the mod's stays hidden.

## What you get

| Piece | What it does | Runs in | When |
|-------|--------------|---------|------|
| [Status line](#status-line) | Context, usage limits with a run-out forecast, prompt cache countdown. Hints `/compact` before auto-compact, `/handoff /clear` once the cache is cold | Mod | Always on |
| [Auto-compact at 50%](#auto-compact) | Compacts at half the window instead of near full | settings | Automatic |
| [Output trim](#output-trim) | Cuts a 2k+ token shell output to its head, error lines and tail before Claude reads it | Mod | Automatic |
| [Folder guard](#folder-guard) | Claude never reads `node_modules`, `__pycache__`, `.venv`, `venv`, `.next`, `coverage`, `dist`, `build` or `target`, not even through the shell | Mod | Automatic |
| [Read guards](#read-guards) | Skips whole reads of lockfiles, minified and huge files (`cat big.log` too), and answers re-reads of unchanged files itself | Mod | Automatic |
| [Secret guard](#secret-guard) | Blocks reading `.env` files and writing hardcoded API keys | Mod + settings | Automatic |
| Focus mode | Hides tool calls and Claude's in-between text; a box above the prompt shows the task, its steps and what is left (kept after Esc), then the final summary. Claude's first edit or command in a task is refused once until it writes steps; when the session has no TaskCreate or TodoWrite, the mod adds its own `steps` tool. `ctrl+o` shows everything | Mod | Automatic |
| [Startup check](#startup-check) | One line when something wastes tokens every session. Silent otherwise | Mod | Automatic |
| [`/token-audit`](#token-audit) | Finds what loads before you type, proposes cuts as diffs | Mod | On demand |
| [`/savings`](#savings) | This session's tokens and what each saver saved. `--week`: per day | Mod, no model turn | On demand |
| [`/handoff`](#handoff) | Saves a task note before `/clear`; the next session starts with it | Mod | On demand |
| [`/wrapped`](#wrapped) | Your week with Claude as a Wrapped-style page | Mod, no model turn | On demand |
| [`/toggle`](#toggle) | Turns the pet, the check and each guard on or off mid-session | Mod, no model turn | On demand |
| [`--orchestrate`](#--orchestrate) | Plans on Opus, executes on Sonnet, subagents on Haiku | settings | Opt-in |
| [Pet](#pet) | A status line pet that eats the tokens you save | Mod | Opt-in (`/toggle pet`) |
| [caveman](https://github.com/JuliusBrussee/caveman) | Shorter replies: 65% fewer output tokens on average | Opt-in (`--with-plugins`, `--all`) |
| [ponytail](https://github.com/DietrichGebert/ponytail) | Less code written: 80-94% fewer lines in its benchmark | Opt-in (`--with-plugins`, `--all`) |
| [graphify](https://github.com/safishamsi/graphify) | Claude queries a code graph instead of re-reading files | Opt-in (`--all`) |

caveman, ponytail and graphify are third-party projects. claude-saver only installs them and measures them.

## Status line

```
✻ Opus 5.5 · hi · pony full + cave · saved ~18.3k
⎿ ctx ██░░░░ 31% · 5h 63% 12:51p full 11:40a · 7d 91% Thu · ● 52m
```

- **Line 1:** model, effort (`lo`, `med`, `hi`, `xhi`, `max`), active ponytail/caveman modes, `saved` (estimated tokens saved this session, the `total` row of [`/savings`](#savings)).
- **Line 2:** `ctx` is context used. `5h` and `7d` are your usage limits and when they reset: the time when under 24h away, else the day.
  `full 11:40a` (red) shows when your average pace since the window opened hits 100% before the reset. It waits until a tenth of the window has passed (30 minutes of 5h, about 17 hours of 7d).
  `● 52m` is time left on the prompt cache. The pie drains `● ◕ ◑ ◔` as it runs down, gray until its last 5 minutes, `○ cold` once it expires.
  After that, the next message re-reads the whole conversation at full price.
- Numbers go green, then yellow at 50%, then red at 80%. The context bar stays Claude orange under 50%.
- `/compact` shows 10 points before auto-compact (40% by default). Compact at a clean break, not mid-task.
- `/compact` also shows in the cache's last 5 minutes when context is over 20%. Compacting while the cache is warm is cheap. After it expires, the next message re-bills everything.
- `/handoff /clear` replaces it once the cache has expired and context is over 20%. If you're switching tasks, starting fresh is cheaper. Run [`/handoff`](#handoff) first to keep the task.
- Segments with no data are hidden.

The mod draws it in place of the hint line under the prompt, and keeps the hint (`? for shortcuts`, `esc to interrupt`) as a dim row below it.
It redraws every second. Animation follows the clock, so bursts of redraws don't speed it up:
`✻` spins while Claude works, rising numbers count up over 3 seconds and glow peach for 15,
and the cache timer pulses red in its last 5 minutes.

Only plain Unicode glyphs (`✻ ⎿ █ ░ · ●`) are used. No Nerd Font needed.

### Pet

`/toggle pet` (or `/saver-setup --yes --pet`) puts Clawd, Claude Code's mascot, left of the status line, three rows tall as on Claude Code's welcome banner.
It eats the `saved` count from every session.
It costs no tokens: the status line is never sent to the model.
The status line credits each session's savings to `~/.claude/.statusline-ctx/ledger.json`, pet or not.
`/toggle pet` shows or hides it mid-session. `/pet` shows its stage, age, lifetime savings and progress to the next stage.

![Clawd's stages: an egg under 5k, cracked at 5k, hatched at 10k, one sparkle at 250k, two at 2.5M](pet.svg)

It glows when it grows. Its eyes, arms and color follow the session, first match wins:

| Clawd | When |
|-------|------|
| `▚ ▞` eyes, red | A tool output of 2k+ tokens just landed (15 seconds) |
| `▀ ▀` eyes and `z`, gray | Cache cold: asleep |
| red | Context in `/compact` range |
| pulsing red | Cache in its last 5 minutes |
| arms wave `▝▜█████▛▘` / `▗▟█████▙▖` | Claude working. The egg rocks |
| orange, blinking every 7 seconds | Otherwise |

It takes 11 columns, so the rest of the status line shifts right.

`/saver-setup --yes --uninstall` deletes `.statusline-ctx/`, pet included.

## Automatic

### Auto-compact

Sets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50`. Long sessions drift, and every call re-reads the full history.
The variable is read by Claude Code but undocumented, so it may change. The documented alternative is
`autoCompactWindow` (a token count). A value you already set is kept.

### Mod

The plugin ships a [mod](https://claude.com/resources/articles/claude-code-mods), `hooks/register.tsx`, that runs inside Claude Code.
A mod can block a tool call, rewrite its result before Claude reads it, or answer it outright, which a settings hook cannot.
It also draws the status line and answers every command. Every guard below is the mod's. A guard that blocks gives Claude a one-line reason with the token cost and a cheaper path.
`/toggle guard`, `/toggle secrets` and `/toggle reads` switch them off.

### Output trim

A Bash or PowerShell output of 2k+ tokens is cut before Claude reads it: the first ~500 tokens, up to ~750 tokens of error lines
(`error`, `fail`, `exception`, `traceback`, `panic`, `assert`) from the middle, and the last ~1k tokens.
A note names the file with the full output (`~/.claude/.statusline-ctx/out/<n>.txt`, last 50 kept), and tells Claude to use quiet flags next time.
The cut tokens are never sent, not even once. `/savings` shows them in a `trim` row.

Each trim is counted per project and command (`npm test`, `git log`) in `~/.claude/.statusline-ctx/noisy.json`.
The [startup check](#startup-check) names the worst repeat offender, so the fix ends up in CLAUDE.md.

### Folder guard

`node_modules`, `__pycache__`, `.venv`, `venv`, `.next`, `coverage`, `dist`, `build` and `target` are blocked for Read, Grep, Glob
and shell reads (`cat`, `ls`, `grep`, `find`, `Get-Content`, `Get-ChildItem` ...).
Other commands pass, so `rm -rf node_modules` still runs, and so do exclusions like `--exclude-dir=node_modules`.

### Read guards

- **Whole-file reads** of lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`, `Cargo.lock`, `uv.lock` ...), `*.min.js`, `*.min.css`, `*.map`, and any file over 40 KB (~10k tokens).
  A Read with `offset` or `limit` passes, and so do images and PDFs. Claude is told to Grep or read a slice.
  A shell dump of a big file (`cat big.log`, `Get-Content big.log`, with no pipe or `-Tail`) is blocked the same way.
- **Re-reads**: the same file and range, unchanged since Claude read it this session. The mod answers the call itself with Claude Code's
  "file unchanged" result, without reading the file. The next try reads it, in case compaction dropped the content.
  An edit changes the file, so read-after-edit always reads.

### Secret guard

- **Touching `.env` files** from Bash, PowerShell, Read, Grep or Glob (`.env`, `.env.local`, `.env.production.local`). A secret printed into the transcript can't be taken back. `.env.example`, `.sample`, `.template` and `.dist` stay readable.
- **Writes that hardcode a key**: a Write, Edit or MultiEdit containing an Anthropic, OpenAI, Stripe live, AWS, GitHub, Google or Slack key, or a private key block. Writes to `.env*` files are allowed, since that's where keys belong.

It matches known key prefixes only, with no entropy scan. Bash heredocs are not scanned. If the guard itself fails, the call is refused.

`/saver-setup` also adds `Read(**/.env)`, `Read(**/.env.local)` and `Read(**/.env.*.local)` to `permissions.deny`,
so the Read tool stays blocked even where the mod is not loaded.

### Startup check

On new sessions and `/clear`, the mod runs its check. It shows a [`/handoff`](#handoff) note if one is waiting.
On new sessions it also checks the setup, and prints nothing unless something needs fixing:

- An instruction file (CLAUDE.md, AGENTS.md, rules, MEMORY.md) is over 500 tokens, or MEMORY.md is past the 200 lines / 25KB that load.
- A folder in the project's `.gitignore` holds 1000+ files and neither the [folder guard](#folder-guard) nor `permissions.deny` blocks it.
- Project MCP servers (`.mcp.json`) are configured while `ENABLE_TOOL_SEARCH` is off, so every tool schema loads up front.
- The [output trim](#output-trim) cut the same command 3+ times in this project, and no always-loaded file mentions it:
  `` `npm test` printed 2k+ tokens 6 times; add its quiet flag to CLAUDE.md ``. Writing that note silences it.
- `settings.json` still holds an older version's `statusLine`: run `/saver-setup`.

When it does print, it's one line (~40 tokens) telling Claude to suggest `/token-audit`.

## On demand

### /token-audit

Lists every file Claude Code loads each session (global and project CLAUDE.md, `@imports`, rules, auto memory) with its token cost.
`AGENTS.md` counts when no CLAUDE.md exists. It flags:

- Files over 500 tokens, code blocks over 10 lines, stale paths, and lines repeated across files.
- A MEMORY.md too long to load in full, and rules without `paths:` frontmatter (those load every session).
- Project MCP servers (`.mcp.json`), unblocked heavy folders, and a `.claudeignore` (Claude Code doesn't read it).
- Subagents on your main model (and custom agents with no `model:`), no `## Compact instructions` section, and an unset `BASH_MAX_OUTPUT_LENGTH`.
- A 5-minute prompt cache when `ENABLE_PROMPT_CACHING_1H` is off.

Claude then proposes cuts as diffs and applies only the ones you approve, after a `.bak` backup.

Tip: HTML comments `<!-- -->` in CLAUDE.md cost zero tokens. Put notes for humans there.

### /savings

```
Session 9e1585f1: 13 API calls
  used     input 26 · cache write 45.2k · cache read 752.2k · output 18.0k

Saved **estimated
  caveman     ~2.5k output  65% avg cut on 1.4k reply tokens (caveman benchmark)
  ponytail   ~15.7k output  80% fewer lines on 3.9k code tokens (ponytail benchmark, low end)
  reads      ~12.9k input   2 reads blocked by the read guards or deny rules (folder blocks at ~1.2k each)
  guard       ~2.9k input   noisy commands run again with less output
  total      ~34.0k

  prompt cache  752.2k input tokens billed at 10% (exact, built into Claude Code)
```

`used` and `prompt cache` are exact, read from the session transcript. `Saved` rows are estimates:

- **caveman:** reply tokens × the published 65% average cut.
- **ponytail:** code tokens written × the published 80% low-end cut.
- **graphify:** assumes each graph query replaced 5 file reads of this session's average size.
  This is a guess. For a real number on your repo, run `graphify benchmark`.
- **reads:** each call blocked by a [read guard](#read-guards) (at the file's size), or by the [folder guard](#folder-guard) or a deny rule of yours (at the session's average read size).
- **trim:** the tokens the [output trim](#output-trim) cut.
- **guard:** a 2k+ token command run again with less output, e.g. with the quiet flag the output trim suggested. The difference counts once.
- **compact:** each auto-compact's dropped tokens × the calls after it, at the 10% cache-read price those calls would have paid.
  It credits all auto-compaction, not only the earlier trigger the 50% setting gives.

It also lists the three biggest tool outputs (2k+ tokens) with their command.
They stay in context and are re-read on every later call, so add quiet flags (`--reporter=dot`, `-q`) or run them in a subagent.
It counts model switches too: the prompt cache is per model, so each switch re-writes the whole conversation.

`/savings --week` shows tokens saved per day over the last 7 days, from the ledger the status line keeps:

```
Saved per day **estimated, recorded by the status line
  Tue 09-29  ████████              ~8.1k
  Wed 09-30                        -
  ...
  Mon 10-05  ████████████████████  ~20.4k
  total                            ~61.3k
```

Only sessions with the status line running count.

### /handoff

Run it before `/clear`. Claude writes a note of 15 lines or fewer: goal, what is done, the next step, key files, gotchas.
It is saved to `~/.claude/.statusline-ctx/handoff/<project>.md`.
The next session in that project (after `/clear` or a fresh start) gets the note from the [startup check](#startup-check) once, then the file is emptied.
Notes older than 7 days are dropped unread. It works with `/toggle check off` too.

### /wrapped

Your last 7 days across every project, as a Spotify Wrapped-style page that opens in your browser.
The cards show API calls, top project, busiest day, peak hour, favourite tool, tokens written, tokens saved, the loudest command, calls per day and your pet.
It reads the session transcripts and the ledger, and writes `~/.claude/.statusline-ctx/wrapped.html`. Nothing leaves your machine.

### /toggle

Turns a feature on or off without editing `settings.json` or restarting:

```
/toggle                 list switches
/toggle pet             flip one
/toggle secrets off     set one
```

```
Switches (take effect now, no restart):
  pet      on   Clawd on the status line
  check    on   startup check
  guard    off  output trim: long shell outputs cut to head, errors and tail
  secrets  on   secret guard: blocks .env access and hardcoded keys
  reads    on   read guards: generated folders, lockfiles, huge files, unchanged re-reads
  focus    on   focus mode: hide tool calls, show steps and what is left
```

Switches live in `~/.claude/.statusline-ctx/config.json` and persist across sessions.
The mod reads it on every redraw and tool call, so a change applies at once.
A switch you set beats an older install's `--pet`.
caveman and ponytail have their own: `stop caveman` / `stop ponytail` for the session, `/plugin` to disable them everywhere.

## --orchestrate

Sets `"model": "opusplan"`: Opus in plan mode (Shift+Tab twice), Sonnet once you execute.
Also sets `CLAUDE_CODE_SUBAGENT_MODEL=haiku` for subagents with no model of their own.
It's not part of `--all`, because it replaces your default model. Switch back any time with `/model`.

## Habits

The tools can't do these for you:

- `/clear` between unrelated tasks. Old context is re-sent on every call.
- `/rewind` to undo a recent wrong turn instead of `/compact`. Everything before it stays cached.
- Pick `/model` and `/effort` at the start. Changing them mid-session rebuilds the cache.
- @-mention files you know are relevant. It skips the search and Read calls.
- Plan before you execute on anything non-trivial, and review the plan. Skip planning for one-line changes.
- Put all constraints in the first prompt, and batch related changes into one request.
- Run `/loop` in its own session, so each loop turn doesn't carry your main conversation.
- For routine work, `MAX_THINKING_TOKENS=0` cuts thinking output. It lowers quality on hard problems, so it's not set for you.

## Install

Install the plugin (top of this page). The status line, guards and commands need nothing else.

`/saver-setup` handles `settings.json`. Without `--yes` it only lists the changes. Flags combine, e.g. `/saver-setup --yes --all --orchestrate`:

| Flag | Adds |
|------|------|
| `--with-plugins` | ponytail and caveman, through the `claude` CLI. Without the CLI, it prints the `/plugin` commands to run |
| `--graphify` | graphify via `uv` (or `pip --user`), then `graphify install` |
| `--all` | Both of the above |
| `--orchestrate` | opusplan + Haiku subagents |
| `--pet` | Turns the [pet](#pet) on |
| `--yes` | Applies the changes. Without it they are only listed |
| `--uninstall` | Removes what setup added (see below) |

New to Claude Code? Skip the plugins until you know the default behavior.
caveman and ponytail change how Claude talks and codes in every project. Say `stop caveman` / `stop ponytail` to turn them off.
graphify pays off in big repos: run `/graphify` once to build the graph. All three run third-party code, so read their repos first.

What `/saver-setup --yes` touches:

1. Backs up `settings.json` to `settings.json.bak` on the first run only, so the backup is never overwritten.
2. Merges into `settings.json`: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` and the three `.env` deny rules.
   It keeps your values for everything except `model` with `--orchestrate`.
3. Removes what older versions added and the mod now does: the old status line, its scripts and hooks, the folder deny rules, and the `/token-audit`, `/savings`, `/pet`, `/handoff`, `/wrapped` and `/toggle` skills they wrote.
   Skills of your own with those names stay. An old `--pet` carries over to `/toggle pet`.

**Update:** `/plugin` → **Marketplaces** → `pianburp` (turn on auto-update). The status line updates with the plugin.

**Uninstall:** `/saver-setup --yes --uninstall`, then `/plugin uninstall ctx-saver@pianburp`.

- Run it without `--yes` first to see the `settings.json` changes.
- It removes `.statusline-ctx/` (pet and ledger included) from `~/.claude/`, and any scripts an older version left.
- From `settings.json` it removes the deny rules (and any status line or hooks an older version added).
  It also removes `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_SUBAGENT_MODEL` and `model`, but only if they still hold setup's values. Values you set yourself stay.
- The plugins stay. Remove them via `/plugin`, and graphify with `graphify uninstall`.

### Troubleshooting

- **No status line:** `settings.json` may still hold an older version's `statusLine`, which hides the mod's. Run `/saver-setup --yes`.
- **`cave no plugin`:** caveman is installed as plain skills (e.g. `npx skills add`), which write no mode flag.
  Run `/saver-setup --yes --with-plugins`, then delete the `cave*` folders it lists from `~/.claude/skills/`.
- **Boxes or `?` instead of `✻ ⎿ █ ▐▛`:** your font lacks the glyphs. Use Cascadia, Menlo, JetBrains Mono or DejaVu Sans Mono.

## Settings

| Variable | Default | Effect |
|----------|---------|--------|
| `CLAUDE_CACHE_TTL` | detected | Prompt cache lifetime in seconds. Detected from the transcript's newest cache write (1h or 5m), `3600` until one exists. Set only to override. |
| `NO_COLOR` | unset | Any value turns colors off. |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `50` (setup) | Context % where Claude Code auto-compacts. The `/compact` hint shows 10 points earlier. |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `haiku` (`--orchestrate`) | Model for subagents with no model of their own. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where the mod looks for config. |

## How it works

| File | Role |
|------|------|
| `.claude-plugin/` | Plugin manifest and marketplace. |
| `hooks/register.tsx` | The [mod](#mod): every hook (guards, status line, focus mode, startup check, commands). The engine's `$` never crosses an import, so it hands the other files an `io` object (`hooks/io.ts`). |
| `hooks/status.ts` | The status line and pet: gathers the session's figures each second and returns colored rows. Per-session glow state lives in `~/.claude/.statusline-ctx/`. |
| `hooks/saver.ts` | `/token-audit`, the startup check, `/savings`, `/pet`, `/wrapped`, `/handoff` and `/toggle`. Reads instruction files, settings, session transcripts (`~/.claude/projects/*/*.jsonl`) and the ledger. |
| `hooks/setup.ts` | `/saver-setup`: merges `settings.json`, removes what older versions installed. |
| `hooks/focus.ts` | Focus mode's pure helpers. |
| `hooks/*.test.ts` | Tests, run with `claude plugin test .`; `hooks/fakeio.ts` is their in-memory file system. |
| `.github/workflows/upstream.yml` | Weekly job that fails if caveman, ponytail or graphify rename a flag file or marker that claude-saver reads. |

Token counts are `chars / 4`, the same approximation graphify and most tools use. Exact numbers come only from transcript `usage` fields.

## Development

```sh
claude plugin validate . && claude plugin test .
claude --plugin-dir .        # try the mod from a clone
```

Ground rules for PRs:

- **No dependencies.** The mod runs in Claude Code's own environment: no Node, no DOM.
- **Silent by default.** Hook output lands in Claude's context on every session, so the check prints only when there's something to fix.
- **Never clobber user settings.** Use `??=`, keep existing values, back up once.
- **Cite estimates.** Any savings number needs a source or a `shortcut:` comment.
- **Add a test.** New logic gets one check in the matching `hooks/*.test.ts`.

Bug reports are most useful with your OS, Claude Code version, and the output of `/token-audit` or `/toggle`.

## Further reading

The automatic checks and audit tips come from these:

- [Claude Code token efficiency](https://www.firecrawl.dev/blog/claude-code-token-efficiency) (Firecrawl)
- [Maximizing the value of your Claude Code sessions](https://claude.com/blog/maximizing-the-value-of-your-claude-code-sessions) (Anthropic)
- [How to save tokens](https://mydataschool.com/blog/how-to-save-tokens/) (mydataschool)
- [Save tokens with Opus plan mode](https://www.mindstudio.ai/blog/save-tokens-claude-code-opus-plan-mode) (MindStudio)
- [10 tips to stop burning your tokens in Claude Code](https://medium.com/@habib23me/10-tip-to-stop-burning-your-tokens-in-claude-code-4776d4ac8956)

## License

[MIT](LICENSE)
