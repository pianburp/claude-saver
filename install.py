#!/usr/bin/env python3
"""Install the status line into ~/.claude.

Pass --with-plugins to also register the ponytail + caveman plugins.
Backs up settings.json and statusline.py once (first backups are never overwritten).
Keys you already set are left alone, except statusLine.
"""

import json
import os
import shutil
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_URL = "https://raw.githubusercontent.com/pianburp/claude-statusline/main/statusline.py"
CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")

MARKETPLACES = {
    "ponytail": "DietrichGebert/ponytail",
    "caveman": "JuliusBrussee/caveman",
}


def python_cmd():
    # On Windows use this interpreter directly: the py launcher adds ~30ms to every redraw,
    # and "python3" is often a Microsoft Store stub.
    # Elsewhere use the full path: Claude Code started from a GUI or IDE may have a shorter PATH.
    if os.name != "nt":
        for name in ("python3", "python"):
            path = shutil.which(name)
            if path:
                return f'"{path}"'
    return f'"{sys.executable}"'


def main():
    os.makedirs(CLAUDE_DIR, exist_ok=True)
    script = os.path.normpath(os.path.join(CLAUDE_DIR, "statusline.py"))
    settings_path = os.path.normpath(os.path.join(CLAUDE_DIR, "settings.json"))

    settings = {}
    if os.path.exists(settings_path):
        try:
            with open(settings_path, encoding="utf-8") as f:
                settings = json.load(f)
        except ValueError as e:
            sys.exit(f"Could not read {settings_path}: {e}\nFix the JSON, then run install.py again.")
        if not os.path.exists(settings_path + ".bak"):
            shutil.copy2(settings_path, settings_path + ".bak")
            print(f"Backed up settings to {settings_path}.bak")

    if os.path.exists(script) and not os.path.exists(script + ".bak"):
        shutil.copy2(script, script + ".bak")
    local = os.path.join(HERE, "statusline.py")
    if os.path.exists(local):
        shutil.copy2(local, script)
    else:  # piped from curl/irm: no clone, fetch the script
        urllib.request.urlretrieve(RAW_URL, script)
    print(f"Installed {script}")

    settings["statusLine"] = {
        "type": "command",
        "command": f'{python_cmd()} "{script}"',
        "refreshInterval": 1,  # docs minimum; frames are 1s apart
    }
    with_plugins = "--with-plugins" in sys.argv[1:]
    if with_plugins:
        markets = settings.setdefault("extraKnownMarketplaces", {})
        plugins = settings.setdefault("enabledPlugins", {})
        for name, repo in MARKETPLACES.items():
            markets.setdefault(name, {"source": {"source": "github", "repo": repo}})
            plugins.setdefault(f"{name}@{name}", True)

    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    print(f"Updated {settings_path}")
    if with_plugins:
        print("Restart Claude Code. It will ask once to install ponytail and caveman.")
    else:
        print("Restart Claude Code. Run with --with-plugins to add ponytail and caveman.")


if __name__ == "__main__":
    main()
