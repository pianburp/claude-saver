"""Run: python3 test_statusline.py"""

import os
import tempfile

import statusline as sl

sl.NO_COLOR = True
sl.TRUECOLOR = False
sl.CLAUDE_DIR = tempfile.mkdtemp()

# track: (previous value, age) after a change, none on first sight
st = {}
assert sl.track(st, "k", 4, now=0) is None  # first sight
assert sl.track(st, "k", 4, now=1) is None  # unchanged
assert sl.track(st, "k", 6, now=2) == (4, 0)  # changed
assert sl.track(st, "k", 6, now=16) == (4, 14)  # still within GLOW_SECS
assert sl.track(st, "k", 6, now=17) is None  # expired
assert sl.rose(st, "k", 2, now=18) is None  # drop (e.g. /compact) never glows
assert sl.rose(st, "k", 3, now=19) == 0

# glow: starts at PEACH, drifts steadily toward base, lands on it (no snap)
for base in (sl.GREEN, sl.RED, sl.GRAY, sl.CLAUDE):
    fade = [sl.glow(age, base) for age in range(sl.GLOW_SECS + 1)]
    dist = [sum((a - b) ** 2 for a, b in zip(sl.to_rgb(c), sl.to_rgb(base))) for c in fade]
    assert fade[0] == sl.PEACH and fade[-1] == base and dist == sorted(dist, reverse=True), (base, fade)
    assert len(set(fade)) >= 4, fade  # more than a few coarse steps
assert sl.glow(None, base=1) == 1

# truecolor: a new shade every second, painted as 38;2;r;g;b
sl.TRUECOLOR = True
fade = [sl.glow(age, sl.GREEN) for age in range(sl.GLOW_SECS)]
assert fade[0] == sl.to_rgb(sl.PEACH) and len(set(fade)) == sl.GLOW_SECS, fade
assert sl.glow(sl.GLOW_SECS, sl.GREEN) == sl.GREEN
sl.NO_COLOR = False
assert "[38;2;255;215;175m" in sl.paint("x", sl.glow(0, sl.GREEN))
sl.NO_COLOR, sl.TRUECOLOR = True, False
assert sl.state_path("../x") is None and sl.state_path(None) is None

# render: spinner follows the clock while the transcript is fresh, rests on ✻ when idle
transcript = os.path.join(sl.CLAUDE_DIR, "t.jsonl")
open(transcript, "w").close()
mtime = os.path.getmtime(transcript)
data = {"session_id": "s1", "transcript_path": transcript}
busy = {sl.render(data, now=mtime + i)[0] for i in range(len(sl.SPINNER))}
assert busy == set(sl.SPINNER), busy
assert sl.render(data, now=mtime + 1.1)[0] == sl.render(data, now=mtime + 1.1)[0]  # burst redraws: same frame
assert sl.render(data, now=mtime + sl.BUSY_SECS + 1)[0] == "✻"

# cache: breathes through PULSE under 5 minutes left (colors on to see the codes)
sl.NO_COLOR = False
for frame, color in enumerate(sl.PULSE):
    assert f"38;5;{color}m" in sl.fmt_cache(3600 - 60, frame=frame)
# cache TTL: newest non-zero cache write in the transcript wins; none found falls back to 3600
os.environ.pop("CLAUDE_CACHE_TTL", None)
tp = os.path.join(sl.CLAUDE_DIR, "ttl.jsonl")
with open(tp, "w") as f:
    f.write('{"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":9}}\n')
    f.write('{"cache_creation":{"ephemeral_5m_input_tokens":7,"ephemeral_1h_input_tokens":0}}\n')
    f.write('{"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}\n')
assert sl.cache_ttl(tp) == 300
assert sl.cache_ttl(os.path.join(sl.CLAUDE_DIR, "missing.jsonl")) == 3600
os.environ["CLAUDE_CACHE_TTL"] = "120"
assert sl.cache_ttl(tp) == 120  # explicit override beats detection
del os.environ["CLAUDE_CACHE_TTL"]
# /compact hint 10 points before auto-compact (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, 50 default)
sl.NO_COLOR = True
assert "/compact" in sl.render({"context_window": {"used_percentage": 40}})
assert "/compact" not in sl.render({"context_window": {"used_percentage": 39}})
# /clear replaces it once the cache is cold and context is past CLEAR_PCT
cold = {"transcript_path": transcript, "context_window": {"used_percentage": 45}}
assert "/clear" in sl.render(cold, now=mtime + 3601) and "/compact" not in sl.render(cold, now=mtime + 3601)
assert "/clear" not in sl.render(cold, now=mtime + 60)
assert "/clear" not in sl.render(dict(cold, context_window={"used_percentage": 19}), now=mtime + 3601)
# bar: any nonzero usage shows at least one cell
assert sl.bar(5).count("█") == 1 and sl.bar(0).count("█") == 0 and sl.bar(100).count("█") == 10
print("ok")
