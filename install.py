#!/usr/bin/env python3
"""Install claude-saver into ~/.claude: status line, /token-audit and /savings.

  --with-plugins  also register the ponytail + caveman plugins
  --graphify      also install graphify (PyPI: graphifyy) and its skill
  --orchestrate   plan on Opus, execute on Sonnet (model: opusplan), subagents on Haiku
  --all           plugins + graphify (not --orchestrate: that changes your model)

Backs up settings.json and statusline.py once (first backups are never overwritten).
Keys you already set are left alone, except statusLine (and model with --orchestrate).
"""

import json
import os
import shutil
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_URL = "https://raw.githubusercontent.com/pianburp/claude-saver/main/"
CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")

MARKETPLACES = {
    "ponytail": "DietrichGebert/ponytail",
    "caveman": "JuliusBrussee/caveman",
}

# Generated folders Claude never needs to read. Global rules, so every project gets them.
DENY_READS = [f"Read(**/{d}/**)" for d in ("node_modules", "__pycache__", ".venv", "venv", ".next", "coverage")]
# Secrets stay out of the API. Named files, not .env.*, so .env.example stays readable.
DENY_READS += ["Read(**/.env)", "Read(**/.env.local)", "Read(**/.env.*.local)"]

SKILLS = {
    "token-audit": (
        "Audit what Claude Code loads every session (CLAUDE.md, memory, rules, MCP servers, ignores) and prune it.",
        """Run `{run} audit` and show the report.

Then propose concrete cuts for each flagged file: duplicate lines, stale paths, long prose,
code blocks that belong in a skill or doc, notes for humans that can become `<!-- -->` comments.
Show each change as a diff. Apply nothing until the user says yes.
Before editing a file, copy it to `<file>.bak`.
If the caveman plugin is installed, offer `/caveman:caveman-compress` for files still over 500 tokens.""",
    ),
    "savings": (
        "Show this session's token use and estimated savings from caveman, ponytail, graphify and the prompt cache.",
        "Run `{run} savings` and print its output verbatim in a code block. Add nothing.",
    ),
}


def fetch(name, dest):
    local = os.path.join(HERE, name)
    if os.path.exists(local):
        shutil.copy2(local, dest)
    else:  # piped from curl/irm: no clone, fetch the file
        urllib.request.urlretrieve(RAW_URL + name, dest)


def install_skills(python):
    run = f'{python} "{os.path.join(CLAUDE_DIR, "saver.py")}"'.replace("\\", "/")
    for name, (desc, body) in SKILLS.items():
        folder = os.path.join(CLAUDE_DIR, "skills", name)
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "SKILL.md"), "w", encoding="utf-8") as f:
            # Hand-run only: keeps the description out of every session's context.
            f.write(f"---\nname: {name}\ndescription: {desc}\ndisable-model-invocation: true\n---\n\n{body.format(run=run)}\n")
        print(f"Installed /{name}")


def install_graphify():
    uv = shutil.which("uv")
    cmd = [uv, "tool", "install", "--upgrade", "graphifyy"] if uv else [sys.executable, "-m", "pip", "install", "--user", "--upgrade", "graphifyy"]
    if subprocess.call(cmd) != 0:
        print("graphify install failed. Run it yourself: " + " ".join(cmd[1:] if uv else cmd))
        return
    exe = shutil.which("graphify") or os.path.expanduser("~/.local/bin/graphify")
    if subprocess.call([exe, "install"]) != 0:
        print("Installed graphifyy, but `graphify install` failed. Open a new terminal and run: graphify install")


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


def apply_settings(settings, args, python, script):
    """Merge claude-saver's keys into settings.json; keep the user's own values."""
    settings["statusLine"] = {
        "type": "command",
        "command": f'{python} "{script}"',
        "refreshInterval": 1,  # docs minimum; frames are 1s apart
    }
    env = settings.setdefault("env", {})
    # Undocumented but read by Claude Code: auto-compact at 50% of the window instead of near full.
    env.setdefault("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "50")
    if "--orchestrate" in args:
        settings["model"] = "opusplan"
        env.setdefault("CLAUDE_CODE_SUBAGENT_MODEL", "haiku")

    deny = settings.setdefault("permissions", {}).setdefault("deny", [])
    deny += [r for r in DENY_READS if r not in deny]

    # New sessions only: after /compact or /resume the warning would just repeat.
    check = f'{python} "{os.path.join(os.path.dirname(script), "saver.py")}" check'
    starts = settings.setdefault("hooks", {}).setdefault("SessionStart", [])
    if not any("saver.py" in h.get("command", "") and h.get("command", "").endswith(" check")
               for group in starts for h in group.get("hooks", [])):
        starts.append({"matcher": "startup", "hooks": [{"type": "command", "command": check}]})

    if "--with-plugins" in args or "--all" in args:
        markets = settings.setdefault("extraKnownMarketplaces", {})
        plugins = settings.setdefault("enabledPlugins", {})
        for name, repo in MARKETPLACES.items():
            markets.setdefault(name, {"source": {"source": "github", "repo": repo}})
            plugins.setdefault(f"{name}@{name}", True)
    return settings


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
    fetch("statusline.py", script)
    fetch("saver.py", os.path.join(CLAUDE_DIR, "saver.py"))
    print(f"Installed {script}")
    install_skills(python_cmd())

    args = sys.argv[1:]
    with_plugins = "--with-plugins" in args or "--all" in args
    apply_settings(settings, args, python_cmd(), script)

    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    print(f"Updated {settings_path}")
    if "--graphify" in args or "--all" in args:
        install_graphify()
    if with_plugins:
        print("Restart Claude Code. It will ask once to install ponytail and caveman.")
    else:
        print("Restart Claude Code. Run with --all to add ponytail, caveman and graphify.")


if __name__ == "__main__":
    main()
