#!/usr/bin/env python3
"""Two-line status line styled after Claude Code's own UI.

✻ model · effort · active modes (ponytail, caveman)
  ⎿  context · 5h limit · 7d limit · prompt cache

Animates on the clock (one frame per second): ✻ spins while Claude works, rising values glow then fade,
a low prompt cache breathes red. Per-session state lives in ~/.claude/.statusline-ctx/.
"""

import json
import os
import re
import sys
import time
from datetime import datetime

NO_COLOR = bool(os.environ.get("NO_COLOR"))
# 24-bit color makes the glow fade smoothly; other terminals get the nearest 256-color shade.
TRUECOLOR = os.environ.get("COLORTERM") in ("truecolor", "24bit") or bool(os.environ.get("WT_SESSION"))

CLAUDE = 173
GRAY = 246
WHITE = 255
DARK = 238
GREEN = 114
YELLOW = 179
RED = 167

CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
BAR_WIDTH = 10
GLOW_SECS = 15
PEACH = 223  # glow start; fades smoothly into the segment's own color
PULSE = (RED, 131, 95, 131)
BUSY_SECS = 10
SPINNER = "·✢✳✶✻✽✻✶✳✢"  # forward then back, like Claude Code's own
SESSION_RE = r"[A-Za-z0-9_-]{1,128}"


def paint(text, color, bold=False):
    """color is an xterm-256 index or an (r, g, b) tuple."""
    if NO_COLOR or not text:
        return text
    code = f"38;2;{';'.join(map(str, color))}" if isinstance(color, tuple) else f"38;5;{color}"
    return f"\033[{'1;' if bold else ''}{code}m{text}\033[0m"


def label(text):
    return paint(text, GRAY)


SEP = paint("  ·  ", DARK)


def level_color(pct):
    return GREEN if pct < 50 else YELLOW if pct < 80 else RED


def to_pct(value):
    try:
        return max(0.0, min(100.0, float(value)))
    except (TypeError, ValueError):
        return None


def to_rgb(c):
    """xterm-256 index (16-255) to RGB."""
    if c >= 232:
        return (8 + 10 * (c - 232),) * 3
    c -= 16
    return tuple((0, 95, 135, 175, 215, 255)[n] for n in (c // 36, c // 6 % 6, c % 6))


def nearest(rgb):
    return min(range(16, 256), key=lambda c: sum((a - b) ** 2 for a, b in zip(to_rgb(c), rgb)))


def glow(age, base):
    """PEACH blended into base as age goes 0 to GLOW_SECS; base once there is no change."""
    if age is None or age >= GLOW_SECS:
        return base
    w = 1 - max(0, age) / GLOW_SECS
    rgb = tuple(round(w * a + (1 - w) * b) for a, b in zip(to_rgb(PEACH), to_rgb(base)))
    return rgb if TRUECOLOR else nearest(rgb)


def bar(pct, glow_from=None, age=None):
    """Cells from glow_from up to the fill edge glow, fading with age."""
    filled = round(pct / 100 * BAR_WIDTH)
    color = CLAUDE if pct < 50 else level_color(pct)
    start = filled if glow_from is None else min(glow_from, filled)
    return paint("█" * start, color) + paint("█" * (filled - start), glow(age, color)) + paint("░" * (BAR_WIDTH - filled), DARK)


def state_path(session_id):
    if session_id and re.fullmatch(SESSION_RE, session_id):
        return os.path.join(CLAUDE_DIR, ".statusline-ctx", session_id)
    return None


def load_state(path):
    try:
        with open(path, encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, ValueError):
        return {}
    return state if isinstance(state, dict) else {}


def save_state(path, state):
    # Claude Code cancels a run when a newer update starts, so write then swap: never a half file.
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f)
        os.replace(tmp, path)
    except OSError:
        pass


def track(state, key, value, now):
    """(value before the last change, its age in seconds) while under GLOW_SECS old, else None."""
    try:
        old, new, at = state[key]
    except (KeyError, TypeError, ValueError):
        old = new = value  # first sight: no glow
        at = 0
    if value != new:
        old, new, at = new, value, now
    state[key] = [old, new, at]
    return (old, now - at) if old != new and now - at < GLOW_SECS else None


def rose(state, key, value, now):
    """Age of the change if the value went up, else None."""
    hit = track(state, key, value, now)
    return hit[1] if hit and hit[0] < value else None


def fmt_reset(epoch):
    """'4:32p' when under 12h away, 'Fri 4:32p' otherwise."""
    try:
        epoch = int(epoch)
        dt = datetime.fromtimestamp(epoch)
    except (TypeError, ValueError, OSError, OverflowError):
        return ""
    clock = f"{dt.hour % 12 or 12}:{dt:%M}{'a' if dt.hour < 12 else 'p'}"
    if 0 <= epoch - time.time() < 12 * 3600:
        return clock
    return f"{dt:%a} {clock}"


def fmt_limit(name, window, state, now):
    pct = to_pct((window or {}).get("used_percentage"))
    if pct is None:
        return ""
    color = glow(rose(state, name, round(pct), now), level_color(pct))
    out = label(name) + " " + paint(f"{pct:.0f}%", color)
    reset = fmt_reset((window or {}).get("resets_at"))
    if reset:
        out += " " + label(reset)
    return out


def cache_ttl():
    try:
        return max(1, int(os.environ.get("CLAUDE_CACHE_TTL", 3600)))
    except ValueError:
        return 3600


def fmt_cache(idle, frame):
    """Time left on the prompt cache, counted from the last transcript write.

    Under 5 minutes it breathes through PULSE, one step per second.
    """
    if idle is None:
        return ""
    ttl = cache_ttl()
    left = ttl - idle
    if left < 1:
        return label("cache ") + paint("cold", RED)
    m, s = divmod(int(left), 60)
    text = f"{m}m" if m else f"{s}s"
    if left <= 300:
        return label("cache ") + paint(text, PULSE[frame % len(PULSE)])
    return label("cache ") + paint(text, GREEN if left > ttl / 2 else YELLOW)


def read_flag(path):
    """Short lowercase mode word from a flag file, or None."""
    try:
        if os.path.islink(path) or os.path.getsize(path) > 64:
            return None
        with open(path) as f:
            mode = re.sub(r"[^a-z0-9-]", "", f.read().strip().lower())
    except OSError:
        return None
    return mode if mode and mode != "off" else None


def read_modes(session_id):
    """[(name, level)] for active modes; level is "" for caveman's default."""
    modes = []
    pony = read_flag(os.path.join(CLAUDE_DIR, ".ponytail-active"))
    if pony:
        modes.append(("pony", pony))
    # Per-session caveman flag wins over the machine-wide mirror.
    cave_paths = [os.path.join(CLAUDE_DIR, ".caveman-active")]
    if session_id and re.fullmatch(SESSION_RE, session_id):
        cave_paths.insert(0, os.path.join(CLAUDE_DIR, ".caveman-sessions", session_id + ".mode"))
    for path in cave_paths:
        if os.path.exists(path):
            cave = read_flag(path)
            if cave:
                modes.append(("cave", "" if cave == "caveman" else cave))
            break
    return modes


def fmt_modes(modes, age):
    """The whole group glows, then fades, after any mode turns on, off, or changes level."""
    return paint(" + ", DARK).join(
        paint(name, glow(age, GRAY)) + (" " + paint(level, glow(age, WHITE)) if level else "")
        for name, level in modes
    )


def read_effort(data, cwd, model_id):
    """stdin first, then project local > project > user settings."""
    raw = data.get("effort")
    if isinstance(raw, dict):
        raw = raw.get("level")
    if isinstance(raw, str) and raw:
        return raw.lower()
    for path in (
        os.path.join(cwd, ".claude", "settings.local.json"),
        os.path.join(cwd, ".claude", "settings.json"),
        os.path.join(CLAUDE_DIR, "settings.json"),
    ):
        try:
            with open(path, encoding="utf-8") as f:
                cfg = json.load(f)
        except (OSError, ValueError):
            continue
        per_model = ((cfg.get("modelSettings") or {}).get(model_id) or {}).get("effortLevel")
        value = per_model or cfg.get("effortLevel")
        if isinstance(value, str) and value:
            return value.lower()
    return ""


def render(data, now=None):
    now = time.time() if now is None else now
    model = data.get("model") or {}
    cwd = (data.get("workspace") or {}).get("current_dir") or data.get("cwd") or os.getcwd()
    session_id = data.get("session_id")
    path = state_path(session_id)
    state = load_state(path) if path else {}
    # Frames follow the clock, not the redraw count: event redraws come in bursts and gaps.
    frame = int(now)

    try:
        idle = now - os.path.getmtime(data.get("transcript_path") or "")
    except (OSError, TypeError):
        idle = None
    # Transcript written recently means Claude is working: spin.
    star = SPINNER[frame % len(SPINNER)] if idle is not None and idle < BUSY_SECS else "✻"

    modes = read_modes(session_id)
    hit = track(state, "modes", str(modes), now)
    line1 = [
        paint(star + " " + (model.get("display_name") or model.get("id") or "Claude"), CLAUDE, bold=True),
        paint(read_effort(data, cwd, model.get("id")), GRAY),
        fmt_modes(modes, hit[1] if hit else None),
    ]

    ctx = to_pct((data.get("context_window") or {}).get("used_percentage"))
    rate = data.get("rate_limits") or {}
    ctx_part = ""
    if ctx is not None:
        cells = round(ctx / 100 * BAR_WIDTH)
        hit = track(state, "ctx", cells, now)
        glow_from, age = hit if hit and hit[0] < cells else (None, None)
        ctx_part = label("ctx ") + bar(ctx, glow_from, age) + " " + paint(f"{ctx:.0f}%", level_color(ctx))
    line2 = [
        ctx_part,
        fmt_limit("5h", rate.get("five_hour"), state, now),
        fmt_limit("7d", rate.get("seven_day"), state, now),
        fmt_cache(idle, frame),
    ]

    if path:
        save_state(path, state)
    top, bottom = (SEP.join(p for p in line if p) for line in (line1, line2))
    return top + ("\n" + paint("  ⎿  ", DARK) + bottom if bottom else "")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    try:
        data = json.load(sys.stdin)
    except ValueError:
        data = {}
    print(render(data if isinstance(data, dict) else {}))


if __name__ == "__main__":
    main()
