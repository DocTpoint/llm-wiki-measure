#!/usr/bin/env python3
"""
forced-choice.py — build a duel round between two arms of a blind list.

Read-only. No LLM, no network, no vault access — it only reshapes the output
of graph-yield.py.

Why this exists. `score-blind.py` asks "does this connection carry?" one line
at a time, and a rater who wants to be fair says yes to both arms: there is no
cost to a generous yes, and a determined reader can construct a story for
almost any pair. On the reference vault that showed up as a floor of 13 % on
the RANDOMLY REWIRED arm — four pairs out of thirty that the rater talked
himself into, three of them after looking up literature. A floor that high
eats most of the distance between the arms above it.

A duel removes the escape. Each line shows one pair from each arm, side by
side, left/right assigned by coin flip, and the rater must pick one. Saying
"both are fine" is no longer available, and neither is "both are junk" — if
both are junk, the less bad one still carries the signal. What comes out is
not "how good is arm A" but the only quantity the y/n round could not
estimate: how often A beats C head to head.

Blinding. Which side belongs to which arm goes into a separate key file, the
same way graph-yield writes its own. Rate first, open the key afterwards.

Contamination. A rater who has already scored some of these pairs is no
longer blind to them: pass those pairs' text with --exclude (one pair per
line, or a rendered blind list — the pair text is matched, not the number)
and they are dropped from both pools before the duels are drawn.

usage:
    python3 forced-choice.py --blind pool.md --key pool-key.json \\
        --arms "A graph" "C embedding" --exclude seen.md \\
        --duels 60 --out duels.md
"""
import argparse, hashlib, json, os, random, re, subprocess
from datetime import datetime
from pathlib import Path

__version__ = "0.5.0"

PAIR = re.compile(r"^\s*(\d+)\.\s+(.*?)(?:\s+_+)?\s*$")


def stamp():
    """One line naming the exact code that produced the output below."""
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


def read_pairs(path):
    """number -> pair text, from a blind list as graph-yield renders it."""
    out = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        m = PAIR.match(line)
        if m and "—[" in m.group(2):
            out[int(m.group(1))] = m.group(2).strip()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--blind", required=True, type=Path)
    ap.add_argument("--key", required=True, type=Path)
    ap.add_argument("--arms", nargs=2, required=True,
                    help="the two arm names to duel, exactly as in the key")
    ap.add_argument("--exclude", type=Path, default=None,
                    help="pairs the rater has already seen (blind list or plain lines)")
    ap.add_argument("--duels", type=int, default=60)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", type=Path, default=Path("duels.md"))
    a = ap.parse_args()

    random.seed(a.seed)
    pairs = read_pairs(a.blind)
    arm_of = {d["nr"]: d["arm"] for d in json.loads(a.key.read_text())}
    left_arm, right_arm = a.arms

    seen = set()
    if a.exclude:
        for line in a.exclude.read_text(encoding="utf-8").splitlines():
            m = PAIR.match(line)
            t = (m.group(2).strip() if m else line.strip())
            if "—[" in t:
                seen.add(t)

    pool = {}
    for arm in (left_arm, right_arm):
        got = sorted(t for nr, t in pairs.items()
                     if arm_of.get(nr) == arm and t not in seen)
        if not got:
            raise SystemExit(f"no unseen pairs left for arm {arm!r}")
        pool[arm] = got
        random.shuffle(pool[arm])

    n = min(a.duels, len(pool[left_arm]), len(pool[right_arm]))
    print(stamp())
    for arm in (left_arm, right_arm):
        dropped = sum(1 for nr, t in pairs.items()
                      if arm_of.get(nr) == arm and t in seen)
        print(f"{arm:<20} {len(pool[arm]):>3} unseen  ({dropped} dropped as already rated)")
    if n < a.duels:
        print(f"note: {a.duels} duels asked for, {n} possible")

    duels, key = [], []
    for i in range(n):
        x, y = pool[left_arm][i], pool[right_arm][i]
        flip = random.random() < 0.5
        l, r = (x, y) if flip else (y, x)
        duels.append((i + 1, l, r))
        key.append({"nr": i + 1,
                    "L": left_arm if flip else right_arm,
                    "R": right_arm if flip else left_arm,
                    "left_pair": l, "right_pair": r})

    body = "\n\n".join(
        f"{nr:>3}.  L: {l}\n     R: {r}\n     ___" for nr, l, r in duels)
    a.out.write_text(
        "# Forced choice — which of the two connections carries more?\n\n"
        "One pair from each of two arms, side by side, side assigned by coin\n"
        "flip. Pick **L** or **R** for every line. A tie is not on offer: if\n"
        "both are junk, the less bad one is still an answer, and that is the\n"
        "whole point — a generous yes to both is what this round removes.\n"
        "Which side belongs to which arm is in the key file. Rate first.\n\n"
        + body + "\n", encoding="utf-8")
    keyfile = a.out.with_name(a.out.stem + "-key.json")
    keyfile.write_text(json.dumps(key, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\n{n} duels -> {a.out}   key -> {keyfile}")
    print(f"score it with:  python3 score-duels.py --choices my.txt --key {keyfile}")


if __name__ == "__main__":
    main()
