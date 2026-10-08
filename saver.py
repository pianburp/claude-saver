#!/usr/bin/env python3
"""Token tools for Claude Code.

  saver.py audit            what loads before you type: CLAUDE.md, memory, rules, MCP, ignores
  saver.py check            one line if those files need trimming, else nothing (SessionStart hook)
  saver.py savings [FILE]   this session's token use and estimated savings (default: newest transcript)
  saver.py savings --week   tokens saved per day over the last 7 days (recorded by the status line)
  saver.py pet              the status line pet: stage, age, lifetime tokens saved
  saver.py wrapped          the last 7 days as a Wrapped-style HTML page, opened in the browser
  saver.py guard            tells Claude when a tool output is 2k+ tokens, and remembers the command (PostToolUse hook)
  saver.py secrets          blocks .env access, hardcoded keys, lockfile/huge reads and unchanged re-reads (PreToolUse hook)
  saver.py handoff          prints where /handoff writes its note; the next session's startup check shows it once
  saver.py toggle [NAME [on|off]]  turn pet, check, guard, secrets or reads on/off mid-session; no args lists them

Token counts are chars/4, the same approximation graphify and most tools use.
"""

import glob
import json
import os
import re
import sys
import time
from collections import Counter
from datetime import date, datetime, timedelta
from html import escape
from pathlib import Path

from statusline import detect_ttl, save_state, state_path

CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
LONG_FILE = 500  # tokens; Firecrawl's guide targets 200-500 for CLAUDE.md
MEMORY_LINES, MEMORY_BYTES = 200, 25000  # auto memory loads only this much of MEMORY.md
# Published reductions. Sources: caveman README (65% avg output cut),
# ponytail benchmarks (80-94% fewer lines; low end used).
CAVEMAN_CUT = 0.65
PONYTAIL_CUT = 0.80
# ponytail: guess, not measured. Each graph query is assumed to replace this many file reads.
GRAPHIFY_READS_AVOIDED = 5
DEFAULT_READ_TOKENS = 1500  # used when the session has no Read calls to average
NOISY = 2000  # tokens; a tool result this big rides along on every later call
NOISY_REPEAT = 3  # the startup check names a command once the guard has flagged it this often
CACHE_READ_PRICE = 0.1  # cache reads bill at 10% of input
BIG_READ = 40_000  # bytes (~10k tokens); a whole Read of a file this big is skipped
LOCKFILES = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "cargo.lock",
             "composer.lock", "gemfile.lock", "uv.lock", "bun.lock"}
MINIFIED = (".min.js", ".min.css", ".map")
MEDIA = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".pdf", ".ipynb")  # Read handles these itself
HANDOFF_DAYS = 7
MANY_FILES = 1000  # a gitignored folder this big is flagged like node_modules
HEAVY_DIRS = ("node_modules", "dist", "build", ".next", "__pycache__", "coverage", ".venv", "venv", "target")


def tokens(text):
    return len(text) // 4


def fmt(n):
    return f"{n / 1e6:.1f}M" if n >= 1e6 else f"{n / 1e3:.1f}k" if n >= 1e3 else str(int(n))


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def load_json(path):
    try:
        return json.loads(read(path) or "")
    except ValueError:
        return {}


def project_slug(cwd):
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def ctx_file(*parts):
    return os.path.join(CLAUDE_DIR, ".statusline-ctx", *parts)


def cmd_key(cmd):
    """`npm test` from `cd app && npm test -- --watch | tail`: up to two words, before any flag, quote, pipe or redirect."""
    words = []
    for w in re.sub(r"^\s*cd\s+\S+\s*(?:&&|;)\s*", "", str(cmd)).split():
        if len(words) == 2 or w[0] in "-'\"|<>&;$(`":
            break
        words.append(w)
    return " ".join(words)


# ---------- audit ----------

def visible(text):
    """Text Claude actually receives: HTML comments cost nothing."""
    return re.sub(r"<!--.*?-->", "", text, flags=re.S)


def imports(text, base):
    """@path imports outside code, resolved and existing."""
    text = re.sub(r"```.*?```|`[^`\n]*`", "", text, flags=re.S)
    found = []
    for m in re.finditer(r"(?:^|\s)@(~?[\w./\\-]+)", text):
        path = os.path.normpath(os.path.join(base, os.path.expanduser(m.group(1))))
        if os.path.isfile(path):
            found.append(path)
    return found


def always_loaded(cwd):
    """Instruction files Claude Code loads every session, in load order, with @imports."""
    paths = [os.path.join(CLAUDE_DIR, "CLAUDE.md")]
    paths += glob.glob(os.path.join(CLAUDE_DIR, "rules", "*.md"))
    chain, d = [], os.path.abspath(cwd)
    while True:
        chain.append(d)
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    claude_names = ("CLAUDE.md", "CLAUDE.local.md", os.path.join(".claude", "CLAUDE.md"))
    # AGENTS.md loads instead, but only when no CLAUDE.md exists in cwd or above.
    # ~/.claude/CLAUDE.md is global and does not count, though it looks like <home>/.claude/CLAUDE.md.
    user_md = os.path.normcase(os.path.abspath(os.path.join(CLAUDE_DIR, "CLAUDE.md")))
    has_claude = any(os.path.isfile(p) and os.path.normcase(os.path.abspath(p)) != user_md
                     for p in (os.path.join(d, n) for d in chain for n in claude_names))
    names = claude_names if has_claude else ("AGENTS.md", os.path.join(".claude", "AGENTS.md"))
    for d in reversed(chain):
        paths += [os.path.join(d, n) for n in names]
    paths += glob.glob(os.path.join(cwd, ".claude", "rules", "*.md"))
    paths.append(os.path.join(CLAUDE_DIR, "projects", project_slug(cwd), "memory", "MEMORY.md"))

    out, seen = [], set()
    todo = [(p, 0) for p in paths]
    while todo:
        path, depth = todo.pop(0)
        path = os.path.normpath(path)
        if path in seen or not os.path.isfile(path):
            continue
        seen.add(path)
        text = read(path) or ""
        # Rules with paths: frontmatter load only when matching files are touched.
        if os.sep + "rules" + os.sep in path and re.search(r"(?m)^paths\s*:", (re.match(r"---\n(.*?)\n---", text, re.S) or [""])[0]):
            continue
        out.append((path, text))
        if depth < 5:
            todo += [(p, depth + 1) for p in imports(text, os.path.dirname(path))]
    return out


def file_findings(path, text, cwd):
    out = []
    seen_text = visible(text)
    n = tokens(seen_text)
    if n > LONG_FILE:
        out.append(f"long: {fmt(n)} tokens, target under {LONG_FILE}")
    if os.path.basename(path) == "MEMORY.md" and (len(text.splitlines()) > MEMORY_LINES or len(text.encode()) > MEMORY_BYTES):
        out.append(f"truncated: only the first {MEMORY_LINES} lines or {MEMORY_BYTES // 1000}KB load, the rest is dropped")
    if os.sep + "rules" + os.sep in path:
        out.append("loads every session: add `paths:` frontmatter if it only matters for some files")
    for block in re.findall(r"```.*?```", seen_text, flags=re.S):
        lines = block.count("\n")
        if lines > 10:
            out.append(f"code block of {lines} lines: move to a skill or doc file")
    base = os.path.dirname(path)
    for span in set(re.findall(r"`([^`\s]+)`", seen_text)):
        if not re.fullmatch(r"[\w.~-]*[/\\][\w./\\-]*\.\w{1,5}", span):
            continue
        cands = [os.path.join(b, os.path.expanduser(span)) for b in (cwd, base)]
        if not any(os.path.exists(c) for c in cands):
            out.append(f"maybe stale path: {span}")
    return out


def duplicate_lines(files):
    where = {}
    for path, text in files:
        for line in visible(text).splitlines():
            key = re.sub(r"\W+", " ", line).strip().lower()
            if len(key) > 25:
                where.setdefault(key, []).append(path)
    return [(k, v) for k, v in where.items() if len(v) > 1]


def settings_files(cwd):
    return [os.path.join(CLAUDE_DIR, "settings.json"),
            os.path.join(cwd, ".claude", "settings.json"),
            os.path.join(cwd, ".claude", "settings.local.json")]


def env_value(name, cwd):
    if name in os.environ:
        return os.environ[name]
    for path in settings_files(cwd):
        value = (load_json(path).get("env") or {}).get(name)
        if value is not None:
            return str(value)
    return None


def mcp_servers(cwd):
    # Project .mcp.json only: ~/.claude.json also holds account and MCP credentials, so it is never read.
    return sorted(load_json(os.path.join(cwd, ".mcp.json")).get("mcpServers") or {})


def many_files(path):
    """True once MANY_FILES files are seen; stops early so the startup check stays fast."""
    count = 0
    for _, _, names in os.walk(path):
        count += len(names)
        if count >= MANY_FILES:
            return True
    return False


def gitignored_dirs(cwd):
    """Plain folder names from cwd/.gitignore (`dist/`, `/storage`, `cache/**`); globs and negations skipped."""
    out = []
    for line in (read(os.path.join(cwd, ".gitignore")) or "").splitlines():
        name = re.sub(r"/\*\*$", "", line.strip()).strip("/")
        if name and not re.search(r"[#!*?\[\]/\\\s]", name) and not name.startswith(".claude"):
            out.append(name)
    return out


def unblocked_heavy(cwd):
    """Known heavy folders, plus gitignored ones over MANY_FILES files, not in permissions.deny."""
    deny = " ".join(r for p in settings_files(cwd)
                    for r in ((load_json(p).get("permissions") or {}).get("deny") or []))
    found = [d for d in HEAVY_DIRS if os.path.isdir(os.path.join(cwd, d)) and d not in deny]
    for d in gitignored_dirs(cwd):
        path = os.path.join(cwd, d)
        if d not in found and d not in deny and os.path.isdir(path) and many_files(path):
            found.append(d)
    return found


def unpinned_agents(cwd):
    """Custom subagents with no `model:` in their frontmatter: they run on the main model."""
    out = []
    for path in glob.glob(os.path.join(CLAUDE_DIR, "agents", "*.md")) + glob.glob(os.path.join(cwd, ".claude", "agents", "*.md")):
        front = (re.match(r"---\n(.*?)\n---", read(path) or "", re.S) or [""])[0]
        if not re.search(r"(?m)^model\s*:", front):
            out.append(os.path.splitext(os.path.basename(path))[0])
    return sorted(out)


def plugin_listings(cwd):
    """(plugin, items, tokens) for each enabled plugin's skills, agents and commands, listed to Claude every call."""
    enabled = {}
    for path in settings_files(cwd):
        enabled.update(load_json(path).get("enabledPlugins") or {})
    installed = load_json(os.path.join(CLAUDE_DIR, "plugins", "installed_plugins.json")).get("plugins") or {}
    out = []
    for name, on in enabled.items():
        # ponytail: first install path wins; a plugin installed twice at different versions is counted once
        root = next((e.get("installPath") for e in installed.get(name) or [] if isinstance(e, dict) and e.get("installPath")), None)
        if on is not True or not root:
            continue
        n = total = 0
        for pattern in ("skills/*/SKILL.md", "agents/*.md", "commands/*.md"):
            for path in glob.glob(os.path.join(root, pattern)):
                front = (re.match(r"---\r?\n(.*?)\r?\n---", read(path) or "", re.S) or [""])[0]
                if front and not re.search(r"(?m)^disable-model-invocation\s*:\s*true", front):
                    n, total = n + 1, total + tokens(front)
        if n:
            out.append((name.split("@")[0], n, total))
    return sorted(out, key=lambda p: -p[2])


def hook_injections(path):
    """{source: [tokens, times]} for hook text added to context in a transcript (SessionStart stdout, additionalContext).

    Source is the text's first word: `CAVEMAN MODE ACTIVE` counts as caveman, `claude-saver:` as claude-saver.
    """
    out = {}
    for line in ((read(path) if path else None) or "").splitlines():
        try:
            att = json.loads(line).get("attachment")
        except (ValueError, AttributeError):
            continue
        if not isinstance(att, dict):
            continue
        if att.get("type") == "hook_additional_context":
            texts = att.get("content") if isinstance(att.get("content"), list) else [att.get("content")]
        elif att.get("type") == "hook_success" and att.get("hookEvent") == "SessionStart":
            texts = [att.get("content")]  # plain stdout becomes context; JSON output arrives as hook_additional_context
        else:
            continue
        for text in texts:
            if isinstance(text, str) and text.strip() and not text.lstrip().startswith("{"):
                name = re.match(r"[\w-]*", text.strip()).group().lower() or "other"
                row = out.setdefault(name, [0, 0])
                row[0], row[1] = row[0] + tokens(text), row[1] + 1
    return out


def tool_search_off(cwd):
    return (env_value("ENABLE_TOOL_SEARCH", cwd) or "").lower() in ("0", "false")


def audit(cwd):
    files = always_loaded(cwd)
    total = sum(tokens(visible(t)) for _, t in files)
    print(f"Always-loaded instructions: ~{fmt(total)} tokens, re-read on every API call\n")
    for path, text in files:
        print(f"  {fmt(tokens(visible(text))):>6}  {path}")
        for finding in file_findings(path, text, cwd):
            print(f"          - {finding}")
    dups = duplicate_lines(files)
    if dups:
        print("\nDuplicate lines (say it once):")
        for line, paths in dups[:10]:
            print(f"  - \"{line[:60]}\" in {len(paths)} places: {', '.join(sorted(set(os.path.basename(p) for p in paths)))}")

    tips = []
    servers = mcp_servers(cwd)
    if servers:
        tip = f"{len(servers)} MCP server(s): {', '.join(servers)}. Each can cost 10-20k tokens of tool schemas."
        if tool_search_off(cwd):
            tip += " ENABLE_TOOL_SEARCH is off: turn it on to load schemas on demand."
        tips.append(tip + " Disconnect the ones you do not use.")
    tips.append("User-scoped MCP servers are not counted here. Run /mcp to see them all.")
    heavy = unblocked_heavy(cwd)
    if os.path.isfile(os.path.join(cwd, ".claudeignore")):
        tips.append("Claude Code does not read .claudeignore. Move its entries to permissions.deny.")
    if heavy:
        rules = ", ".join(f'"Read(./{d}/**)"' for d in heavy)
        tips.append(f"Unblocked heavy dirs: {', '.join(heavy)}. Add to permissions.deny in .claude/settings.json: {rules}")
    if not env_value("CLAUDE_CODE_SUBAGENT_MODEL", cwd):
        tip = "Subagents use your main model. CLAUDE_CODE_SUBAGENT_MODEL=haiku makes exploration and log reading cheaper."
        agents = unpinned_agents(cwd)
        if agents:
            tip += f" Or add `model: haiku` to these agents: {', '.join(agents)}."
        tips.append(tip)
    skills = glob.glob(os.path.join(CLAUDE_DIR, "skills", "*", "SKILL.md")) + glob.glob(os.path.join(cwd, ".claude", "skills", "*", "SKILL.md"))
    if skills:
        tips.append(f"{len(skills)} user/project skill(s), ~30-100 tokens each for the description. Skills you only run by hand: add `disable-model-invocation: true`.")
    plugins = plugin_listings(cwd)
    if plugins:
        listed = ", ".join(f"{name} {n} (~{fmt(t)})" for name, n, t in plugins)
        tips.append(f"Plugins list skills and agents on every call: {listed}. "
                    "Disable plugins you do not use with /plugin.")
    injected = hook_injections(newest_transcript(cwd))
    if injected:
        listed = ", ".join(f"{name} ~{fmt(t)} ({n}x)" for name, (t, n) in sorted(injected.items(), key=lambda p: -p[1][0]))
        tips.append(f"Hooks added text to the last session: {listed}. It stays in history and is re-read on every "
                    "later call. Turn off modes you do not need for the task (stop caveman, stop ponytail, /plugin).")
    if not any(re.search(r"(?im)^#+\s*compact instructions", t) for _, t in files):
        tips.append("No \"## Compact instructions\" section in CLAUDE.md. Add one to say what /compact and auto-compact must keep.")
    if not env_value("BASH_MAX_OUTPUT_LENGTH", cwd):
        tips.append("BASH_MAX_OUTPUT_LENGTH is unset. Set it in settings.json env (e.g. 15000 chars) to cap shell output in context.")
    if detect_ttl(newest_transcript(cwd)) == 300 and not env_value("ENABLE_PROMPT_CACHING_1H", cwd):
        tips.append("Prompt cache lasts 5 minutes. ENABLE_PROMPT_CACHING_1H=1 keeps it 1 hour; cache writes then cost 2x input instead of 1.25x.")
    if tips:
        print("\nOther overhead:")
        for tip in tips:
            print(f"  - {tip}")


def handoff_path(cwd):
    return ctx_file("handoff", project_slug(os.path.abspath(cwd)) + ".md")


def noisy_counts(cwd):
    """{command key: times the guard flagged it} for this project."""
    data = load_json(ctx_file("noisy.json"))
    counts = data.get(os.path.normcase(os.path.abspath(cwd))) if isinstance(data, dict) else None
    return counts if isinstance(counts, dict) else {}


def check(cwd, source="startup"):
    """The /handoff note once, then (new sessions only) one line when something costs tokens every session.

    source is SessionStart's: "startup" warns, "clear" only shows the note, None (switched off) only the note.
    Nothing otherwise: hook output costs context.
    """
    note_path = handoff_path(cwd)
    note = read(note_path)
    if note is not None:
        fresh = time.time() - os.path.getmtime(note_path) < HANDOFF_DAYS * 86400
        os.remove(note_path)  # one-shot: a stale task note misleads more than it helps
        if fresh and note.strip():
            print("claude-saver: handoff note from the last session (from /handoff):\n" + note.strip())
    if source != "startup":
        return
    files = always_loaded(cwd)
    flagged = [os.path.basename(p) for p, t in files
               if any(f.startswith(("long", "truncated")) for f in file_findings(p, t, cwd))]
    issues = []
    if flagged:
        total = sum(tokens(visible(t)) for _, t in files)
        issues.append(f"always-loaded instructions ~{fmt(total)} tokens; needs trimming: {', '.join(flagged)}")
    heavy = unblocked_heavy(cwd)
    if heavy:
        issues.append(f"unblocked heavy dirs: {', '.join(heavy)}")
    servers = mcp_servers(cwd)
    if servers and tool_search_off(cwd):
        issues.append(f"{len(servers)} MCP server(s) with ENABLE_TOOL_SEARCH off")
    tip = (" Tell the user to run /token-audit" + (" or /doctor prompt-audit (stale or conflicting lines)." if flagged else ".")
           if issues else "")
    # Once the user notes the command in CLAUDE.md (or any always-loaded file), this goes quiet.
    loaded = "\n".join(t for _, t in files)
    loud = sorted(((n, k) for k, n in noisy_counts(cwd).items()
                   if isinstance(n, int) and n >= NOISY_REPEAT and k not in loaded), reverse=True)
    if loud:
        n, k = loud[0]
        issues.append(f"`{k}` printed 2k+ tokens {n} times; add its quiet flag to CLAUDE.md")
    if issues:
        print(f"claude-saver: {'; '.join(issues)}.{tip}")


# ---------- savings ----------

def newest_transcript(cwd):
    for pattern in (os.path.join(CLAUDE_DIR, "projects", project_slug(cwd), "*.jsonl"),
                    os.path.join(CLAUDE_DIR, "projects", "*", "*.jsonl")):
        found = glob.glob(pattern)
        if found:
            return max(found, key=os.path.getmtime)
    return None


def result_text(content):
    if isinstance(content, list):
        return "".join(c.get("text", "") for c in content if isinstance(c, dict))
    return content if isinstance(content, str) else ""


STOP_WORDS = {"caveman": ("stop caveman", "normal mode"), "ponytail": ("stop ponytail", "normal mode")}


def mode_switch(entry, on, s):
    """Turn caveman/ponytail on at a hook's MODE ACTIVE marker, off at the user's stop phrase.

    The marker counts in hook output and user messages, never in a tool result or an edited file that quotes it.
    The stop phrase counts only in a prompt the user typed: skill bodies (isMeta) quote it in their instructions.
    """
    if not isinstance(entry, dict):
        return
    msg, att, typed = entry.get("message"), entry.get("attachment"), False
    if isinstance(att, dict) and str(att.get("type", "")).startswith("hook_"):
        text = json.dumps(att)
    elif isinstance(msg, dict) and msg.get("role") == "user":
        content = msg.get("content")
        text = content if isinstance(content, str) else "".join(
            c.get("text", "") for c in content or [] if isinstance(c, dict) and c.get("type") == "text")
        typed = not entry.get("isMeta")
    else:
        return
    for name in on:
        if f"{name.upper()} MODE ACTIVE" in text:
            on[name] = s[name] = True
        elif typed and any(w in text.lower() for w in STOP_WORDS[name]):
            on[name] = False


def session_stats(path):
    """Usage deduped by message id (one transcript line per content block) plus content sizes."""
    s = {"input": 0, "cache_write": 0, "cache_read": 0, "output": 0, "calls": 0,
         "text": 0, "code": 0, "caveman": False, "ponytail": False,
         "cave_text": 0, "on_text": 0, "on_replies": 0, "off_text": 0, "off_replies": 0, "pony_code": 0,
         "reads": [], "graph_queries": [], "graph_results": 0, "noisy": [], "model_switches": 0,
         "cwd": None, "stamps": [], "denied": [], "compacts": [], "main_calls": 0}
    seen, tool_names, tool_labels, results, commands, model = set(), {}, {}, {}, {}, None
    files = [path] + glob.glob(os.path.join(os.path.splitext(path)[0], "subagents", "*.jsonl"))
    for f in files:
        # ponytail: each subagent file starts with both modes off; its replies earn credit only if a hook marked it
        on = {"caveman": False, "ponytail": False}
        for line in (read(f) or "").splitlines():
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            mode_switch(entry, on, s)
            meta = entry.get("compactMetadata") if isinstance(entry, dict) else None
            if f == path and isinstance(meta, dict) and meta.get("trigger") == "auto":
                dropped = (meta.get("preTokens") or 0) - (meta.get("postTokens") or 0)
                s["compacts"].append((max(0, dropped), s["calls"]))
            msg = entry.get("message") if isinstance(entry, dict) else None
            if not isinstance(msg, dict):
                continue
            if not s["cwd"] and isinstance(entry.get("cwd"), str):
                s["cwd"] = entry["cwd"]
            usage = msg.get("usage")
            if msg.get("role") == "assistant" and isinstance(usage, dict) and msg.get("id") not in seen:
                seen.add(msg.get("id"))
                s["calls"] += 1
                s["input"] += usage.get("input_tokens") or 0
                s["cache_write"] += usage.get("cache_creation_input_tokens") or 0
                s["cache_read"] += usage.get("cache_read_input_tokens") or 0
                s["output"] += usage.get("output_tokens") or 0
                try:  # local time of each call, for /wrapped
                    s["stamps"].append(datetime.fromisoformat(entry["timestamp"].replace("Z", "+00:00")).astimezone())
                except (KeyError, AttributeError, ValueError):
                    pass
                # Main thread only: subagents run other models on purpose. The cache is per model.
                name = msg.get("model")
                if f == path and name and not name.startswith("<"):
                    s["model_switches"] += bool(model and name != model)
                    model = name
            for block in msg.get("content") if isinstance(msg.get("content"), list) else []:
                if not isinstance(block, dict):
                    continue
                kind = block.get("type")
                if kind == "text" and msg.get("role") == "assistant":
                    n = tokens(block.get("text", ""))
                    s["text"] += n
                    if on["caveman"]:
                        s["cave_text"] += n
                    if f == path:  # main thread only: the measured cut compares like with like
                        mode = "on" if on["caveman"] else "off"
                        s[mode + "_text"] += n
                        s[mode + "_replies"] += 1
                elif kind == "tool_use":
                    name, args = block.get("name", ""), block.get("input") or {}
                    tool_names[block.get("id")] = name
                    target = os.path.basename(str(args.get("file_path") or "")) or args.get("pattern") or ""
                    tool_labels[block.get("id")] = str(args.get("command") or f"{name} {target}".strip())[:60]
                    if name in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
                        code = args.get("content") or args.get("new_string") or args.get("new_source") or ""
                        code += "".join(e.get("new_string", "") for e in args.get("edits") or [])
                        s["code"] += tokens(code)
                        if on["ponytail"]:
                            s["pony_code"] += tokens(code)
                    cmd = str(args.get("command", ""))
                    if name == "Bash":
                        commands[block.get("id")] = cmd
                    if "graphify" in name or re.search(r"\bgraphify\s+(query|path|explain)\b", cmd):
                        s["graph_queries"].append(block.get("id"))
                elif kind == "tool_result":
                    text = result_text(block.get("content"))
                    results[block.get("tool_use_id")] = tokens(text)
                    if tool_names.get(block.get("tool_use_id")) == "Read" and re.match(r"Permission to read .+ has been denied", text):
                        s["denied"].append(None)  # size unknown: priced at the average read
                    hit = re.search(r"claude-saver: skipped[^~]*~([\d.]+)([kM]?) tokens", text)
                    if hit and tool_names.get(block.get("tool_use_id")) in ("Read",) + SHELLS:
                        s["denied"].append(float(hit.group(1)) * {"": 1, "k": 1e3, "M": 1e6}[hit.group(2)])
        if f == path:
            s["main_calls"] = s["calls"]
    # Guard: a noisy command run again with less output, e.g. after the hint, saved the difference.
    s["guard_saved"], first = 0, {}
    for i, n in results.items():
        key = cmd_key(commands[i]) if i in commands else ""
        if key in first:
            s["guard_saved"] += max(0, first.pop(key) - n)
        elif key and n >= NOISY:
            first[key] = n
    s["tools"] = Counter(tool_names.values())
    s["reads"] = [n for i, n in results.items() if tool_names.get(i) == "Read"]
    s["graph_results"] = sum(results.get(i, 0) for i in s["graph_queries"])
    s["noisy_count"] = sum(n >= NOISY for n in results.values())
    s["noisy"] = sorted(((n, tool_labels.get(i, "?")) for i, n in results.items() if n >= NOISY), reverse=True)[:3]
    return s


def saved_rows(s):
    """Estimated savings as (name, tokens, kind, why); shared by /savings and the status line."""
    rows = []
    per_read = sum(s["reads"]) // len(s["reads"]) if s["reads"] else DEFAULT_READ_TOKENS
    # Upper bounds: they assume every reply was cut by the benchmark rate, and a reply that drifted long still earns it.
    if s["cave_text"]:
        rows.append(("caveman", s["cave_text"] * CAVEMAN_CUT / (1 - CAVEMAN_CUT), "output",
                     f"up to {CAVEMAN_CUT:.0%} cut on {fmt(s['cave_text'])} reply tokens while on (caveman benchmark)"))
    if s["pony_code"]:
        rows.append(("ponytail", s["pony_code"] * PONYTAIL_CUT / (1 - PONYTAIL_CUT), "output",
                     f"up to {PONYTAIL_CUT:.0%} fewer lines on {fmt(s['pony_code'])} code tokens while on "
                     "(ponytail benchmark, low end)"))
    if s["graph_queries"]:
        saved = max(0, len(s["graph_queries"]) * GRAPHIFY_READS_AVOIDED * per_read - s["graph_results"])
        rows.append(("graphify", saved, "input",
                     f"{len(s['graph_queries'])} queries × {GRAPHIFY_READS_AVOIDED} reads of ~{fmt(per_read)} avoided (assumption)"))
    if s["denied"]:
        rows.append(("reads", sum(n or per_read for n in s["denied"]), "input",
                     f"{len(s['denied'])} reads blocked by deny rules or the read guards (folder denials at ~{fmt(per_read)} each)"))
    if s["guard_saved"]:
        rows.append(("guard", s["guard_saved"], "input", "noisy commands run again with less output"))
    # ponytail: credits every auto-compact, not only the head start CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 gives;
    # a second compact does not cut the first one's credit short.
    compact = sum(d * (s["main_calls"] - at) for d, at in s["compacts"]) * CACHE_READ_PRICE
    if compact:
        rows.append(("compact", compact, "input",
                     f"{len(s['compacts'])} auto-compact(s): dropped tokens × later calls, at the 10% cache-read price"))
    return rows


def savings(path, cwd):
    if not path or not os.path.isfile(path):
        sys.exit("No session transcript found. Pass its path: saver.py savings FILE.jsonl")
    s = session_stats(path)
    print(f"Session {os.path.basename(path)[:8]}: {s['calls']} API calls")
    print(f"  used     input {fmt(s['input'])} · cache write {fmt(s['cache_write'])} · "
          f"cache read {fmt(s['cache_read'])} · output {fmt(s['output'])}\n")

    rows = saved_rows(s)
    print("Saved **estimated")
    if not rows:
        print("  nothing yet: no caveman, ponytail or graphify use, blocked reads, quieter reruns or auto-compacts")
    for name, n, kind, why in rows:
        print(f"  {name:<9} {'~' + fmt(n):>7} {kind:<6}  {why}")
    if rows:
        print(f"  {'total':<9} {'~' + fmt(sum(r[1] for r in rows)):>7}")
    print(f"\n  prompt cache  {fmt(s['cache_read'])} input tokens billed at 10% (exact, built into Claude Code)")
    print(f"  caveman       {measured_cut(cwd)}")

    if s["noisy"]:
        print("\nBiggest tool outputs (re-read on every later call; use quiet flags or a subagent):")
        for n, label in s["noisy"]:
            print(f"  {fmt(n):>6}  {label}")
    if s["model_switches"]:
        print(f"\nModel switched {s['model_switches']}x: each switch re-writes the conversation to a new cache. "
              "Pick /model and /effort at the start.")

    memory = sum(tokens(visible(t)) for _, t in always_loaded(cwd))
    if memory:
        print(f"\nOverhead: CLAUDE.md + memory ~{fmt(memory)} tokens × {s['calls']} calls = "
              f"~{fmt(memory * s['calls'])}. Run /token-audit to trim it.")


MEASURE_SESSIONS, MEASURE_MIN = 30, 20  # newest transcripts read; replies needed on each side


def measured_cut(cwd):
    """Caveman's real cut in this project: average reply size with it on vs off, newest sessions."""
    found = sorted(glob.glob(os.path.join(CLAUDE_DIR, "projects", project_slug(cwd), "*.jsonl")),
                   key=os.path.getmtime)[-MEASURE_SESSIONS:]
    t = Counter()
    for p in found:
        s = session_stats(p)
        t.update({k: s[k] for k in ("on_text", "on_replies", "off_text", "off_replies")})
    if min(t["on_replies"], t["off_replies"]) < MEASURE_MIN:
        return (f"measured: not enough replies yet ({t['on_replies']} on, {t['off_replies']} off, "
                f"{MEASURE_MIN} each needed). Work a session with `stop caveman` to compare.")
    on, off = t["on_text"] / t["on_replies"], t["off_text"] / t["off_replies"]
    return (f"measured: replies avg {fmt(on)} tokens on vs {fmt(off)} off, {1 - on / off:.0%} shorter "
            f"({t['on_replies']}/{t['off_replies']} replies, last {len(found)} sessions; tasks differ, so rough)")


def ledger():
    """The status line's record of tokens saved: {"total", "born", "days": {"YYYY-MM-DD": n}}."""
    data = load_json(os.path.join(CLAUDE_DIR, ".statusline-ctx", "ledger.json"))
    return data if isinstance(data, dict) else {}


def week(today=None):
    days = ledger().get("days") or {}
    today = today or date.today()
    rows = [(d, days.get(d.isoformat()) or 0) for d in (today - timedelta(i) for i in range(6, -1, -1))]
    top = max(n for _, n in rows)
    if not top:
        print("Nothing recorded in the last 7 days. The status line records savings while it runs.")
        return
    print("Saved per day **estimated, recorded by the status line")
    for d, n in rows:
        print(f"  {d:%a %m-%d}  {'█' * round(n / top * 20):<20}  {'~' + fmt(n) if n else '-'}")
    print(f"  {'total':<9}  {'':<20}  ~{fmt(sum(n for _, n in rows))}")


def pet(now=None):
    from statusline import PET_CRACK, PET_STAGES, PET_WIDTH, pet_rows
    data = ledger()
    total = data.get("total")
    total = total if isinstance(total, (int, float)) else 0
    stage = next((s for s in PET_STAGES if total >= s[0]), None)
    born = data.get("born")
    age = f", {int(((now or time.time()) - born) // 86400)} days old" if isinstance(born, (int, float)) else ""
    ahead = [s[0] for s in PET_STAGES if total < s[0]]
    nxt = f"next stage at {fmt(ahead[-1])} ({total / ahead[-1]:.0%})" if ahead else "fully grown"
    for row, text in zip(pet_rows(stage, cracked=total >= PET_CRACK), (f"~{fmt(total)} tokens saved, lifetime{age}", nxt, "")):
        print(f"{row:<{PET_WIDTH}}{text}".rstrip())


WRAPPED_PAGE = """<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Claude Wrapped</title>
<style>
:root{color-scheme:dark;--bg:#14101f;--fg:#f4efe6;--dim:#a99fbd}
*{box-sizing:border-box;margin:0}
body{min-height:100vh;padding:48px 16px;color:var(--fg);font:16px/1.4 system-ui,sans-serif;
 background:radial-gradient(circle at 15% 0,#3b1f5c,transparent 55%),radial-gradient(circle at 90% 100%,#5c2a1f,transparent 50%),var(--bg)}
main{max-width:880px;margin:auto}
header p{color:var(--dim);letter-spacing:.2em;text-transform:uppercase;font-size:13px}
h1{font-size:clamp(44px,10vw,92px);line-height:.95;font-weight:800;margin:8px 0 32px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.card{border-radius:20px;padding:24px;background:var(--a);color:var(--bg);animation:pop .6s both}
.wide{grid-column:1/-1}
small{text-transform:uppercase;letter-spacing:.15em;font-size:12px;font-weight:700;opacity:.7}
.card b{display:block;font-size:clamp(28px,5vw,44px);line-height:1.05;margin:10px 0 6px;overflow-wrap:anywhere}
.card span{font-size:14px;opacity:.8;overflow-wrap:anywhere}
.chart{display:flex;align-items:end;gap:10px;height:140px;margin:16px 0 22px}
.chart div{flex:1;min-height:4px;border-radius:6px 6px 0 0;background:var(--bg);position:relative}
.chart i{position:absolute;bottom:-22px;left:0;right:0;text-align:center;font:600 12px system-ui}
pre{font:22px/1.05 ui-monospace,Consolas,monospace;color:#d97757;margin:12px 0}
@keyframes pop{from{opacity:0;transform:translateY(16px) scale(.97)}}
@media (prefers-reduced-motion:reduce){.card{animation:none}}
</style>
<main><header><p>$range</p><h1>Your week<br>with Claude</h1></header><div class="grid">$cards</div></main>
"""
WRAPPED_COLORS = ("#f7c948", "#7ee0b3", "#ff8fa3", "#8ab4ff", "#c9a7ff", "#ffb27a", "#b8f27c", "#f4efe6")


def wrapped(today=None, show=True):
    """The last 7 days across every project as a Wrapped-style HTML page."""
    from string import Template
    from statusline import PET_CRACK, PET_STAGES, pet_rows
    today = today or date.today()
    start = today - timedelta(6)
    cutoff = time.mktime(start.timetuple())
    stats = [session_stats(p) for p in glob.glob(os.path.join(CLAUDE_DIR, "projects", "*", "*.jsonl"))
             if os.path.getmtime(p) >= cutoff]
    for s in stats:
        s["stamps"] = [t for t in s["stamps"] if start <= t.date() <= today]
    stats = [s for s in stats if s["stamps"]]
    if not stats:
        print("No Claude Code activity in the last 7 days.")
        return
    stamps = [t for s in stats for t in s["stamps"]]
    projects = Counter()
    for s in stats:
        projects[os.path.basename((s["cwd"] or "?").rstrip("/\\")) or s["cwd"]] += len(s["stamps"])
    by_day, hours = Counter(t.date() for t in stamps), Counter(t.hour for t in stamps)
    tools = sum((s["tools"] for s in stats), Counter()).most_common(3)
    (busiest, busiest_n), peak = by_day.most_common(1)[0], hours.most_common(1)[0][0]
    loud = max((n for s in stats for n in s["noisy"]), default=None)
    data = ledger()
    saved = sum((data.get("days") or {}).get((start + timedelta(i)).isoformat()) or 0 for i in range(7))
    total = data.get("total") if isinstance(data.get("total"), (int, float)) else 0
    top_project, top_n = projects.most_common(1)[0]

    # (kicker, big, sub); ponytail: tokens are whole sessions, a session that began before the week counts in full
    cards = [
        ("You and Claude", f"{len(stamps):,}", f"API calls across {len(stats)} sessions"),
        ("Top project", top_project, f"{top_n:,} calls · {len(projects)} projects this week"),
        ("Busiest day", f"{busiest:%A}", f"{busiest_n:,} calls on {busiest:%b %d}"),
        ("Your type", "Night owl" if peak >= 22 or peak < 5 else "Early bird" if peak < 9 else "Daylight builder",
         f"Most calls at {peak:02d}:00"),
    ]
    if tools:
        cards.append(("Favourite tool", tools[0][0], f"{tools[0][1]:,} uses" + "".join(f" · then {t}" for t, _ in tools[1:])))
    cards.append(("Claude wrote", f"{fmt(sum(s['output'] for s in stats))} tokens",
                  f"and re-read {fmt(sum(s['cache_read'] for s in stats))} from cache at a tenth of the price"))
    if saved:
        cards.append(("Saved", f"~{fmt(saved)}", "tokens, estimated: modes, graphify, guards and auto-compact"))
    if loud:
        cards.append(("Loudest command", f"{fmt(loud[0])} tokens", loud[1]))

    html = [f'<div class="card" style="--a:{WRAPPED_COLORS[i % len(WRAPPED_COLORS)]};animation-delay:{i * .08:.2f}s">'
            f"<small>{escape(k)}</small><b>{escape(big)}</b><span>{escape(sub)}</span></div>"
            for i, (k, big, sub) in enumerate(cards)]
    top = max(by_day.values())
    bars = "".join(f'<div style="height:{by_day[d] / top * 100:.0f}%" title="{by_day[d]} calls"><i>{d:%a}</i></div>'
                   for d in (start + timedelta(i) for i in range(7)))
    html.append(f'<div class="card wide" style="--a:#e8ddff"><small>Calls per day</small><div class="chart">{bars}</div></div>')
    stage = next((st for st in PET_STAGES if total >= st[0]), None)
    art = escape("\n".join(pet_rows(stage, cracked=total >= PET_CRACK)))
    html.append(f'<div class="card wide" style="--a:#1f1830;color:var(--fg)"><small>Your pet</small>'
                f"<pre>{art}</pre><span>~{fmt(total)} tokens saved, lifetime</span></div>")

    out = os.path.normpath(os.path.join(CLAUDE_DIR, ".statusline-ctx", "wrapped.html"))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(Template(WRAPPED_PAGE).substitute(range=f"{start:%b %d} – {today:%b %d, %Y}", cards="\n".join(html)))
    print(f"{len(stamps):,} calls, top project {top_project}, busiest {busiest:%A}. Wrapped: {out}")
    if show:
        import webbrowser
        webbrowser.open(Path(out).as_uri())


SHELLS = ("Bash", "PowerShell")
# Next-time advice per tool; anything else (MCP and the rest) gets the default.
GUARD_HINTS = {
    "Grep": "Next time pass head_limit, or output_mode files_with_matches or count.",
    "Glob": "Next time narrow the pattern or the path.",
    "WebFetch": "Next time ask the fetch prompt for only the part you need.",
    "Agent": "Next time tell the subagent to answer in a few lines.",
    "Task": "Next time tell the subagent to answer in a few lines.",
}


def guard(event):
    """PostToolUse hook: tell Claude a big tool output rides along on every later call. Silent under NOISY."""
    if not isinstance(event, dict):
        return
    tool, resp = event.get("tool_name") or "Bash", event.get("tool_response")
    ti = event.get("tool_input") if isinstance(event.get("tool_input"), dict) else {}
    if isinstance(resp, dict) and ("stdout" in resp or "stderr" in resp):
        resp = "".join(str(resp.get(k) or "") for k in ("stdout", "stderr"))
    elif resp is not None and not isinstance(resp, str):
        resp = json.dumps(resp)  # Grep, Glob, MCP and Agent results: the JSON is close to what Claude sees
    if not isinstance(resp, str):
        return
    if tool in SHELLS:
        try:
            resp = resp[:int(os.environ.get("BASH_MAX_OUTPUT_LENGTH") or 30000)]  # Claude Code's default cut, in chars
        except ValueError:
            resp = resp[:30000]
    n = tokens(resp)
    if n < NOISY:
        return
    if tool not in SHELLS:
        label = f"{tool} `{str(ti.get('pattern'))[:40]}`" if ti.get("pattern") else tool
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": (
            f"claude-saver: {label} returned ~{fmt(n)} tokens, re-sent on every later call. "
            + GUARD_HINTS.get(tool, "Next time narrow the query or ask for fewer fields."))}}))
        return
    cmd = str(ti.get("command", ""))[:60]
    key = cmd_key(cmd)
    if key:  # remembered per project for the startup check
        # ponytail: read-modify-write like the ledger; two guards in the same instant can drop one count
        data = load_json(ctx_file("noisy.json"))
        data = data if isinstance(data, dict) else {}
        counts = data.setdefault(os.path.normcase(os.path.abspath(event.get("cwd") or os.getcwd())), {})
        counts[key] = (counts.get(key) or 0) + 1
        save_state(ctx_file("noisy.json"), data)
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": (
        f"claude-saver: `{cmd}` printed ~{fmt(n)} tokens, re-sent on every later call. "
        "Next time use quiet flags (-q, --silent, --reporter=dot), pipe through tail or grep, or run it in a subagent.")}}))


# .env, .env.local, .env.production.local at a path/word boundary; not .environment.
ENV_FILE = re.compile(r"""(?:^|[\s'"`=:/\\(,|])(\.env(?:\.[\w-]+)*)(?![\w-])""")
PLACEHOLDER = re.compile(r"\.(example|sample|template|dist)$", re.I)  # placeholder values, normally committed
# ponytail: well-known prefixes only, no entropy scan. Add a pattern when a new key type leaks.
SECRETS = {name: re.compile(p) for name, p in {
    "Anthropic or OpenAI key": r"\bsk-(?:ant-|proj-)?[\w-]{20,}",
    "Stripe live key": r"\b[rs]k_live_[0-9A-Za-z]{20,}",
    "AWS access key": r"\bAKIA[0-9A-Z]{16}\b",
    "GitHub token": r"\b(?:gh[pousr]_[0-9A-Za-z]{36}|github_pat_\w{22,})",
    "Google API key": r"\bAIza[\w-]{35}",
    "Slack token": r"\bxox[abprs]-[0-9A-Za-z-]{10,}",
    "private key": r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
}.items()}
WRITE_TOOLS = ("Write", "Edit", "MultiEdit")


def secrets(event):
    """Deny reason for touching .env files or writes that hardcode a credential, else None."""
    ti = event.get("tool_input") if isinstance(event, dict) else None
    if not isinstance(ti, dict):
        return
    reason = None
    if event.get("tool_name") in WRITE_TOOLS:
        # A key in .env is where it belongs. Bash heredocs are not scanned.
        if os.path.basename(str(ti.get("file_path") or "")).startswith(".env"):
            return
        edits = [e.get("new_string") for e in ti.get("edits") or [] if isinstance(e, dict)]
        text = "\n".join(str(v) for v in [ti.get("content"), ti.get("new_string")] + edits if v)
        kind = next((k for k, p in SECRETS.items() if p.search(text)), None)
        if kind:
            reason = (f"Blocked: this write hardcodes a {kind}. Anyone with the repo or its history can use it. "
                      "Read it from an environment variable and keep the value in .env (gitignored).")
    else:
        hay = "\n".join(v for v in (ti.get(k) for k in ("file_path", "path", "pattern", "command", "glob")) if isinstance(v, str))
        hit = next((m.group(1) for m in ENV_FILE.finditer(hay) if not PLACEHOLDER.search(m.group(1))), None)
        if hit:
            reason = (f'Blocked: "{hit}" holds live secrets. Printing one into the transcript cannot be undone: '
                      "the user has to rotate the credential. Read the code default, .env.example or README.md instead. "
                      "To check a variable is set, print a boolean, never the value. Do not trust a redaction pattern.")
    return reason


def read_target(event):
    """(path, os.stat) for a Read call on an existing file, else None."""
    if not isinstance(event, dict) or event.get("tool_name") != "Read" or not isinstance(event.get("tool_input"), dict):
        return None
    path = str(event["tool_input"].get("file_path") or "")
    try:
        return path, os.stat(path)
    except (OSError, ValueError):
        return None


def too_big(path, st):
    """Why a whole read of this file wastes tokens, else None."""
    name = os.path.basename(path).lower()
    if name in LOCKFILES or name.endswith(MINIFIED) or (st.st_size > BIG_READ and not name.endswith(MEDIA)):
        return f"claude-saver: skipped ~{fmt(st.st_size // 4)} tokens, a whole read of {os.path.basename(path)}. "
    return None


def reads(event):
    """Deny reason for a whole Read of a lockfile, minified file or file over BIG_READ, else None."""
    target = read_target(event)
    if not target or event["tool_input"].get("offset") or event["tool_input"].get("limit"):
        return None
    reason = too_big(*target)
    return reason and reason + "Grep it for what you need, or Read it with offset and limit."


# `cat file`, `type file`, `Get-Content file`: one file, nothing piped or redirected.
SHELL_READ = re.compile(r"""^\s*(?:cat|type|less|more|gc|Get-Content)\s+(["']?)([^\s"'|;&<>]+)\1\s*$""", re.I)


def shell_reads(event):
    """Deny reason for dumping a lockfile, minified or huge file whole from the shell, else None."""
    ti = event.get("tool_input") if isinstance(event, dict) else None
    m = isinstance(ti, dict) and event.get("tool_name") in SHELLS and SHELL_READ.match(str(ti.get("command") or ""))
    if not m:
        return None
    path = os.path.join(event.get("cwd") or os.getcwd(), os.path.expanduser(m.group(2)))
    try:
        reason = too_big(path, os.stat(path))
    except (OSError, ValueError):
        return None
    return reason and reason + "Grep it for what you need, or print a slice (head, tail, sed -n)."


def rereads(event):
    """Deny reason the first time an unchanged file is read again in a session; the next attempt goes through."""
    target = read_target(event)
    base = state_path(event.get("session_id")) if target else None
    if not base:
        return None
    path, st = target
    ti = event["tool_input"]
    seen = load_json(base + ".reads")
    seen = seen if isinstance(seen, dict) else {}
    key = json.dumps([os.path.normcase(os.path.abspath(path)), ti.get("offset"), ti.get("limit")])
    stamp, old = [st.st_mtime, st.st_size], seen.get(key)
    # Denied once already: let it through, the content likely left context (compaction).
    repeat = isinstance(old, list) and old[:2] == stamp and old[2:] != [True]
    seen[key] = stamp + [repeat]
    save_state(base + ".reads", seen)
    if repeat:
        return (f"claude-saver: skipped ~{fmt(st.st_size // 4)} tokens, {os.path.basename(path)} is unchanged since "
                "your last read of it this session. Use what you read. If it left context (compaction), Read it again.")
    return None


def pre_tool(event):
    """PreToolUse hook: the first deny reason from the switches that are on."""
    for name, fn in (("secrets", secrets), ("reads", reads), ("reads", shell_reads), ("reads", rereads)):
        reason = is_on(name) and fn(event)
        if reason:
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}))
            return


# ---------- toggle ----------

SWITCHES = {
    "pet": "Clawd on the status line",
    "check": "startup check (SessionStart hook)",
    "guard": "big-output guard (PostToolUse hook)",
    "secrets": "secret guard: blocks .env reads and hardcoded keys (PreToolUse hook)",
    "reads": "read guards: lockfiles, minified or huge whole-file reads, unchanged re-reads (PreToolUse hook)",
}


def config_path():
    return os.path.join(CLAUDE_DIR, ".statusline-ctx", "config.json")


def is_on(name):
    """config.json wins; else the pet follows the installer's --pet and the hooks are on."""
    cfg = load_json(config_path())
    value = cfg.get(name) if isinstance(cfg, dict) else None
    if isinstance(value, bool):
        return value
    if name == "pet":
        cmd = (load_json(os.path.join(CLAUDE_DIR, "settings.json")).get("statusLine") or {}).get("command", "")
        return cmd.endswith(" --pet")
    return True


def toggle(args):
    """toggle [NAME [on|off]]: flip or set a switch, then list them all. No restart needed."""
    if args:
        name, value = args[0].lower(), (args[1].lower() if len(args) > 1 else None)
        if name not in SWITCHES or value not in (None, "on", "off"):
            sys.exit(f"Usage: toggle [{'|'.join(SWITCHES)} [on|off]]")
        cfg = load_json(config_path())
        cfg = cfg if isinstance(cfg, dict) else {}
        cfg[name] = not is_on(name) if value is None else value == "on"
        os.makedirs(os.path.dirname(config_path()), exist_ok=True)
        with open(config_path(), "w", encoding="utf-8") as f:
            json.dump(cfg, f)
    print("Switches (take effect now, no restart):")
    for name, what in SWITCHES.items():
        print(f"  {name:<8} {'on ' if is_on(name) else 'off'}  {what}")
    print("caveman / ponytail: `stop caveman`, `stop ponytail` for this session; "
          "/plugin to disable them for every session.")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    args = sys.argv[1:]
    cwd = os.getcwd()
    if args[:1] == ["guard"] and not is_on("guard"):
        return  # switched off with /toggle; check and secrets test their switches themselves
    if args[:1] == ["audit"]:
        audit(cwd)
    elif args[:1] == ["toggle"]:
        toggle(args[1:])
    elif args[:1] == ["check"]:
        source = "startup"
        if not sys.stdin.isatty():  # the hook's SessionStart event; a hand run has none
            try:
                source = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace") or "{}").get("source") or source
            except (ValueError, AttributeError):
                pass
        check(cwd, source if is_on("check") else None)  # the handoff note shows even with check off
    elif args[:1] == ["handoff"]:
        os.makedirs(os.path.dirname(handoff_path(cwd)), exist_ok=True)
        print(handoff_path(cwd))
    elif args[:2] == ["savings", "--week"]:
        week()
    elif args[:1] == ["savings"]:
        savings(args[1] if len(args) > 1 else newest_transcript(cwd), cwd)
    elif args[:1] == ["pet"]:
        pet()
    elif args[:1] == ["wrapped"]:
        wrapped()
    elif args[:1] in (["guard"], ["secrets"]):
        try:
            {"guard": guard, "secrets": pre_tool}[args[0]](json.loads(sys.stdin.buffer.read().decode("utf-8", "replace")))
        except ValueError:
            pass
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
