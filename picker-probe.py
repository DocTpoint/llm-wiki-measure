#!/usr/bin/env python3
"""
picker-probe.py — did the ingest order pick the notes the vault refers to,
or the ones that sort first?

Read-only. No LLM, no network, no plugin. Runs against any llm-wiki vault.

The set of ingested notes is read from the `source_file:` field of the
source pages (--source-field, --sources-folder to change the names). It is compared with two other sets of the same size:

  alphabetical  the first N notes by filename — what a folder ingest does.
  reference     the N notes most often linked as `[[Title]]` from the other
                notes — a cheap, model-free stand-in for "what the vault is
                about". Half of the reference vault's notes are linked by no
                other note at all, so this ranking has a long flat tail; the
                head is what matters.

Reported: how many of the reference top-N each set hits, the median
reference count of the notes each set chose, and the overlap between the
ingested and the alphabetical set. On the reference vault after 101 notes,
a frontier picker hit 60 of the top 101 against 27 for the alphabet.

What this does NOT say: whether the finished graph differs. The probe
measures the choice, not its consequence — the consequence needs the same
vault built twice.

usage:
    python3 picker-probe.py --vault ~/Vault [--wiki wiki] [--notes Notes]
"""
import argparse, json, re, unicodedata
from pathlib import Path


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
            ver = r.stdout.strip() + ("+dirty" if m.stdout.strip() else "") + " · " + ver
    except Exception:
        pass
    return (f"# llm-wiki-measure {__version__} · {os.path.basename(f)} · {ver}\n"
            f"# {datetime.now().astimezone().strftime('%Y-%m-%d %H:%M %z')}")


def nfc(s):
    return unicodedata.normalize("NFC", s.strip())


def median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--vault", required=True, type=Path)
    ap.add_argument("--wiki", default="wiki", help="wiki folder name")
    ap.add_argument("--notes", default=None,
                    help="notes folder; default: every .md outside the wiki folder")
    ap.add_argument("--sources-folder", default="sources",
                    help="wiki subfolder of the per-note source pages (default: sources)")
    ap.add_argument("--source-field", default="source_file",
                    help="frontmatter field on a source page naming the note it came from (default: source_file)")
    ap.add_argument("--json", type=Path, default=None)
    a = ap.parse_args()

    roots = [a.vault / a.notes] if a.notes else [a.vault]
    notes = {}
    for root in roots:
        for f in root.rglob("*.md"):
            rel = f.relative_to(a.vault)
            if rel.parts and (rel.parts[0] == a.wiki or rel.parts[0].startswith(".")):
                continue
            notes[nfc(f.stem)] = f
    titles = sorted(notes)

    picked = set()
    field_re = re.compile(r'^' + re.escape(a.source_field) + r':\s*"?\[\[(?:[^\]|/]+/)?([^\]|]+?)(?:\.md)?\]\]"?', re.M)
    for f in (a.vault / a.wiki / a.sources_folder).glob("*.md"):
        t = f.read_text(encoding="utf-8", errors="ignore")
        m = field_re.search(t)
        if m and nfc(m.group(1)) in notes:
            picked.add(nfc(m.group(1)))
    n = len(picked)
    if not n:
        print(stamp())
        print("no source page names a note — nothing ingested, or the source field has another shape")
        return

    text = "\n".join(p.read_text(encoding="utf-8", errors="ignore") for p in notes.values())
    refs = {t: len(re.findall(r"\[\[" + re.escape(t) + r"[\]|#]", text)) for t in titles}
    alpha = set(titles[:n])
    top = set(sorted(titles, key=lambda t: -refs[t])[:n])

    print(stamp())
    print(f"notes {len(titles)}, ingested {n}, alphabetical set ends at '{titles[n - 1]}'")
    print(f"hits in the reference top-{n}: ingested {len(picked & top)}, alphabetical {len(alpha & top)}")
    print(f"median references per chosen note: ingested {median(refs[t] for t in picked)}, "
          f"alphabetical {median(refs[t] for t in alpha)}, all notes {median(refs.values())}")
    print(f"overlap ingested ∩ alphabetical: {len(picked & alpha)}")
    unlinked = sum(1 for v in refs.values() if v == 0)
    print(f"notes no other note links to: {unlinked} = {100 * unlinked / len(titles):.0f} %")
    if a.json:
        a.json.write_text(json.dumps({
            "notes": len(titles), "ingested": n,
            "top_hits_ingested": len(picked & top), "top_hits_alphabetical": len(alpha & top),
            "median_refs_ingested": median(refs[t] for t in picked),
            "median_refs_alphabetical": median(refs[t] for t in alpha),
            "overlap": len(picked & alpha), "unlinked_notes": unlinked,
        }, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
