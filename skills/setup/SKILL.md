---
name: setup
description: Install or update claude-saver's status line, auto-compact, deny rules, startup check, /token-audit and /savings in ~/.claude.
argument-hint: "[--all] [--with-plugins] [--graphify] [--orchestrate] [--uninstall]"
disable-model-invocation: true
---

1. Find a Python 3.8+ interpreter: try `python3 --version`, then `python --version`, then `py -3 --version`.
   Use the first that prints 3.8 or newer. On Windows, skip a `python3`/`python` that opens the Microsoft Store.
   None found: tell the user to install Python 3.8+ and stop.
2. Run `<python> "${CLAUDE_PLUGIN_ROOT}/install.py" --dry-run $ARGUMENTS` and show its output in a code block.
3. Ask the user to apply those changes. On yes, run `<python> "${CLAUDE_PLUGIN_ROOT}/install.py" --yes $ARGUMENTS`.
4. Tell the user to restart Claude Code, and to run `/token-saver:setup` again after a plugin update to refresh the status line scripts.
