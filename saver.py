#!/usr/bin/env python3
"""Token tools for Claude Code.

  saver.py audit            what loads before you type: CLAUDE.md, memory, rules, MCP, ignores
  saver.py check            one line if those files need trimming, else nothing (SessionStart hook)
  saver.py savings [FILE]   this session's token use and estimated savings (default: newest transcript)

Token counts are chars/4, the same approximation graphify and most tools use.
"""

import glob
import json
import os
import re
import sys

from statusline import detect_ttl

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
    names = set()
    user = load_json(os.path.expanduser("~/.claude.json"))
    names |= set((user.get("mcpServers") or {}))
    names |= set(((user.get("projects") or {}).get(cwd) or {}).get("mcpServers") or {})
    names |= set(load_json(os.path.join(cwd, ".mcp.json")).get("mcpServers") or {})
    return sorted(names)


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
    heavy = unblocked_heavy(cwd)
    if os.path.isfile(os.path.join(cwd, ".claudeignore")):
        tips.append("Claude Code does not read .claudeignore. Move its entries to permissions.deny.")
    if heavy:
        rules = ", ".join(f'"Read(./{d}/**)"' for d in heavy)
        tips.append(f"Unblocked heavy dirs: {', '.join(heavy)}. Add to permissions.deny in .claude/settings.json: {rules}")
    if not env_value("CLAUDE_CODE_SUBAGENT_MODEL", cwd):
        tips.append("Subagents use your main model. CLAUDE_CODE_SUBAGENT_MODEL=haiku makes exploration and log reading cheaper.")
    skills = glob.glob(os.path.join(CLAUDE_DIR, "skills", "*", "SKILL.md")) + glob.glob(os.path.join(cwd, ".claude", "skills", "*", "SKILL.md"))
    if skills:
        tips.append(f"{len(skills)} user/project skill(s), ~30-100 tokens each for the description. Skills you only run by hand: add `disable-model-invocation: true`.")
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


def check(cwd):
    """One line when something costs tokens every session, nothing otherwise: hook output costs context."""
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
    if issues:
        print(f"claude-saver: {'; '.join(issues)}. Tell the user to run /token-audit"
              + (" or /doctor prompt-audit (stale or conflicting lines)." if flagged else "."))


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


def session_stats(path):
    """Usage deduped by message id (one transcript line per content block) plus content sizes."""
    s = {"input": 0, "cache_write": 0, "cache_read": 0, "output": 0, "calls": 0,
         "text": 0, "code": 0, "caveman": False, "ponytail": False,
         "reads": [], "graph_queries": [], "graph_results": 0}
    seen, tool_names, results = set(), {}, {}
    files = [path] + glob.glob(os.path.join(os.path.splitext(path)[0], "subagents", "*.jsonl"))
    for f in files:
        for line in (read(f) or "").splitlines():
            if "CAVEMAN MODE ACTIVE" in line:
                s["caveman"] = True
            if "PONYTAIL MODE ACTIVE" in line:
                s["ponytail"] = True
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            msg = entry.get("message") if isinstance(entry, dict) else None
            if not isinstance(msg, dict):
                continue
            usage = msg.get("usage")
            if msg.get("role") == "assistant" and isinstance(usage, dict) and msg.get("id") not in seen:
                seen.add(msg.get("id"))
                s["calls"] += 1
                s["input"] += usage.get("input_tokens") or 0
                s["cache_write"] += usage.get("cache_creation_input_tokens") or 0
                s["cache_read"] += usage.get("cache_read_input_tokens") or 0
                s["output"] += usage.get("output_tokens") or 0
            for block in msg.get("content") if isinstance(msg.get("content"), list) else []:
                if not isinstance(block, dict):
                    continue
                kind = block.get("type")
                if kind == "text" and msg.get("role") == "assistant":
                    s["text"] += tokens(block.get("text", ""))
                elif kind == "tool_use":
                    name, args = block.get("name", ""), block.get("input") or {}
                    tool_names[block.get("id")] = name
                    if name in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
                        code = args.get("content") or args.get("new_string") or args.get("new_source") or ""
                        code += "".join(e.get("new_string", "") for e in args.get("edits") or [])
                        s["code"] += tokens(code)
                    cmd = str(args.get("command", ""))
                    if "graphify" in name or re.search(r"\bgraphify\s+(query|path|explain)\b", cmd):
                        s["graph_queries"].append(block.get("id"))
                elif kind == "tool_result":
                    results[block.get("tool_use_id")] = tokens(result_text(block.get("content")))
    s["reads"] = [n for i, n in results.items() if tool_names.get(i) == "Read"]
    s["graph_results"] = sum(results.get(i, 0) for i in s["graph_queries"])
    return s


def saved_rows(s):
    """Estimated savings as (name, tokens, kind, why); shared by /savings and the status line."""
    rows = []
    if s["caveman"] and s["text"]:
        rows.append(("caveman", s["text"] * CAVEMAN_CUT / (1 - CAVEMAN_CUT), "output",
                     f"{CAVEMAN_CUT:.0%} avg cut on {fmt(s['text'])} reply tokens (caveman benchmark)"))
    if s["ponytail"] and s["code"]:
        rows.append(("ponytail", s["code"] * PONYTAIL_CUT / (1 - PONYTAIL_CUT), "output",
                     f"{PONYTAIL_CUT:.0%} fewer lines on {fmt(s['code'])} code tokens (ponytail benchmark, low end)"))
    if s["graph_queries"]:
        per_read = sum(s["reads"]) // len(s["reads"]) if s["reads"] else DEFAULT_READ_TOKENS
        saved = max(0, len(s["graph_queries"]) * GRAPHIFY_READS_AVOIDED * per_read - s["graph_results"])
        rows.append(("graphify", saved, "input",
                     f"{len(s['graph_queries'])} queries × {GRAPHIFY_READS_AVOIDED} reads of ~{fmt(per_read)} avoided (assumption)"))
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
        print("  nothing yet: caveman, ponytail and graphify were not used in this session")
    for name, n, kind, why in rows:
        print(f"  {name:<9} {'~' + fmt(n):>7} {kind:<6}  {why}")
    if rows:
        print(f"  {'total':<9} {'~' + fmt(sum(r[1] for r in rows)):>7}")
    print(f"\n  prompt cache  {fmt(s['cache_read'])} input tokens billed at 10% (exact, built into Claude Code)")

    memory = sum(tokens(visible(t)) for _, t in always_loaded(cwd))
    if memory:
        print(f"\nOverhead: CLAUDE.md + memory ~{fmt(memory)} tokens × {s['calls']} calls = "
              f"~{fmt(memory * s['calls'])}. Run /token-audit to trim it.")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    args = sys.argv[1:]
    cwd = os.getcwd()
    if args[:1] == ["audit"]:
        audit(cwd)
    elif args[:1] == ["check"]:
        check(cwd)
    elif args[:1] == ["savings"]:
        savings(args[1] if len(args) > 1 else newest_transcript(cwd), cwd)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
