#!/usr/bin/env python3
"""Install claude-saver into ~/.claude: status line, hooks, /token-audit, /savings and /pet.

  --with-plugins  also install the ponytail + caveman plugins (via the `claude` CLI when on PATH)
  --graphify      also install graphify (PyPI: graphifyy) and its skill
  --orchestrate   plan on Opus, execute on Sonnet (model: opusplan), subagents on Haiku
  --all           plugins + graphify (not --orchestrate: that changes your model)
  --pet           a pet on the status line, fed by tokens saved
  --yes           apply settings.json changes without asking
  --dry-run       print what would change, write nothing
  --uninstall     remove what the installer added; your own settings stay

Shows every settings.json change and asks before writing it.
Backs up settings.json and statusline.py once (first backups are never overwritten).
Keys you already set are left alone, except statusLine (and model with --orchestrate).
"""

import json
import os
import shutil
import subprocess
import sys
import sysconfig
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_URL = "https://raw.githubusercontent.com/pianburp/claude-saver/main/"
CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")

FLAGS = {"--with-plugins", "--graphify", "--orchestrate", "--pet", "--all", "--yes", "--dry-run", "--uninstall"}

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
        "Show this session's token use and estimated savings from caveman, ponytail, graphify and the prompt cache. --week: per day.",
        "Run `{run} savings $ARGUMENTS` and print its output verbatim in a code block. Add nothing.",
    ),
    "pet": (
        "Show the status line pet: stage, age and lifetime tokens saved.",
        "Run `{run} pet` and print its output verbatim in a code block. Add nothing.",
    ),
}
# saver.py subcommand each hook runs, and its matcher.
HOOKS = {"SessionStart": ("startup", "check"), "PostToolUse": ("Bash", "guard")}


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


def install_plugins():
    """True when the claude CLI installed every plugin; else the user finishes in /plugin."""
    claude = shutil.which("claude")
    if not claude:
        return False
    ok = True
    for name, repo in MARKETPLACES.items():
        # Fails harmlessly when the marketplace is already known; install is what counts.
        subprocess.call([claude, "plugin", "marketplace", "add", repo], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if subprocess.call([claude, "plugin", "install", f"{name}@{name}"]) != 0:
            ok = False
    return ok


def conflicts(settings, skills_dir):
    """Standalone caveman/ponytail setups: they duplicate the plugins and write no flag the status line reads."""
    found = []
    try:
        names = sorted(n for n in os.listdir(skills_dir) if n.startswith(("cave", "ponytail", "ultracave", "megacave")))
    except OSError:
        names = []
    if names:
        found.append(f"standalone skills in {skills_dir}: {', '.join(names)}. Delete them; the plugins ship their own")
    for group in settings.get("hooks", {}).get("SessionStart", []):
        for h in group.get("hooks", []):
            cmd = h.get("command", "")
            if "caveman" in cmd or "ponytail" in cmd:
                found.append(f"custom SessionStart hook: {cmd}. Remove it, or the mode loads twice")
    return found


def graphify_dirs():
    """Where a fresh install lands before PATH knows it: uv's tool dir, then pip --user's scripts dir."""
    scheme = sysconfig.get_preferred_scheme("user") if hasattr(sysconfig, "get_preferred_scheme") else f"{os.name}_user"
    return [os.path.expanduser("~/.local/bin"), sysconfig.get_path("scripts", scheme)]


def install_graphify():
    uv = shutil.which("uv")
    cmd = [uv, "tool", "install", "--upgrade", "graphifyy"] if uv else [sys.executable, "-m", "pip", "install", "--user", "--upgrade", "graphifyy"]
    if subprocess.call(cmd) != 0:
        print("graphify install failed. Run it yourself: " + " ".join(cmd[1:] if uv else cmd))
        return
    exe = shutil.which("graphify") or shutil.which("graphify", path=os.pathsep.join(graphify_dirs()))
    if not exe or subprocess.call([exe, "install"]) != 0:
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


def with_plugins(args):
    return "--with-plugins" in args or "--all" in args


def is_ours(hook, subs=tuple(" " + sub for _, sub in HOOKS.values())):
    cmd = hook.get("command", "")
    return "saver.py" in cmd and cmd.endswith(subs)


def apply_settings(settings, args, python, script):
    """Merge claude-saver's keys into settings.json; keep the user's own values."""
    settings["statusLine"] = {
        "type": "command",
        "command": f'{python} "{script}"' + (" --pet" if "--pet" in args else ""),
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

    # check on new sessions only: after /compact or /resume the warning would just repeat.
    for event, (matcher, sub) in HOOKS.items():
        cmd = f'{python} "{os.path.join(os.path.dirname(script), "saver.py")}" {sub}'
        groups = settings.setdefault("hooks", {}).setdefault(event, [])
        if not any(is_ours(h, " " + sub) for g in groups for h in g.get("hooks", [])):
            groups.append({"matcher": matcher, "hooks": [{"type": "command", "command": cmd}]})

    if with_plugins(args):
        markets = settings.setdefault("extraKnownMarketplaces", {})
        plugins = settings.setdefault("enabledPlugins", {})
        for name, repo in MARKETPLACES.items():
            markets.setdefault(name, {"source": {"source": "github", "repo": repo}})
            plugins.setdefault(f"{name}@{name}", True)
    return settings


def remove_settings(settings):
    """Undo apply_settings, dropping only values that match what it writes."""
    if "statusline.py" in (settings.get("statusLine") or {}).get("command", ""):
        del settings["statusLine"]
    env = settings.get("env") or {}
    for key, value in (("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "50"), ("CLAUDE_CODE_SUBAGENT_MODEL", "haiku")):
        if env.get(key) == value:
            del env[key]
    if settings.get("model") == "opusplan":
        del settings["model"]
    deny = (settings.get("permissions") or {}).get("deny")
    if deny:
        deny[:] = [r for r in deny if r not in DENY_READS]
    hooks = settings.get("hooks") or {}
    for event in HOOKS:
        if event in hooks:
            for group in hooks[event]:
                group["hooks"] = [h for h in group.get("hooks", []) if not is_ours(h)]
            hooks[event] = [g for g in hooks[event] if g["hooks"]]
            if not hooks[event]:
                del hooks[event]
    return settings


def changes(before, after, path=""):
    """One line per added (+), removed (-) or changed (~) setting, nested keys dotted."""
    out = []
    for key in sorted(set(before) | set(after)):
        a, b = before.get(key), after.get(key)
        p = f"{path}.{key}" if path else key
        if a == b:
            continue
        if isinstance(a, dict) or isinstance(b, dict):
            if isinstance(a or {}, dict) and isinstance(b or {}, dict):
                out += changes(a or {}, b or {}, p)
                continue
        if isinstance(a, list) or isinstance(b, list):
            if isinstance(a or [], list) and isinstance(b or [], list):
                out += [f"+ {p}: {json.dumps(x)}" for x in b or [] if x not in (a or [])]
                out += [f"- {p}: {json.dumps(x)}" for x in a or [] if x not in (b or [])]
                continue
        sign = "+" if a is None else "-" if b is None else "~"
        out.append(f"{sign} {p}: {json.dumps(a if b is None else b)}")
    return out


def confirm(question):
    """y/n from the terminal, even when this script itself arrived on stdin (curl | python3 -)."""
    if not sys.stdout.isatty():
        return True  # output redirected (CI, scripts): nobody is there to answer
    try:
        with open("CONIN$" if os.name == "nt" else "/dev/tty") as tty:
            print(question + " [Y/n] ", end="", flush=True)
            return tty.readline().strip().lower() in ("", "y", "yes")
    except OSError:
        return True  # no terminal (CI, scripts): running the command was the consent


def uninstall():
    for name in ("statusline.py", "saver.py"):
        try:
            os.remove(os.path.join(CLAUDE_DIR, name))
            print(f"Removed {name}")
        except OSError:
            pass
    for folder in [".statusline-ctx"] + [os.path.join("skills", name) for name in SKILLS]:
        shutil.rmtree(os.path.join(CLAUDE_DIR, folder), ignore_errors=True)
    if os.path.exists(os.path.join(CLAUDE_DIR, "statusline.py.bak")):
        print("Your previous status line script is in statusline.py.bak. Point statusLine at it to keep using it.")
    print("Plugins stay. To remove them: /plugin uninstall ponytail@ponytail and caveman@caveman, graphify uninstall.")


def main():
    os.makedirs(CLAUDE_DIR, exist_ok=True)
    script = os.path.normpath(os.path.join(CLAUDE_DIR, "statusline.py"))
    settings_path = os.path.normpath(os.path.join(CLAUDE_DIR, "settings.json"))
    args = sys.argv[1:]
    unknown = [a for a in args if a not in FLAGS]
    if unknown:
        sys.exit(f"Unknown option: {' '.join(unknown)}\n{__doc__}")

    settings = {}
    if os.path.exists(settings_path):
        try:
            with open(settings_path, encoding="utf-8") as f:
                settings = json.load(f)
        except ValueError as e:
            sys.exit(f"Could not read {settings_path}: {e}\nFix the JSON, then run install.py again.")

    # Decide on settings.json before touching any file, so "no" leaves everything as it was.
    before = json.loads(json.dumps(settings))
    if "--uninstall" in args:
        remove_settings(settings)
    else:
        apply_settings(settings, args, python_cmd(), script)
    diff = changes(before, settings)
    if diff:
        print(f"Changes to {settings_path}:")
        print("\n".join("  " + line for line in diff))
    if "--dry-run" in args:
        print(("Would remove" if "--uninstall" in args else "Would install") + f" statusline.py, saver.py, {', '.join('/' + s for s in SKILLS)} in {CLAUDE_DIR}")
        return
    if diff and "--yes" not in args and not confirm("Apply?"):
        sys.exit("Nothing changed.")

    if "--uninstall" in args:
        uninstall()
    else:
        if os.path.exists(script) and not os.path.exists(script + ".bak"):
            shutil.copy2(script, script + ".bak")
        fetch("statusline.py", script)
        fetch("saver.py", os.path.join(CLAUDE_DIR, "saver.py"))
        print(f"Installed {script}")
        install_skills(python_cmd())

    if diff:
        if os.path.exists(settings_path) and not os.path.exists(settings_path + ".bak"):
            shutil.copy2(settings_path, settings_path + ".bak")
            print(f"Backed up settings to {settings_path}.bak")
        with open(settings_path, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2)
            f.write("\n")
        print(f"Updated {settings_path}")
    if "--uninstall" in args:
        print("Restart Claude Code.")
        return

    if "--graphify" in args or "--all" in args:
        install_graphify()
    if with_plugins(args):
        if install_plugins():
            print("Installed ponytail and caveman plugins")
        else:
            print("Could not install the plugins with the claude CLI. In Claude Code, run:")
            for name, repo in MARKETPLACES.items():
                print(f"  /plugin marketplace add {repo}\n  /plugin install {name}@{name}")
        for c in conflicts(settings, os.path.join(CLAUDE_DIR, "skills")):
            print("Warning: " + c)
    print("Restart Claude Code." + ("" if "--all" in args else " Run with --all to add ponytail, caveman and graphify."))


if __name__ == "__main__":
    main()
