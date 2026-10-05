# claude-statusline

A minimal two-line status line for [Claude Code](https://claude.com/claude-code).
Plain ASCII, so it renders in any terminal and font.

```
Opus 5.5  |  high  |  pony full + cave
ctx [======------] 48%  |  5h 63% 12:51p  |  7d 91% Thu 10:11p  |  cache 59m
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
Segments with no data are hidden.

## Install

Requires Python 3.8+.

```
git clone https://github.com/<you>/claude-statusline
cd claude-statusline
python install.py
```

On Windows, use `py install.py` if `python` is not on your PATH.

The installer:

1. Copies `statusline.py` to `~/.claude/`.
2. Backs up `~/.claude/settings.json` to `settings.json.bak`.
3. Sets `statusLine`, and registers the ponytail and caveman plugins.
   Keys you already set for those plugins are left alone.

Restart Claude Code. It asks once to install ponytail and caveman.
Both are optional: the status line works without them.

## Settings

| Variable | Default | Effect |
|----------|---------|--------|
| `CLAUDE_CACHE_TTL` | `3600` | Prompt cache lifetime in seconds. Use `300` if your cache lasts 5 minutes. |
| `NO_COLOR` | unset | Set to any value to turn off colors. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where the installer and the status line look for config. |

## Uninstall

1. Delete `~/.claude/statusline.py`.
2. Remove the `statusLine` key from `~/.claude/settings.json`,
   or restore `settings.json.bak`.
3. Optional: run `/plugin` in Claude Code to remove ponytail and caveman.

## License

MIT
