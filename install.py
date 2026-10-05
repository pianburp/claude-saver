#!/usr/bin/env python3
"""Install the status line into ~/.claude and register the ponytail + caveman plugins.

Backs up settings.json first. Keys you already set are left alone, except statusLine.
"""

import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")

MARKETPLACES = {
    "ponytail": "DietrichGebert/ponytail",
    "caveman": "JuliusBrussee/caveman",
}


def python_cmd():
    # On Windows, "python3" is often a Microsoft Store stub, so prefer the py launcher.
    names = ("py", "python") if os.name == "nt" else ("python3", "python")
    for name in names:
        if shutil.which(name):
            return name
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
        shutil.copy2(settings_path, settings_path + ".bak")
        print(f"Backed up settings to {settings_path}.bak")

    if os.path.exists(script):
        shutil.copy2(script, script + ".bak")
    shutil.copy2(os.path.join(HERE, "statusline.py"), script)
    print(f"Installed {script}")

    settings["statusLine"] = {
        "type": "command",
        "command": f'{python_cmd()} "{script}"',
        "refreshInterval": 5,
    }
    markets = settings.setdefault("extraKnownMarketplaces", {})
    plugins = settings.setdefault("enabledPlugins", {})
    for name, repo in MARKETPLACES.items():
        markets.setdefault(name, {"source": {"source": "github", "repo": repo}})
        plugins.setdefault(f"{name}@{name}", True)

    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    print(f"Updated {settings_path}")
    print("Restart Claude Code. It will ask once to install ponytail and caveman.")


if __name__ == "__main__":
    main()
