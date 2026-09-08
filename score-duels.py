#!/usr/bin/env python3
"""
score-duels.py — score a forced-choice round against the key.

The choices file is one line per duel: the number, whitespace, then L or R.
Lines you did not decide are ignored. Commit your choices BEFORE opening the
key — that is the whole point of the exercise.

What it reports: how often each arm won, a Wilson interval on the first arm's
share, and a two-sided binomial p against the only null worth stating here,
namely that the two arms are interchangeable and the winner of each duel is a
coin flip. Read the interval, not the p: at 60 duels the interval is still
about ±12 points, and an arm that wins 55 % of duels has not been shown to
win anything.

Side bias is reported too, because it is the failure mode of this design: a
rater who leans left when undecided produces a difference out of nothing. If
the left-hand side wins far from half the time, the round is spoiled and the
numbers above it mean nothing.

usage:  python3 score-duels.py --choices my.txt --key duels-key.json
"""
import argparse, hashlib, json, math, os, subprocess
from collections import Counter
from datetime import datetime
from pathlib import Path

__version__ = "0.3.0"


def stamp():
    """One line naming the exact code that produced the numbers below."""
    f = os.path.abspath(__file__)
    ver = "sha256:" + hashlib.sha256(open(f, "rb").read()).hexdigest()[:8]
    try:
        d = os.path.dirname(f)
        r = subprocess.run(["git", "-C", d, "rev-parse", "--short", "HEAD"],
                           capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            m = subprocess.run(["git", "-C", d, "status", "--porcelain", "--", f],
                               capture_output=True, text=True, timeout=5)
            ver = r.stdout.strip() + ("+dirty" if m.stdout.strip() else "") + " · " + ver
    except Exception:
        pass
    return (f"# llm-wiki-measure {__version__} · {os.path.basename(f)} · {ver}\n"
            f"# {datetime.now().astimezone().strftime('%Y-%m-%d %H:%M %z')}")


def wilson(k, n):
    if n == 0:
        return (0.0, 0.0)
    p, z = k / n, 1.96
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def binom_two_sided(k, n):
    """P(|X - n/2| >= |k - n/2|) for X ~ Binomial(n, 1/2)."""
    if n == 0:
        return 1.0
    d = abs(k - n / 2)
    return min(1.0, sum(math.comb(n, i) for i in range(n + 1)
                        if abs(i - n / 2) >= d) / 2 ** n)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--choices", required=True, type=Path)
    ap.add_argument("--key", required=True, type=Path)
    a = ap.parse_args()

    key = {d["nr"]: d for d in json.loads(a.key.read_text())}
    ch = {}
    for line in a.choices.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].rstrip(".").isdigit():
            v = parts[1].upper()[0]
            if v in "LR":
                ch[int(parts[0].rstrip("."))] = v

    wins, sides = Counter(), Counter()
    for nr, d in key.items():
        if nr in ch:
            wins[d[ch[nr]]] += 1
            sides[ch[nr]] += 1

    print(stamp())
    missing = len(key) - len(ch)
    if missing:
        print(f"note: {missing} of {len(key)} duels undecided — they are ignored\n")
    arms = sorted(wins)
    n = sum(wins.values())
    if not arms or n == 0:
        raise SystemExit("nothing to score")
    first = arms[0]
    k = wins[first]
    lo, hi = wilson(k, n)
    print(f"duels decided: {n}")
    for arm in arms:
        print(f"  {arm:<20}{wins[arm]:>4} wins   {wins[arm]/n:>5.0%}")
    print(f"\n{first}: {k}/{n} = {k/n:.0%}   95% CI {lo:.0%} – {hi:.0%}   "
          f"p = {binom_two_sided(k, n):.3f} against a coin flip")
    ls = sides["L"] / n
    print(f"side bias: left won {sides['L']}/{n} = {ls:.0%}", end="")
    print("   ok" if 0.35 <= ls <= 0.65 else "   ⚠ far from half — the round is suspect")


if __name__ == "__main__":
    main()
