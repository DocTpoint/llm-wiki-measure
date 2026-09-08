#!/usr/bin/env python3
"""Find designators that span both page types.

A designator is the string a page answers to: its title or any of its aliases.
The same letters can be a legitimate name in both folders — `CR` is Chromium as
an entity and Caloric Restriction as a concept — so a designator is the pair
(letters, type), and two pages sharing only the letters do not collide.

This probe lists every slug key that occurs in `entities` *and* `concepts` and
sorts each one by **where the designator sits** — a structural fact the files
state, not a judgement:

  A  title on one side, alias on the other  — one page carries it as its
     canonical name, the other as a secondary one
  B  title on both sides                    — two pages claim the same
     canonical name in different types
  C  title on neither side                  — both pages are named something
     else and both answer to this third string

What each case *means* does not follow from its class. A spanning designator is
one of three things — a genuine homonym, a duplicate that should be merged, or a
typed relation written as identity (a drug aliased onto its drug class) — and
telling them apart is a curation decision this probe does not make. On the vault
it was written for, all three kinds appeared, and the largest group sat in class
C alongside the homonyms.

No model call, no writes. The slug function is a port of the plugin's
`computeSlug` in its comparison form (preserveCase=false).

--- why --verify exists ---

The first version of this probe reported 5 spanning designators. The real
number was 29. The alias regex was `^aliases:\\s*(.*)$`: `\\s` matches the
newline, so on a block list the capture ran into the first item and that item
was then never seen as a list line. The probe did not crash and did not warn --
it silently dropped the first alias of every page and returned a plausible
number.

It was caught only because a known answer existed: an upstream issue named
`KHK` as a spanning designator, and `KHK` was missing. Hence `--expect`: give
the probe an answer you already know before you trust one you do not.
"""
import argparse
import os
import re
import sys
from collections import defaultdict

# port of computeSlug (src/core/slug.ts), comparison form
INVALID = re.compile(r'[\x00-\x1f]|[/\\:*?"<>|,()\'!?、，。；：！？（）【】《》]')


__version__ = "0.3.0"


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
    return (f"# llm-wiki-measure {__version__} \u00b7 {os.path.basename(f)} \u00b7 {ver}\n"
            f"# {datetime.now().astimezone().strftime('%Y-%m-%d %H:%M %z')}")


def compute_slug(text):
    t = text.strip()
    if not t:
        return "untitled"
    t = INVALID.sub("", t)
    if not t:
        return "untitled-x"
    t = re.sub(r"[\s.]+", "-", t)
    t = re.sub(r"-+", "-", t)
    t = re.sub(r"^-|-$", "", t).strip()
    return t.lower() if t else "untitled-x"


def frontmatter(text):
    if not text.startswith("---"):
        return ""
    end = text.find("\n---", 3)
    return text[3:end] if end > 0 else ""


def aliases_of(fm):
    """Flow list or block list.

    Deliberately `[ \\t]` and never `\\s`: `\\s` eats the newline, swallows the
    first item of a block list, and reports a smaller number without any error.
    """
    m = re.search(r"^aliases:[ \t]*(.*)$", fm, re.M)
    if not m:
        return []
    inline = m.group(1).strip()
    if inline.startswith("["):
        return [x.strip().strip("'\"") for x in inline.strip("[]").split(",") if x.strip()]
    out = []
    for line in fm[m.end():].split("\n"):
        if re.match(r"^[ \t]*-[ \t]+", line):
            out.append(re.sub(r"^[ \t]*-[ \t]+", "", line).strip().strip("'\""))
        elif line.strip():
            break
    return [a for a in out if a]


def build_index(wiki, folders):
    keys = defaultdict(lambda: defaultdict(list))
    counts = {}
    for folder in folders:
        d = os.path.join(wiki, folder)
        if not os.path.isdir(d):
            sys.exit(f"no folder at {d}")
        files = [f for f in os.listdir(d) if f.endswith(".md")]
        counts[folder] = len(files)
        for fn in files:
            title = fn[:-3]
            with open(os.path.join(d, fn), encoding="utf-8", errors="replace") as f:
                fm = frontmatter(f.read())
            keys[compute_slug(title)][folder].append((title, "title"))
            for a in aliases_of(fm):
                keys[compute_slug(a)][folder].append((title, f"alias <{a}>"))
    return keys, counts


def classify(span, folders):
    a, b, c = [], [], []
    for k in sorted(span):
        left, right = span[k][folders[0]], span[k][folders[1]]
        l_title = any(kind == "title" for _, kind in left)
        r_title = any(kind == "title" for _, kind in right)
        pair = (f"{'/'.join(sorted({t for t, _ in left}))} <> "
                f"{'/'.join(sorted({t for t, _ in right}))}")
        if l_title != r_title:
            a.append((k, pair, folders[0] if l_title else folders[1]))
        elif l_title:
            b.append((k, pair))
        else:
            c.append((k, pair))
    return a, b, c


def selftest():
    """Nails the failure classes, not the numbers. Runs without a vault."""
    print(stamp())
    checks = []

    def ck(name, got, want):
        checks.append((name, got, want, got == want))

    block = "\naliases:\n  - \"KHK\"\n  - \"Koronare Herzkrankheit\"\ntags:\n  - Kardio\n"
    ck("block list: FIRST item survives (the \\s bug)",
       aliases_of(block), ["KHK", "Koronare Herzkrankheit"])
    ck("block list: stops at the next key",
       aliases_of(block + "more: x\n  - notanalias\n")[-1], "Koronare Herzkrankheit")
    ck("flow list", aliases_of("\naliases: [PTBS, PTSD]\n"), ["PTBS", "PTSD"])
    ck("no aliases key", aliases_of("\ntype: entity\n"), [])
    ck("tab indent is not a newline", aliases_of("\naliases:\t\n  - A\n"), ["A"])
    ck("slug: case folded", compute_slug("Vitamin D"), "vitamin-d")
    ck("slug: parens dropped", compute_slug("Chrom (Element)"), "chrom-element")
    ck("slug: dots become separators", compute_slug("E. coli"), "e-coli")
    ck("slug: empty stays addressable", compute_slug("()"), "untitled-x")
    ck("frontmatter: no block", frontmatter("# Title\n"), "")

    width = max(len(n) for n, *_ in checks)
    for name, got, want, ok in checks:
        print(f"  [{'OK ' if ok else 'FAIL'}] {name:<{width}}  got={got!r}")
    bad = sum(1 for *_, ok in checks if not ok)
    print(f"  -> {len(checks) - bad}/{len(checks)} passed")
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", type=str, help="vault root")
    ap.add_argument("--wiki", default="wiki", help="wiki folder name")
    ap.add_argument("--folders", "--page-folders", dest="folders", default="entities,concepts",
                    help="comma-separated wiki subfolders that hold the pages (default: entities,concepts)")
    ap.add_argument("--expect", action="append", default=[], metavar="DESIGNATOR",
                    help="a designator you already know spans; exits non-zero if "
                         "it is missing. Use it before trusting an answer you "
                         "do not know.")
    ap.add_argument("--verify", action="store_true", help="self-test, no vault needed")
    a = ap.parse_args()

    if a.verify:
        sys.exit(selftest())
    if not a.vault:
        ap.error("--vault is required (or use --verify)")

    folders = [f.strip() for f in a.folders.split(",")]
    if len(folders) != 2:
        ap.error("--folders takes exactly two names")

    wiki = os.path.join(os.path.expanduser(a.vault), a.wiki)
    keys, counts = build_index(wiki, folders)
    span = {k: v for k, v in keys.items() if len(v) == 2}

    total = sum(counts.values())
    print(stamp())
    print(f"pages     : " + " + ".join(f"{f} {counts[f]}" for f in folders) + f" = {total}")
    print(f"slug keys : {len(keys)}")
    print(f"SPANNING  : {len(span)} designators occur in both folders\n")

    cls_a, cls_b, cls_c = classify(span, folders)
    for label, rows in (
        (f"A  title on one side, alias on the other -> {len(cls_a)}", cls_a),
        (f"B  title on both sides (genuine homonym) -> {len(cls_b)}", cls_b),
        (f"C  alias on both, title on neither       -> {len(cls_c)}", cls_c),
    ):
        print(label)
        for row in rows:
            k, pair = row[0], row[1]
            side = f"  [title in {row[2]}]" if len(row) > 2 else ""
            print(f"   [{k}] {pair}{side}")
        print()

    missing = [e for e in a.expect if compute_slug(e) not in span]
    if a.expect:
        print(f"--expect: {len(a.expect) - len(missing)}/{len(a.expect)} found")
        for e in missing:
            print(f"  MISSING: {e} (slug {compute_slug(e)})")
        if missing:
            print("\nA known answer is absent. Do not trust the count above -- this is")
            print("exactly how the silently-dropped-alias bug looked.")
            sys.exit(1)

    print("NOTE: spanning letters are not a collision. A designator is (letters,")
    print("type), so the same string in two folders is the alphabet, not a defect.")
    print("Which of these are homonyms, which duplicates, and which typed relations")
    print("written as identity is a curation call -- the class above does not decide")
    print("it. Read the pairs.")


if __name__ == "__main__":
    main()
