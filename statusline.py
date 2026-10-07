#!/usr/bin/env python3
"""Two-line status line styled after Claude Code's own UI.

✻ model · effort · active modes (ponytail, caveman) · saved · prompt cache (last 5 minutes only)
⎿ context · 5h limit · 7d limit (each with "full <time>" when the pace so far runs out before the reset)

Tokens saved are credited to ~/.claude/.statusline-ctx/ledger.json (lifetime and per day) for /pet and /savings --week.
With --pet (or /toggle pet on), Clawd (Claude Code's mascot, as on its welcome banner) stands left of the lines on three rows
and earns a sparkle per stage of the lifetime total.

Animates on the clock (one frame per second): ✻ spins while Claude works, rising values glow then fade,
a low prompt cache breathes red. Per-session state lives in ~/.claude/.statusline-ctx/.
"""

import json
import math
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
BAR_WIDTH = 6
GLOW_SECS = 15
ROLL_SECS = 3  # a rising number counts up from its old value over this long
PEACH = 223  # glow start; fades smoothly into the segment's own color
PULSE = (RED, 131, 95, 131)
BUSY_SECS = 10
CLEAR_PCT = 20  # cold cache past this much context: the next message re-bills it all, /clear is cheaper
PIE = "○◔◑◕●"  # cache timer: drains as the cache runs down, empty once cold
SPINNER = "·✢✳✶✻✽✻✶✳✢"  # forward then back, like Claude Code's own
EFFORT = {"low": "lo", "medium": "med", "high": "hi", "xhigh": "xhi"}
SESSION_RE = r"[A-Za-z0-9_-]{1,128}"
# Clawd as on Claude Code's welcome banner: head with {} {} eyes, body (arms down, arms up), legs.
PET_HEAD = " ▐{}███{}▌"
PET_BODY = ("▝▜█████▛▘", "▗▟█████▙▖")
PET_LEGS = "  ▘▘ ▝▝"
# (lifetime tokens saved, what Clawd wears beside its head). Below the lowest stage it's an egg (whole, then cracked).
PET_STAGES = ((2_500_000, "✦✦"), (250_000, "✦"), (10_000, ""))
PET_EGG = (("   ▄▄", "  ▟██▙", "  ▜██▛"), ("   ▄▄", "  ▟▚▞▙", "  ▜██▛"))
PET_CRACK = 5_000  # the egg cracks halfway to hatching
PET_BLINK = 7  # Clawd blinks once every this many seconds
PET_WIDTH = 11  # columns Clawd takes left of the status line, gap included


def paint(text, color, bold=False):
    """color is an xterm-256 index or an (r, g, b) tuple."""
    if NO_COLOR or not text:
        return text
    code = f"38;2;{';'.join(map(str, color))}" if isinstance(color, tuple) else f"38;5;{color}"
    return f"\033[{'1;' if bold else ''}{code}m{text}\033[0m"


def label(text):
    return paint(text, GRAY)


SEP = paint(" · ", DARK)


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
    filled = math.ceil(pct / 100 * BAR_WIDTH)
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
    """(value to show, age of the rise): counts up from the old value over ROLL_SECS. Drops show at once."""
    hit = track(state, key, value, now)
    if not hit or hit[0] >= value:
        return value, None
    old, age = hit
    return old + (value - old) * min(1, age / ROLL_SECS), age


def fmt_reset(epoch):
    """'4:32p' when under 24h away, 'Fri' otherwise."""
    try:
        epoch = int(epoch)
        dt = datetime.fromtimestamp(epoch)
    except (TypeError, ValueError, OSError, OverflowError):
        return ""
    clock = f"{dt.hour % 12 or 12}:{dt:%M}{'a' if dt.hour < 12 else 'p'}"
    if 0 <= epoch - time.time() < 24 * 3600:
        return clock
    return f"{dt:%a}"


def fmt_limit(name, window, state, now, span):
    """'5h 63% 4:32p', plus 'full 3:10p' when the pace so far hits 100% before the reset."""
    pct = to_pct((window or {}).get("used_percentage"))
    if pct is None:
        return ""
    shown, age = rose(state, name, round(pct), now)
    out = label(name) + " " + paint(f"{shown:.0f}%", glow(age, level_color(pct)))
    reset = fmt_reset((window or {}).get("resets_at"))
    if reset:
        out += " " + label(reset)
        # ponytail: average pace since the window opened, not the last few minutes; sample pct in state if it lags
        resets = int(window["resets_at"])
        elapsed = now - (resets - span)
        if elapsed >= 600 and pct > 0:
            full = now + (100 - pct) * elapsed / pct
            if full < resets:
                out += " " + paint("full " + fmt_reset(full), RED)
    return out


def fmt_saved(transcript_path, state, now):
    """'saved ~18.3k' from saver.py's estimate; re-parsed only when the transcript changes."""
    try:
        st = os.stat(transcript_path)
        import saver  # installed next to this file
    except (OSError, TypeError, ValueError, ImportError):
        return ""
    key = [st.st_mtime, st.st_size]
    if state.get("saved_key") != key:
        # ponytail: full transcript parse per new message; parse only appended bytes if long sessions lag
        try:
            stats = saver.session_stats(transcript_path)
            state["saved_n"] = int(sum(r[1] for r in saver.saved_rows(stats)))
            state["noisy_n"] = stats["noisy_count"]
        except Exception:
            state["saved_n"] = state["noisy_n"] = 0
        state["saved_key"] = key
    n = state.get("saved_n") or 0
    if not n:
        return ""
    shown, age = rose(state, "saved", n, now)
    return label("saved ") + paint("~" + saver.fmt(shown), glow(age, GREEN))


def compact_pct():
    # Same variable Claude Code reads to auto-compact early; install.py sets it to 50.
    try:
        return float(os.environ.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", 50))
    except ValueError:
        return 50.0


CACHE_WRITE = re.compile(r'"cache_creation":\{([^}]*)\}')


def detect_ttl(transcript_path):
    """3600 or 300 from the newest cache write in the transcript tail, or None if there is none yet."""
    try:
        with open(transcript_path, "rb") as f:
            f.seek(max(0, os.path.getsize(transcript_path) - 65536))
            tail = f.read().decode("utf-8", "replace")
    except (OSError, TypeError):
        return None
    for body in reversed(CACHE_WRITE.findall(tail)):
        for key, ttl in (("ephemeral_1h_input_tokens", 3600), ("ephemeral_5m_input_tokens", 300)):
            m = re.search(rf'"{key}":(\d+)', body)
            if m and int(m.group(1)):
                return ttl
    return None


def cache_ttl(transcript_path=None):
    """CLAUDE_CACHE_TTL if set, else detected from the transcript, else 3600."""
    try:
        return max(1, int(os.environ["CLAUDE_CACHE_TTL"]))
    except (KeyError, ValueError):
        return detect_ttl(transcript_path) or 3600


def fmt_cache(idle, frame, ttl=3600):
    """Time left on the prompt cache, counted from the last transcript write, behind a pie that drains with it.

    Gray, then in its last 5 minutes it breathes through PULSE, one step per second.
    """
    if idle is None:
        return ""
    left = ttl - idle
    if left < 1:
        return paint(PIE[0] + " cold", RED)
    m, s = divmod(int(left), 60)
    pie = PIE[min(4, max(1, math.ceil(left / ttl * 4)))]
    return paint(f"{pie} {m}m" if m else f"{pie} {s}s", GRAY if left > 300 else PULSE[frame % len(PULSE)])


def feed_ledger(state, now):
    """Credit this session's new savings to ledger.json (lifetime and today); return the lifetime total."""
    path = os.path.join(CLAUDE_DIR, ".statusline-ctx", "ledger.json")  # the dot keeps it apart from session ids
    ledger = load_state(path)
    total = ledger.get("total")
    total = total if isinstance(total, (int, float)) else 0
    n, fed = state.get("saved_n") or 0, state.get("ledger_fed") or 0
    if n != fed:
        state["ledger_fed"] = n
        if n > fed:
            # ponytail: read-modify-write, two sessions saving in the same instant can drop one gain; lock if it matters
            days = ledger.get("days") if isinstance(ledger.get("days"), dict) else {}
            day = time.strftime("%Y-%m-%d", time.localtime(now))
            days[day] = (days.get(day) or 0) + n - fed
            total += n - fed
            save_state(path, {"total": total, "born": ledger.get("born") or now, "days": dict(sorted(days.items())[-60:])})
    return total


def pet_rows(stage, eyes="▛▜", wear=None, arms_up=False, cracked=False):
    """Clawd's three rows for a PET_STAGES entry; the egg for None. wear replaces the stage's sparkle."""
    if not stage:
        return PET_EGG[cracked]
    return PET_HEAD.format(*eyes) + (stage[1] if wear is None else wear), PET_BODY[arms_up], PET_LEGS


def fmt_pet(state, lifetime, now, frame, idle, left, bloated):
    """Clawd's three rows: eyes, arms and color from the session's signals; glows when it grows a stage."""
    stage = next((s for s in PET_STAGES if lifetime >= s[0]), None)
    hit = track(state, "pet_stage", stage[0] if stage else 0, now)
    grew = hit[1] if hit else None
    busy = idle is not None and idle < BUSY_SECS
    if not stage:
        rows = [(" " if busy and frame % 2 else "") + r for r in PET_EGG[lifetime >= PET_CRACK]]  # rocks while Claude works
        return [paint(r.ljust(PET_WIDTH), glow(grew, CLAUDE)) for r in rows]
    eyes, arms_up, wear, color = "▛▜", False, None, CLAUDE
    noisy = state.get("noisy_n") or 0
    sick = track(state, "noisy", noisy, now)
    if sick and sick[0] < noisy:  # a 2k+ token tool output just landed
        eyes, color = "▚▞", RED
    elif idle is not None and left <= 0:
        eyes, wear, color = "▀▀", " z", GRAY  # asleep
    elif bloated:
        color = RED
    elif idle is not None and left <= 300:
        color = PULSE[frame % len(PULSE)]
    elif busy:
        arms_up = frame % 2  # waves while Claude works
    if eyes == "▛▜" and idle is not None and int(idle) % PET_BLINK == PET_BLINK - 1:
        eyes = "▀▀"  # blink
    rows = pet_rows(stage, eyes, wear, arms_up)
    return [paint(r.ljust(PET_WIDTH), glow(grew, color)) for r in rows]


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
    else:
        # Skill-only caveman (npx skills add) writes no flag; say so instead of showing nothing.
        if os.path.isdir(os.path.join(CLAUDE_DIR, "skills", "caveman")):
            modes.append(("cave", "no plugin"))
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


def render(data, now=None, pet=False):
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

    ttl = cache_ttl(data.get("transcript_path")) if idle is not None else 3600
    modes = read_modes(session_id)
    hit = track(state, "modes", str(modes), now)
    effort = read_effort(data, cwd, model.get("id"))
    line1 = [
        paint(star + " " + (model.get("display_name") or model.get("id") or "Claude"), CLAUDE, bold=True),
        paint(EFFORT.get(effort, effort), GRAY),
        fmt_modes(modes, hit[1] if hit else None),
        fmt_saved(data.get("transcript_path"), state, now),
    ]

    ctx = to_pct((data.get("context_window") or {}).get("used_percentage"))
    rate = data.get("rate_limits") or {}
    left = ttl - idle if idle is not None else ttl
    lifetime = feed_ledger(state, now) if path else 0
    clawd = fmt_pet(state, lifetime, now, frame, idle, left, ctx is not None and ctx >= compact_pct() - 10) if pet else None
    ctx_part = ""
    if ctx is not None:
        cells = math.ceil(ctx / 100 * BAR_WIDTH)
        hit = track(state, "ctx", cells, now)
        glow_from, age = hit if hit and hit[0] < cells else (None, None)
        shown, _ = rose(state, "ctx_pct", round(ctx), now)
        ctx_part = label("ctx ") + bar(ctx, glow_from, age) + " " + paint(f"{shown:.0f}%", level_color(ctx))
        # 10 points before auto-compact: compact by hand at a clean break instead of mid-task.
        # Also when the cache is about to expire: compacting while warm costs a fraction of re-billing it cold.
        if left <= 0 and ctx >= CLEAR_PCT:
            ctx_part += " " + paint("/handoff /clear", YELLOW)
        elif ctx >= compact_pct() - 10 or (left <= min(300, ttl / 6) and idle >= BUSY_SECS and ctx >= CLEAR_PCT):
            ctx_part += " " + paint("/compact", YELLOW)
    line2 = [
        ctx_part,
        fmt_limit("5h", rate.get("five_hour"), state, now, 5 * 3600),
        fmt_limit("7d", rate.get("seven_day"), state, now, 7 * 86400),
        fmt_cache(idle, frame, ttl),
    ]

    if path:
        save_state(path, state)
    top, bottom = (SEP.join(p for p in line if p) for line in (line1, line2))
    lines = [top] + ([paint("⎿ ", DARK) + bottom] if bottom else [])
    if clawd:
        lines = [row + (lines[i] if i < len(lines) else "") for i, row in enumerate(clawd)]
    return "\n".join(lines)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    try:
        data = json.load(sys.stdin)
    except ValueError:
        data = {}
    # /toggle pet writes config.json; it beats the --pet the installer baked in, and takes effect on the next redraw.
    pet = load_state(os.path.join(CLAUDE_DIR, ".statusline-ctx", "config.json")).get("pet")
    print(render(data if isinstance(data, dict) else {}, pet=pet if isinstance(pet, bool) else "--pet" in sys.argv[1:]))


if __name__ == "__main__":
    main()
