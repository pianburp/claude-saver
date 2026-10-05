#!/usr/bin/env python3
"""Play the status line's animations in your terminal with fake data. Run: python3 demo.py

Nothing in ~/.claude is read or written: flags, state and the transcript live in a temp dir.
"""

import json
import os
import sys
import tempfile
import time

import statusline as sl

FPS = 2  # demo seconds per real second; the status line animates once per (demo) second


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    if os.name == "nt":
        os.system("")  # turn on ANSI escapes in the Windows console
    sl.CLAUDE_DIR = tempfile.mkdtemp()
    for name, mode in ((".ponytail-active", "full"), (".caveman-active", "caveman")):
        with open(os.path.join(sl.CLAUDE_DIR, name), "w") as f:
            f.write(mode)
    tp = os.path.join(sl.CLAUDE_DIR, "demo.jsonl")

    def reply(chars):
        with open(tp, "a") as f:
            f.write(json.dumps({"message": {"id": str(time.time()), "role": "assistant",
                                            "content": [{"type": "text", "text": "a" * chars}]}}) + "\n")

    with open(tp, "w") as f:
        f.write('{"message":{"role":"user","content":"CAVEMAN MODE ACTIVE"}}\n')
    reply(4000)

    t0 = int(time.time())
    ctx, h5, d7 = 8, 20, 41
    print("\n\n")
    for i in range(30):
        now = t0 + i
        if i in (3, 10):
            reply(12000)
            ctx, h5, d7 = ctx + 18, h5 + 22, d7 + 6
        if i < 16:
            caption, written = "working: spinner turns, rising numbers count up and glow", now - (i % 3)
        elif i < 23:
            caption, written = "idle: cache under 5 minutes pulses red", now - 3600 + 240
        else:
            caption, written = "cache cold with context past 20%: /clear is cheaper than the next message", now - 3601
        os.utime(tp, (written, written))
        data = {
            "session_id": "demo",
            "transcript_path": tp,
            "model": {"display_name": "Opus 5.5"},
            "effort": "high",
            "context_window": {"used_percentage": ctx},
            "rate_limits": {"five_hour": {"used_percentage": h5, "resets_at": t0 + 3 * 3600},
                            "seven_day": {"used_percentage": d7, "resets_at": t0 + 4 * 86400}},
        }
        lines = sl.render(data, now=now).split("\n") + [sl.label("  " + caption)]
        sys.stdout.write("\033[3A" + "".join("\r\033[K" + line + "\n" for line in lines))
        sys.stdout.flush()
        time.sleep(1 / FPS)


if __name__ == "__main__":
    main()
