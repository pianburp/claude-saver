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
assert sl.rose(st, "k", 2, now=18) == (2, None)  # drop (e.g. /compact) shows at once, never glows
assert sl.rose(st, "k", 8, now=19) == (2, 0)  # rise counts up from the old value...
assert sl.rose(st, "k", 8, now=20.5) == (5, 1.5)  # ...halfway at ROLL_SECS / 2...
assert sl.rose(st, "k", 8, now=23) == (8, 4)  # ...then holds while it glows

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
# /compact while the cache is warm but about to expire (last 5 minutes of 1h), not while busy or below CLEAR_PCT
warm = {"transcript_path": transcript, "context_window": {"used_percentage": 25}}
assert "/compact" in sl.render(warm, now=mtime + 3600 - 120)
assert "/compact" not in sl.render(warm, now=mtime + 3600 - 400)
assert "/compact" not in sl.render(dict(warm, context_window={"used_percentage": 19}), now=mtime + 3600 - 120)
# saved: saver.py's estimate on line 1, hidden with no transcript or nothing saved
sp = os.path.join(sl.CLAUDE_DIR, "saved.jsonl")
with open(sp, "w") as f:
    f.write('{"message":{"role":"user","content":"CAVEMAN MODE ACTIVE"}}\n')
    f.write('{"message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"' + "a" * 4000 + '"}]}}\n')
assert "saved ~1.9k" in sl.render({"transcript_path": sp}), sl.render({"transcript_path": sp})
assert "saved" not in sl.render({}) and "saved" not in sl.render({"transcript_path": tp})
# ledger: each session's savings credited once (pet or not), to the lifetime total and today
assert sl.PET_EGG[0][1] not in sl.render({"session_id": "p0", "transcript_path": sp})  # pet off by default
egg = sl.render({"session_id": "p1", "transcript_path": sp}, now=os.path.getmtime(sp) + 60, pet=True).split("\n")  # ~3.8k lifetime: an egg
assert [r[:sl.PET_WIDTH] for r in egg] == [r.ljust(sl.PET_WIDTH) for r in sl.PET_EGG[0]], egg
assert egg[0][sl.PET_WIDTH] == "✻" and len(egg) == 3  # Clawd's rows get their own lines even with no line 2
for i in range(2, 7):
    sl.render({"session_id": f"p{i}", "transcript_path": sp}, pet=True)
    sl.render({"session_id": f"p{i}", "transcript_path": sp}, pet=True)  # redraw: no double credit
pet_file = os.path.join(sl.CLAUDE_DIR, ".statusline-ctx", "ledger.json")
led, one = sl.load_state(pet_file), sl.load_state(os.path.join(sl.CLAUDE_DIR, ".statusline-ctx", "p1"))["saved_n"]
assert led["total"] == 7 * one and list(led["days"].values()) == [7 * one] and led["born"], led
mtime_sp = os.path.getmtime(sp)
def pet(ctx, at):
    """Clawd's (head, body, legs), stripped of the status line after it."""
    data = {"session_id": "p1", "transcript_path": sp, "context_window": {"used_percentage": ctx}}
    return tuple(r[:sl.PET_WIDTH].rstrip() for r in sl.render(data, now=mtime_sp + at, pet=True).split("\n"))
assert pet(10, 60) == (" ▐▛███▜▌", "▝▜█████▛▘", "  ▘▘ ▝▝")  # 13.3k lifetime: hatched, idle
assert pet(10, 3601) == (" ▐▀███▀▌ z", "▝▜█████▛▘", "  ▘▘ ▝▝")  # cache cold: asleep
assert {pet(10, i)[1] for i in (0, 1)} == set(sl.PET_BODY)  # working: waves
assert pet(10, 60 + sl.PET_BLINK - 1 - 60 % sl.PET_BLINK)[0] == " ▐▀███▀▌"  # blinks
sl.NO_COLOR = False
assert "38;5;%dm ▐▛███▜▌" % sl.RED in sl.render({"session_id": "p1", "transcript_path": sp, "context_window": {"used_percentage": 45}},
                                                now=mtime_sp + 3000, pet=True)  # past the hatch glow; /compact range: red
sl.NO_COLOR = True
sl.save_state(pet_file, {"total": 3e6})
assert pet(10, 60) == (" ▐▛███▜▌✦✦", "▝▜█████▛▘", "  ▘▘ ▝▝")
# effort abbreviated, unknown levels passed through; cache time left always shown
assert "xhi" in sl.render({"effort": "xhigh"}) and "xhigh" not in sl.render({"effort": "xhigh"})
assert "max" in sl.render({"effort": "max"})
assert sl.fmt_cache(60, frame=0) == "● 59m" and sl.fmt_cache(3600 - 30, frame=0) == "◔ 30s"
assert [sl.fmt_cache(m * 60, frame=0)[0] for m in (20, 32, 48)] == list("◕◑◔")  # 40m, 28m, 12m left: drains
assert sl.fmt_cache(3601, frame=0) == "○ cold" and sl.fmt_cache(None, frame=0) == ""
line2 = sl.render({"transcript_path": sp, "rate_limits": {"seven_day": {"used_percentage": 40}}}, now=os.path.getmtime(sp) + 60).split("\n")[1]
assert line2.startswith("⎿ 7d 40%") and line2.endswith("● 59m"), line2  # line 2, after 7d
# resets: clock under 24h away, weekday after
import time
assert ":" in sl.fmt_reset(time.time() + 20 * 3600) and ":" not in sl.fmt_reset(time.time() + 2 * 86400)
# bar: any nonzero usage shows at least one cell
assert sl.bar(5).count("█") == 1 and sl.bar(0).count("█") == 0 and sl.bar(100).count("█") == sl.BAR_WIDTH
# /toggle pet: config.json overrides the --pet the installer baked in
import subprocess, sys
cfg_home = tempfile.mkdtemp()
os.makedirs(os.path.join(cfg_home, ".statusline-ctx"))
draw = lambda *a: subprocess.run([sys.executable, "statusline.py", *a], input="{}", capture_output=True, text=True,
                                 encoding="utf-8", env=dict(os.environ, CLAUDE_CONFIG_DIR=cfg_home)).stdout
assert sl.PET_EGG[0][1] in draw("--pet")
with open(os.path.join(cfg_home, ".statusline-ctx", "config.json"), "w") as f:
    f.write('{"pet": false}')
assert sl.PET_EGG[0][1] not in draw("--pet")
print("ok")
