#!/usr/bin/env python3
"""
coverage-probe.py — how much of a vault's source material reached the graph?

Read-only. No LLM, no network, no plugin. Runs against any llm-wiki vault.

It overlays two layers that fail in different ways:

  layer 1  a literal, semantics-free mention: the page's title or one of its
           aliases occurs verbatim in a note's text (word boundaries, case
           sensitive, URLs stripped).
  layer 2  what the graph actually recorded — the `sources:` list on the page.

The gap between them is the space the extraction operated in. It is a
DENOMINATOR, not a defect count: a literal mention is not automatically a
relation worth an edge. What the number does say is how much material was
available to be judged, versus how much a single extraction pass took.

Self-calibration: on the notes a page already lists as its sources, the edge
is known to exist. If layer 1 cannot find the name there either, its recall
is below 1 and every gap figure inherits that error. The script measures and
prints that recall; read it before reading anything else.

Two artifact classes are handled explicitly, because both produced
spectacular nonsense on the first run of the original version:
  - URLs: `ncbi.nlm.nih.gov` matched a page named "NIH" in 261 notes;
    a citation path `.../kupfer-mangan-chrom-molybdaen/` matched "Chrom".
  - Case folding: a page aliased "ALS" matched the German word "als" in 373
    notes. Matching is case sensitive for that reason.

usage:
    python3 coverage-probe.py --vault ~/Vault [--wiki wiki] [--notes Notes]
                              [--min-alias 3] [--json out.json]
"""
import argparse, json, os, re, sys
from collections import Counter, defaultdict
from pathlib import Path

URL_RE = re.compile(r"https?://\S+|\]\([^)]*\)|\bwww\.\S+")
SKIP_DIRS = {".obsidian", ".trash", ".git", "node_modules"}


__version__ = "0.4.0"


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


def frontmatter(text):
    m = re.match(r"^---\n(.*?)\n---", text, re.S)
    return m.group(1) if m else ""


def fm_list(fm, key):
    """Flow list OR block list. Deliberately no `\\s` in the line regex: `\\s`
    eats the newline and silently turns a block list into a one-item inline
    value — the kind of bug that makes a probe agree with your expectation."""
    m = re.search(rf"^{key}:[ \t]*\[(.*?)\]", fm, re.M)
    if m:
        return [x.strip().strip("\"'") for x in m.group(1).split(",") if x.strip()]
    m = re.search(rf"^{key}:[ \t]*\n((?:[ \t]*-[ \t]*.+\n?)+)", fm, re.M)
    if m:
        return [re.sub(r"^[ \t]*-[ \t]*", "", l).strip().strip("\"'")
                for l in m.group(1).splitlines() if l.strip()]
    return []


def body(text):
    m = re.match(r"^---\n.*?\n---\n?(.*)$", text, re.S)
    return URL_RE.sub(" ", m.group(1) if m else text)


def norm(s):
    """`sources:` carries slugs (`Silent-Inflammation`); note files may use
    spaces. Without this, correctly recorded edges count as missing."""
    return re.sub(r"\s+", " ", re.sub(r"[-_+]", " ", s)).strip().lower()


def mentions(needle, text):
    return needle in text and re.search(
        rf"(?<!\w){re.escape(needle)}(?!\w)", text) is not None


def note_files(vault, wiki, notes_dir, skip=()):
    """Every note file: under --notes if given, else every .md outside the wiki.

    Symlinked folders are walked. A vault that keeps its notes behind a
    symlink used to yield nothing here, and an empty note set is not
    distinguishable in the output from a vault that has no notes.
    """
    if notes_dir:
        root = Path(notes_dir).expanduser()
        if not root.is_absolute():
            root = vault / root
        if not root.is_dir():
            raise SystemExit(f"no notes folder at {root}")
        skip_wiki = False
    else:
        root, skip_wiki = vault, True
    seen = set()
    for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
        real = os.path.realpath(dirpath)
        if real in seen:
            dirnames[:] = []
            continue
        seen.add(real)
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in skip
                       and not (skip_wiki and Path(dirpath) == root and d == wiki)]
        for fn in sorted(filenames):
            if fn.endswith(".md"):
                yield Path(dirpath) / fn


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", required=True, type=Path)
    ap.add_argument("--wiki", default="wiki", help="wiki folder name")
    ap.add_argument("--notes", default=None,
                    help="notes folder; default: every .md outside the wiki folder")
    ap.add_argument("--page-folders", default="entities,concepts",
                    help="comma-separated wiki subfolders that hold the pages (default: entities,concepts)")
    ap.add_argument("--provenance-field", default="sources",
                    help="frontmatter field listing the source pages a page was built from (default: sources)")
    ap.add_argument("--min-alias", type=int, default=3,
                    help="ignore aliases shorter than this (acronym noise)")
    ap.add_argument("--json", type=Path, default=None)
    a = ap.parse_args()

    vault = a.vault.expanduser()
    wiki = vault / a.wiki
    if not wiki.is_dir():
        sys.exit(f"no wiki folder at {wiki}")

    notes = {}
    for p in note_files(vault, a.wiki, a.notes, SKIP_DIRS):
        raw = p.read_text(encoding="utf-8", errors="replace")
        notes[p.stem] = {"tags": fm_list(frontmatter(raw), "tags"),
                         "text": body(raw)}
    if not notes:
        sys.exit("no notes found — pass --notes")

    pages = {}
    page_folders = [x.strip() for x in a.page_folders.split(",") if x.strip()]
    for sub in page_folders:
        for p in sorted((wiki / sub).glob("*.md")):
            raw = p.read_text(encoding="utf-8", errors="replace")
            fm = frontmatter(raw)
            h1 = re.search(r"^#\s+(.+)$", body(raw), re.M)
            title = h1.group(1).strip() if h1 else p.stem.replace("-", " ")
            names = [title] + [x for x in fm_list(fm, "aliases")
                               if len(x) >= a.min_alias]
            pages[p.stem] = {
                "title": title, "kind": sub, "tags": fm_list(fm, "tags"),
                "sources": [re.sub(r".*?/", "", s.strip("[]")).strip()
                            for s in fm_list(fm, a.provenance_field)],
                "needles": sorted({n for n in names if n}),
            }
    if not pages:
        sys.exit(f"no pages under {wiki}/{{{','.join(page_folders)}}}")

    bystem = {norm(k): k for k in notes}
    for pg in pages.values():
        pg["sources"] = [bystem[norm(s)] for s in pg["sources"] if norm(s) in bystem]

    hits = defaultdict(list)
    for slug, pg in pages.items():
        for stem, nt in notes.items():
            if any(mentions(n, nt["text"]) for n in pg["needles"]):
                hits[slug].append(stem)

    total = sum(len(v) for v in hits.values())
    known = sum(len(pg["sources"]) for pg in pages.values())
    found = sum(1 for slug, pg in pages.items()
                for s in pg["sources"] if s in hits.get(slug, []))
    linked = found
    gap = total - linked
    tagged = sum(1 for n in notes.values() if n["tags"])
    disj = sum(1 for slug, pg in pages.items()
               if set(pg["tags"]) and any(
                   set(notes[m]["tags"]) and not set(pg["tags"]) & set(notes[m]["tags"])
                   for m in hits.get(slug, [])))

    print(stamp())
    print(f"vault      : {vault}")
    print(f"notes      : {len(notes)} ({tagged} carry tags)")
    print(f"pages      : {len(pages)} (entities + concepts)")
    print()
    print(f"CONTROL — layer 1 recall on edges the graph already records")
    print(f"  {found}/{known} ({found / known:.1%})" if known else "  no sources recorded")
    if known and found / known < 0.8:
        print("  ⚠ below 80%: page names often do not occur verbatim in their own")
        print("    source note, so the gap figures below understate the material.")
    print()
    print(f"LAYER 1 — literal mentions (page × note): {total}")
    print(f"  recorded as `sources:` : {linked} ({linked / total:.1%})")
    print(f"  not recorded           : {gap} ({gap / total:.1%})")
    print(f"  pages never mentioned in any note: "
          f"{sum(1 for s in pages if not hits.get(s))}")
    if tagged:
        print()
        print(f"LAYER 2 — tags as a disambiguation signal")
        print(f"  pages whose tags are disjoint from >=1 note that mentions them: "
              f"{disj} ({disj / len(pages):.1%})")
        print("  (a rule reading 'disjoint tags = different entity' would fire there;")
        print("   one referent seen through several aspects looks exactly like two)")
    print()
    print("largest gaps (unrecorded mentions):")
    for u, m, t in sorted(((len(hits[s]) - sum(1 for x in hits[s] if x in set(pages[s]["sources"])),
                            len(hits[s]), pages[s]["title"]) for s in hits),
                          reverse=True)[:12]:
        print(f"  {u:>4} of {m:>4} · {t}")
    print()
    print("NOTE: a literal mention is not automatically a relation. This is the")
    print("space extraction had available, not a count of defects.")

    if a.json:
        a.json.write_text(json.dumps(
            {"pages": {s: {"title": pages[s]["title"], "mentions": hits.get(s, []),
                           "sources": pages[s]["sources"]} for s in pages}},
            ensure_ascii=False, indent=1))
        print(f"\nper-page detail → {a.json}")


if __name__ == "__main__":
    main()
