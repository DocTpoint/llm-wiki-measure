#!/usr/bin/env python3
"""
score-blind.py — score a blind rating against the key.

The ratings file is one line per pair: the number, whitespace, then y, n or ?.
Lines you did not rate are ignored. Commit your ratings BEFORE looking at the
key file — that is the whole point of the exercise.

usage:  python3 score-blind.py --ratings my.txt --key blind-pairs-key.json
"""
import argparse, json, math
from collections import Counter, defaultdict
from pathlib import Path


def stamp():
    """One line naming the exact code that produced the numbers below.

    A figure quoted out of this output has to carry its origin or nobody --
    its author included -- can reproduce it later. The `+dirty` marker is the
    part that earns its keep: an uncommitted edit turns a bare SHA into a
    false claim of reproducibility, and that is precisely when a number is
    most likely to be wrong.
    """
    import hashlib, os, subprocess
    from datetime import datetime
    f = os.path.abspath(__file__)
    ver = "sha256:" + hashlib.sha256(open(f, "rb").read()).hexdigest()[:8]
    try:
        d = os.path.dirname(f)
        r = subprocess.run(["git", "-C", d, "rev-parse", "--short", "HEAD"],
                           capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            m = subprocess.run(["git", "-C", d, "status", "--porcelain", "--", f],
                               capture_output=True, text=True, timeout=5)
            ver = r.stdout.strip() + ("+dirty" if m.stdout.strip() else "") + " \u00b7 " + ver
    except Exception:
        pass
    return (f"# llm-wiki-measure \u00b7 {os.path.basename(f)} \u00b7 {ver}\n"
            f"# {datetime.now().astimezone().strftime('%Y-%m-%d %H:%M %z')}")


def wilson(k, n):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    z = 1.96
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ratings", required=True, type=Path)
    ap.add_argument("--key", required=True, type=Path)
    a = ap.parse_args()

    key = {d["nr"]: d["arm"] for d in json.loads(a.key.read_text())}
    rat = {}
    for line in a.ratings.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].rstrip(".").isdigit():
            v = parts[1].lower()[0]
            if v in "ynj?":
                rat[int(parts[0].rstrip("."))] = "y" if v in "yj" else v

    agg = defaultdict(Counter)
    for nr, arm in key.items():
        if nr in rat:
            agg[arm][rat[nr]] += 1
    print(stamp())
    missing = len(key) - len(rat)
    if missing:
        print(f"note: {missing} of {len(key)} pairs unrated — they are ignored\n")
    print(f"{'arm':<20}{'y':>4}{'n':>4}{'?':>4}   carries      95% CI")
    for arm in sorted(agg):
        c = agg[arm]
        y, n = c["y"], c["n"]
        lo, hi = wilson(y, y + n)
        rate = f"{y/(y+n):>6.0%}" if y + n else "     —"
        print(f"{arm:<20}{y:>4}{n:>4}{c['?']:>4}   {rate}    {lo:>4.0%} – {hi:>3.0%}")
    print("\nRead the gap to the rewired arm first: it is the floor that any")
    print("graph of this shape reaches without knowing anything. A difference")
    print("of a few points between the other arms is not a result at n=30 —")
    print("run a forced-choice round on the arms that end up close.")


if __name__ == "__main__":
    main()
