#!/usr/bin/env python3
"""Minimal two-line status line for Claude Code.

Line 1: model | effort | active modes (ponytail, caveman)
Line 2: context | 5h limit | 7d limit | prompt cache
"""

import json
import os
import re
import sys
import time
from datetime import datetime

NO_COLOR = bool(os.environ.get("NO_COLOR"))

GRAY = 244
WHITE = 255
DARK = 238
GREEN = 114
YELLOW = 179
RED = 167

CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
BAR_WIDTH = 12


def paint(text, color, bold=False):
    if NO_COLOR:
        return text
    return f"\033[{'1;' if bold else ''}38;5;{color}m{text}\033[0m"


def label(text):
    return paint(text, GRAY)


SEP = "  " + paint("|", DARK) + "  "


def level_color(pct):
    return GREEN if pct < 50 else YELLOW if pct < 80 else RED


def to_pct(value):
    try:
        return max(0.0, min(100.0, float(value)))
    except (TypeError, ValueError):
        return None


def bar(pct):
    filled = round(pct / 100 * BAR_WIDTH)
    return (
        paint("[", DARK)
        + paint("=" * filled, level_color(pct))
        + paint("-" * (BAR_WIDTH - filled), DARK)
        + paint("]", DARK)
    )


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


def fmt_limit(name, window):
    pct = to_pct((window or {}).get("used_percentage"))
    if pct is None:
        return ""
    out = label(name) + " " + paint(f"{pct:.0f}%", level_color(pct), bold=True)
    reset = fmt_reset((window or {}).get("resets_at"))
    if reset:
        out += " " + label(reset)
    return out


def cache_ttl():
    try:
        return max(1, int(os.environ.get("CLAUDE_CACHE_TTL", 3600)))
    except ValueError:
        return 3600


def fmt_cache(transcript_path):
    """Time left on the prompt cache, counted from the last transcript write."""
    if not transcript_path:
        return ""
    ttl = cache_ttl()
    try:
        left = ttl - (time.time() - os.path.getmtime(transcript_path))
    except OSError:
        return ""
    if left < 1:
        return label("cache ") + paint("cold", RED, bold=True)
    m, s = divmod(int(left), 60)
    color = GREEN if left > ttl / 2 else YELLOW if left > 300 else RED
    return label("cache ") + paint(f"{m}m" if m else f"{s}s", color, bold=True)


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
    parts = []
    pony = read_flag(os.path.join(CLAUDE_DIR, ".ponytail-active"))
    if pony:
        parts.append(label("pony ") + paint(pony, WHITE))
    # Per-session caveman flag wins over the machine-wide mirror.
    cave_paths = [os.path.join(CLAUDE_DIR, ".caveman-active")]
    if session_id and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session_id):
        cave_paths.insert(0, os.path.join(CLAUDE_DIR, ".caveman-sessions", session_id + ".mode"))
    for path in cave_paths:
        if os.path.exists(path):
            cave = read_flag(path)
            if cave:
                parts.append(label("cave") + ("" if cave == "caveman" else " " + paint(cave, WHITE)))
            break
    return paint(" + ", DARK).join(parts)


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
            with open(path) as f:
                cfg = json.load(f)
        except (OSError, ValueError):
            continue
        per_model = ((cfg.get("modelSettings") or {}).get(model_id) or {}).get("effortLevel")
        value = per_model or cfg.get("effortLevel")
        if isinstance(value, str) and value:
            return value.lower()
    return ""


def render(data):
    model = data.get("model") or {}
    cwd = (data.get("workspace") or {}).get("current_dir") or data.get("cwd") or os.getcwd()

    line1 = [
        paint(model.get("display_name") or model.get("id") or "Claude", WHITE, bold=True),
        paint(read_effort(data, cwd, model.get("id")), GRAY),
        read_modes(data.get("session_id")),
    ]

    ctx = to_pct((data.get("context_window") or {}).get("used_percentage"))
    rate = data.get("rate_limits") or {}
    line2 = [
        "" if ctx is None
        else label("ctx ") + bar(ctx) + " " + paint(f"{ctx:.0f}%", level_color(ctx), bold=True),
        fmt_limit("5h", rate.get("five_hour")),
        fmt_limit("7d", rate.get("seven_day")),
        fmt_cache(data.get("transcript_path")),
    ]

    return "\n".join(SEP.join(p for p in line if p) for line in (line1, line2))


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
