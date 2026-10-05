"""Run: python3 test_saver.py"""

import json
import os
import tempfile

import saver

home = tempfile.mkdtemp()
saver.CLAUDE_DIR = home
cwd = os.path.join(home, "proj")
os.makedirs(os.path.join(cwd, ".claude", "rules"))

# audit: HTML comments are free, @imports follow, path-scoped rules are skipped
with open(os.path.join(cwd, "CLAUDE.md"), "w") as f:
    f.write("<!-- " + "x" * 400 + " -->\nSee @extra.md and `src/gone.py`\n")
with open(os.path.join(cwd, "extra.md"), "w") as f:
    f.write("y" * 4000)
with open(os.path.join(cwd, ".claude", "rules", "py.md"), "w") as f:
    f.write("---\npaths: ['**/*.py']\n---\nz")
loaded = dict(saver.always_loaded(cwd))
assert set(map(os.path.basename, loaded)) == {"CLAUDE.md", "extra.md"}, loaded
assert saver.tokens(saver.visible(loaded[os.path.join(cwd, "CLAUDE.md")])) < 20
assert "maybe stale path: src/gone.py" in saver.file_findings(os.path.join(cwd, "CLAUDE.md"), "`src/gone.py`", cwd)
assert saver.file_findings(os.path.join(cwd, "extra.md"), "y" * 4000, cwd)[0].startswith("long")

# savings: usage counted once per message id, even when split across lines
lines = [
    {"message": {"role": "user", "content": "CAVEMAN MODE ACTIVE"}},
    {"message": {"id": "m1", "role": "assistant", "usage": {"input_tokens": 5, "output_tokens": 100},
                 "content": [{"type": "text", "text": "a" * 400}]}},
    {"message": {"id": "m1", "role": "assistant", "usage": {"input_tokens": 5, "output_tokens": 100},
                 "content": [{"type": "tool_use", "id": "t1", "name": "Bash",
                              "input": {"command": "graphify query 'auth'"}}]}},
    {"message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "b" * 800}]}},
]
transcript = os.path.join(home, "s.jsonl")
with open(transcript, "w") as f:
    f.write("\n".join(json.dumps(x) for x in lines))
s = saver.session_stats(transcript)
assert (s["calls"], s["input"], s["output"]) == (1, 5, 100), s
assert s["caveman"] and not s["ponytail"] and s["text"] == 100
assert s["graph_queries"] == ["t1"] and s["graph_results"] == 200
assert [r[0] for r in saver.saved_rows(s)] == ["caveman", "graphify"]
# AGENTS.md loads only when no CLAUDE.md exists in cwd or above
bare = os.path.join(home, "bare")
os.makedirs(bare)
open(os.path.join(bare, "AGENTS.md"), "w").write("a")
# real CLAUDE_DIR: the temp dir may sit under ~, whose .claude/CLAUDE.md is global and must not count
saver.CLAUDE_DIR = os.path.expanduser("~/.claude")
assert "AGENTS.md" in [os.path.basename(p) for p, _ in saver.always_loaded(bare)]
saver.CLAUDE_DIR = home
open(os.path.join(cwd, "AGENTS.md"), "w").write("a")
assert "AGENTS.md" not in map(os.path.basename, dict(saver.always_loaded(cwd)))

# MEMORY.md past 200 lines is cut off; unscoped rules are flagged
assert any(f.startswith("truncated") for f in saver.file_findings(os.path.join(home, "MEMORY.md"), "- x\n" * 201, cwd))
assert not saver.file_findings(os.path.join(home, "MEMORY.md"), "- x\n" * 200, cwd)
rule = os.path.join(cwd, ".claude", "rules", "all.md")
assert any("paths:" in f for f in saver.file_findings(rule, "z", cwd))

# check: silent when lean, one line naming the long file otherwise
import contextlib, io
def check_out(d):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        saver.check(d)
    return buf.getvalue()
assert check_out(bare) == ""
assert check_out(cwd).count("\n") == 1 and "extra.md" in check_out(cwd)
os.makedirs(os.path.join(bare, "node_modules"))
assert "node_modules" in check_out(bare) and "/doctor" not in check_out(bare)
os.makedirs(os.path.join(bare, ".claude"))
open(os.path.join(bare, ".claude", "settings.json"), "w").write('{"permissions": {"deny": ["Read(**/node_modules/**)"]}}')
assert check_out(bare) == ""
# gitignored folders count once they hold MANY_FILES files; globs and negations are skipped
saver.MANY_FILES = 3
open(os.path.join(bare, ".gitignore"), "w").write("*.log\n!keep/\n/storage/\nsmall/**\n.claude/\n")
for d, n in (("storage", 3), ("small", 2)):
    os.makedirs(os.path.join(bare, d))
    for i in range(n):
        open(os.path.join(bare, d, str(i)), "w").close()
assert saver.gitignored_dirs(bare) == ["storage", "small"], saver.gitignored_dirs(bare)
assert saver.unblocked_heavy(bare) == ["storage"], saver.unblocked_heavy(bare)
open(os.path.join(bare, ".claude", "settings.json"), "w").write('{"permissions": {"deny": ["Read(**/node_modules/**)", "Read(./storage/**)"]}}')
assert check_out(bare) == ""

# audit tips: compact instructions, bash output cap, 5-minute cache
saver.newest_transcript = lambda d: transcript
with open(transcript, "a") as f:
    f.write("\n" + json.dumps({"message": {"usage": {"cache_creation": {"ephemeral_5m_input_tokens": 9}}}}, separators=(",", ":")))
def audit_out(d):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        saver.audit(d)
    return buf.getvalue()
out = audit_out(cwd)
assert "Compact instructions" in out and "BASH_MAX_OUTPUT_LENGTH" in out and "ENABLE_PROMPT_CACHING_1H" in out, out
open(os.path.join(cwd, "CLAUDE.md"), "a").write("\n## Compact instructions\nKeep test output.\n")
os.environ["BASH_MAX_OUTPUT_LENGTH"] = os.environ["ENABLE_PROMPT_CACHING_1H"] = "1"
out = audit_out(cwd)
assert "Compact instructions" not in out and "BASH_MAX" not in out and "CACHING_1H" not in out, out

# install: env defaults kept, hook added once, opusplan only with --orchestrate
import install
st = {"env": {"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "70"}}
install.apply_settings(st, [], "py", "/c/statusline.py")
install.apply_settings(st, ["--orchestrate"], "py", "/c/statusline.py")
assert st["env"] == {"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "70", "CLAUDE_CODE_SUBAGENT_MODEL": "haiku"}, st
assert st["model"] == "opusplan" and len(st["hooks"]["SessionStart"]) == 1, st
assert st["hooks"]["SessionStart"][0]["hooks"][0]["command"].endswith('saver.py" check')
assert "model" not in install.apply_settings({}, [], "py", "/c/statusline.py")
st = {"permissions": {"deny": ["Read(**/node_modules/**)", "Bash(rm:*)"]}}
install.apply_settings(st, [], "py", "/c/statusline.py")
assert st["permissions"]["deny"][:2] == ["Read(**/node_modules/**)", "Bash(rm:*)"] and len(st["permissions"]["deny"]) == len(install.DENY_READS) + 1
print("ok")
