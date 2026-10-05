![alt text](image.png)

# claude-statusline

A minimal two-line status line for [Claude Code](https://claude.com/claude-code).
Uses Claude Code's own `✻ ⎿` marks plus `█ ░ ·`. If Claude Code renders in your terminal, so does this. No Nerd Font needed.

```
✻ Opus 5.5  ·  high  ·  pony full + cave
  ⎿  ctx █████░░░░░ 48%  ·  5h 63% 12:51p  ·  7d 91% Thu 10:11p  ·  cache 59m
```

**Line 1:** model, effort level, and active [ponytail](https://github.com/DietrichGebert/ponytail)
and [caveman](https://github.com/JuliusBrussee/caveman) modes.

**Line 2:**

| Segment | Meaning |
|---------|---------|
| `ctx`   | Context window used |
| `5h`    | 5-hour usage limit used, and when it resets |
| `7d`    | Weekly usage limit used, and when it resets |
| `cache` | Time left before the prompt cache expires. A message sent after that re-reads the whole conversation at full price. |

Usage numbers turn green under 50%, yellow under 80%, and red above that.
The context bar is Claude orange under 50%, then turns yellow and red the same way.

**Animation.** The status line redraws every second and on new messages. Frames follow the clock, so bursts of redraws never speed it up:

- `✻` spins back and forth (`· ✢ ✳ ✶ ✻ ✽`) while Claude is working.
- New context bar cells, rising `5h`/`7d` numbers, and changed modes glow light peach, then fade smoothly into their usual color over 15 seconds.
- With under 5 minutes of prompt cache left, `cache` breathes between red and dim red.
Segments with no data are hidden.

## Install

Requires Python 3.8+.

- **macOS:** if `python3 --version` asks you to install developer tools, run
  `xcode-select --install` (or `brew install python`) first.
- **Linux:** install `python3` from your package manager if it is missing.
- **Windows:** install Python from [python.org](https://www.python.org/downloads/). It includes the `py` launcher.

**Quick install.** Paste one line into a terminal:

| OS | Command |
|----|---------|
| macOS / Linux | `curl -fsSL https://raw.githubusercontent.com/pianburp/claude-statusline/main/install.py \| python3 -` |
| Windows (PowerShell) | `irm https://raw.githubusercontent.com/pianburp/claude-statusline/main/install.py \| py -` |

Add `--with-plugins` after the final `-` to also add ponytail and caveman (see below).

**Or from a clone.** Get the code with git, or click **Code > Download ZIP** on GitHub and unzip it:

```
git clone https://github.com/pianburp/claude-statusline
cd claude-statusline
```

Run the installer:

| OS | Command |
|----|---------|
| macOS / Linux | `python3 install.py` |
| Windows | `py install.py` |

The installer:

1. Copies `statusline.py` to `~/.claude/`.
2. Backs up `~/.claude/settings.json` and any existing `statusline.py` to `.bak` files, only on the first run.
3. Sets `statusLine`.

Restart Claude Code. A line starting with `✻` appears under the prompt.

### Troubleshooting

- **No status line:** open `~/.claude/settings.json` and copy the `statusLine` → `command` value.
  Run it in a terminal with `echo {} |` in front. It should print a line starting with `✻`.
- **`command not found` or `No such file`:** Python moved or the path is wrong. Run the installer again.
- **Boxes or `?` instead of `✻ ⎿ █`:** your terminal font lacks those glyphs. Switch to a modern
  monospace font (Cascadia, Menlo, JetBrains Mono, DejaVu Sans Mono).

### Optional: ponytail and caveman

```
python3 install.py --with-plugins   # Windows: py install.py --with-plugins
```

This also registers both plugins. Restart Claude Code, and it asks once to install them.
They change how Claude behaves in every project:

- **caveman** makes replies very short. Say `stop caveman` to turn it off.
- **ponytail** pushes Claude toward the smallest code change. Say `stop ponytail` to turn it off.

If you are new to Claude Code, skip them until you know the default behavior.
Both are third-party plugins that run hooks on your machine. Read their repos before installing.

## Settings

| Variable | Default | Effect |
|----------|---------|--------|
| `CLAUDE_CACHE_TTL` | `3600` | Prompt cache lifetime in seconds. Use `300` if your cache lasts 5 minutes. |
| `NO_COLOR` | unset | Set to any value to turn off colors. |
| `COLORTERM` | set by terminal | `truecolor` or `24bit` makes the glow fade smoothly. Otherwise it steps through 256-color shades. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where the installer and the status line look for config. |

## Uninstall

1. Delete `~/.claude/statusline.py` and the `~/.claude/.statusline-ctx/` folder.
2. Remove the `statusLine` key from `~/.claude/settings.json`.
   Restore `settings.json.bak` only as a last resort: it drops every setting changed since the install.
3. Optional: run `/plugin` in Claude Code to remove ponytail and caveman.

## License

MIT
