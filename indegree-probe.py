#!/usr/bin/env python3
"""
indegree-probe.py — who draws the links, and would they still if the
siblings were taken away?

Read-only. No LLM, no network, no plugin. Runs against any llm-wiki vault.

Counts incoming links between entity and concept pages (one edge per
ordered page pair, links to source pages and self-links excluded; a
folder-qualified link resolves only if that path exists, as in Obsidian, a
bare name resolves by basename or alias, case-folded) and reports
the concentration: the top page, the share the top 5 / top 10 hold, the
pages nobody links to, and a Gini coefficient over the in-degrees.

Then it does the same over a subset: edges between pages that share NO source
in their provenance frontmatter (`sources:` by default, --provenance-field).
Folder names are parameters too (--page-folders, --sources-folder), so any
compiled wiki that records where a page came from can be measured. The plugin (and the deterministic related
lists since v1.27.1) writes links between the pages born from the same note —
siblings. Those edges are real, but they are a function of the ingest, not
of the model's judgement about relatedness across notes. On the reference
vault they were 94–98 % of all edges, and they made every hub look four times
as strong as it is: the peak in-degree went from 172 to 39 when a sibling cap
was introduced, while the cross-source graph did not change at all.

Read the second block as the graph. Read the difference between the blocks as
the sibling rule.

usage:
    python3 indegree-probe.py --vault ~/Vault [--wiki wiki] [--top 10]
"""
import argparse, json, re, unicodedata
from collections import Counter
from pathlib import Path

__version__ = "0.3.1"
LINK = re.compile(r"\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")


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


def fold(s):
    return nfc(s).lower().replace("-", " ").replace("_", " ")


def aliases(fm):
    out = []
    mb = re.search(r"^aliases:\s*\n((?:\s*-\s*.*\n?)+)", fm, re.M)
    if mb:
        out += [re.sub(r"^\s*-\s*", "", l).strip("\"' ") for l in mb.group(1).splitlines() if l.strip()]
    mi = re.search(r"^aliases:\s*\[(.*)\]", fm, re.M)
    if mi:
        out += [x.strip("\"' ") for x in mi.group(1).split(",") if x.strip()]
    return out


def split(text):
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    return (m.group(1), m.group(2)) if m else ("", text)


def gini(values):
    sv = sorted(values)
    n, total = len(sv), sum(sv)
    if not n or not total:
        return 0.0
    return 2 * sum((i + 1) * v for i, v in enumerate(sv)) / (n * total) - (n + 1) / n


def block(label, pages, edges, top):
    indeg = Counter(t for _, t in edges)
    vals = sorted((indeg[p] for p in pages), reverse=True)
    live = len(edges)
    zero = sum(1 for v in vals if v == 0)
    print(f"{label}: edges {live}, peak in-degree {vals[0] if vals else 0}, "
          f"top5 {100 * sum(vals[:5]) / max(live, 1):.0f} %, top10 {100 * sum(vals[:10]) / max(live, 1):.0f} %, "
          f"no incoming {zero} = {100 * zero / max(len(pages), 1):.0f} %, gini {gini(vals):.2f}")
    print("  top:", ", ".join(f"{p.split('/', 1)[1]} {indeg[p]}"
                             for p in sorted(pages, key=lambda p: -indeg[p])[:top]))
    return {"edges": live, "peak": vals[0] if vals else 0, "no_incoming": zero, "gini": round(gini(vals), 3),
            "top": [(p, indeg[p]) for p in sorted(pages, key=lambda p: -indeg[p])[:top]]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--vault", required=True, type=Path)
    ap.add_argument("--wiki", default="wiki", help="wiki folder name")
    ap.add_argument("--page-folders", default="entities,concepts",
                    help="comma-separated wiki subfolders that hold the pages (default: entities,concepts)")
    ap.add_argument("--sources-folder", default="sources",
                    help="wiki subfolder of the per-note source pages; links there are not edges (default: sources)")
    ap.add_argument("--provenance-field", default="sources",
                    help="frontmatter field listing the source pages a page was built from (default: sources)")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--json", type=Path, default=None)
    a = ap.parse_args()
    wiki = a.vault / a.wiki

    pages, sources, bodies, by_name = {}, {}, {}, {}
    prov_re = re.compile(r"^" + re.escape(a.provenance_field) + r":\s*(?:\[(.*)\]|\n((?:\s*-\s*.*\n?)+))", re.M)
    src_prefix = a.sources_folder + "/"
    for folder in [x.strip() for x in a.page_folders.split(",") if x.strip()]:
        d = wiki / folder
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.md")):
            key = folder + "/" + nfc(f.stem)
            fm, body = split(f.read_text(encoding="utf-8", errors="ignore"))
            pages[key] = f
            bodies[key] = body
            pm = prov_re.search(fm)
            prov_text = (pm.group(1) or pm.group(2) or "") if pm else ""
            sources[key] = {nfc(m.group(1)).split("/")[-1] for m in LINK.finditer(prov_text)}
            by_name.setdefault(fold(f.stem), key)
            for al in aliases(fm):
                by_name.setdefault(fold(al), key)

    def resolve(target):
        target = nfc(target)
        if "/" in target:
            folder, slug = target.split("/", 1)
            return folder + "/" + nfc(slug) if folder + "/" + nfc(slug) in pages else None
        return by_name.get(fold(target))

    all_edges, cross_edges = [], []
    for k, body in bodies.items():
        seen = set()
        for m in LINK.finditer(body):
            if m.group(1).startswith(src_prefix):
                continue
            t = resolve(m.group(1))
            if not t or t == k or t in seen:
                continue
            seen.add(t)
            all_edges.append((k, t))
            if not (sources[k] & sources[t]):
                cross_edges.append((k, t))

    print(stamp())
    print(f"pages {len(pages)}")
    out = {"pages": len(pages)}
    out["all"] = block("all edges", pages, all_edges, a.top)
    out["cross_source"] = block("edges between pages sharing no source", pages, cross_edges, a.top)
    sib = len(all_edges) - len(cross_edges)
    print(f"sibling edges (a source in common): {sib} = {100 * sib / max(len(all_edges), 1):.0f} % of all")
    out["sibling_edges"] = sib
    if a.json:
        a.json.write_text(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
