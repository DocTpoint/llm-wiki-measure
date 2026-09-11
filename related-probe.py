#!/usr/bin/env python3
"""
related-probe.py — how long do the Related lists get, and does a cap hold?

Read-only. No LLM, no network, no plugin. Runs against any llm-wiki vault.

The plugin's Related sections are a union: every merge keeps what the page
already lists and adds the new names, and nothing removes an entry. So the
length of a page's Related list is a function of how many notes have touched
the page. This probe draws that curve — mean, median and full distribution of
Related entries per page, bucketed by the number of source pages in the
page's provenance field — and reports, per bucket, the share of pages at or
above a cap. That share is where a cap would bite; on an uncapped vault it
says which pages a cap would change, on a capped vault it says where the
curve is censored and can no longer be read.

Two acceptance checks ride along for a vault built with a ranked cap:

  cap    no section holds more than --cap entries, counted separately for
         bare lines (`- [[Target]]`) and lines with text after the link,
         because a recompute normally rewrites only the bare ones;
  order  within a section, bare entries stand by shared sources descending
         (sources shared between the page and the target, from the
         provenance field; a target that does not exist yet counts as born
         from the current note, shared = 1). Reported against the share of
         sections that happen to be alphabetical, by list length, so a
         rank that is merely incidental shows up as such.

Reading the curve: on the reference vault (413 notes, 2,095 pages, no cap)
the mean rose linearly with the source count, about two entries per source,
to 18.4 entries at eight or more sources with a maximum of 73. Under a cap of
five the same vault shape sits at 5.0 from four sources up, and the share at
the cap — 80 % at four sources, 100 % at eight — is the only thing left to
read there.

usage:
    python3 related-probe.py --vault ~/Vault [--wiki wiki] [--cap 5]
        [--sections "Related Concepts,Related Entities"]
        [--page-folders entities,concepts] [--sources-folder sources]
        [--provenance-field sources] [--json out.json]
"""
import argparse, json, math, re, statistics, unicodedata
from collections import Counter, defaultdict
from pathlib import Path

__version__ = "0.7.0"
LINK = re.compile(r"\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")
BARE = re.compile(r"- \[\[[^\]]+\]\]")


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


def section(body, name):
    m = re.search(r"^## " + re.escape(name) + r"\s*\n(.*?)(?=^## |\Z)", body, re.S | re.M)
    return m.group(1) if m else None


def bucket(n_sources):
    return n_sources if n_sources <= 4 else (5 if n_sources <= 7 else 8)


LABEL = {0: "0", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5-7", 8: ">=8"}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--vault", required=True, type=Path)
    ap.add_argument("--wiki", default="wiki", help="wiki folder name")
    ap.add_argument("--sections", default="Related Concepts,Related Entities",
                    help="comma-separated `## ` headings of the Related sections, in the vault's wiki language")
    ap.add_argument("--cap", type=int, default=5, help="entries per section the cap check and the share column use")
    ap.add_argument("--page-folders", default="entities,concepts",
                    help="comma-separated wiki subfolders that hold the pages (default: entities,concepts)")
    ap.add_argument("--sources-folder", default="sources",
                    help="wiki subfolder of the per-note source pages (default: sources)")
    ap.add_argument("--provenance-field", default="sources",
                    help="frontmatter field listing the source pages a page was built from (default: sources)")
    ap.add_argument("--json", type=Path, default=None)
    a = ap.parse_args()
    wiki = a.vault / a.wiki
    sections = [s.strip() for s in a.sections.split(",") if s.strip()]
    folders = [x.strip() for x in a.page_folders.split(",") if x.strip()]
    prov_re = re.compile(r"^" + re.escape(a.provenance_field) + r":\s*(?:\[(.*)\]|\n((?:\s*-\s*.*\n?)+))", re.M)

    print(stamp())
    print(f"# vault {a.vault} · wiki {a.wiki} · pages {a.page_folders} · sections {sections} · cap {a.cap}")

    pages, prov, mtime, by_name = {}, {}, {}, {}
    for folder in folders + [a.sources_folder]:
        d = wiki / folder
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.md")):
            key = folder + "/" + nfc(f.stem)
            fm, body = split(f.read_text(encoding="utf-8", errors="ignore"))
            pages[key] = body
            mtime[key] = f.stat().st_mtime
            by_name.setdefault(fold(f.stem), key)
            for al in aliases(fm):
                by_name.setdefault(fold(al), key)
            pm = prov_re.search(fm)
            items = []
            if pm:
                raw = pm.group(1) if pm.group(1) is not None else pm.group(2)
                items = [x for x in re.split(r",|\n", raw) if x.strip()] if pm.group(1) is not None \
                    else [re.sub(r"^\s*-\s*", "", l) for l in raw.splitlines() if l.strip()]
            prov[key] = {fold(re.sub(r"^\[\[|\]\]$", "", x.strip().strip("\"' ")).split("/")[-1]) for x in items}

    def resolve(target):
        t = nfc(target)
        if "/" in t:
            fo, sl = t.split("/", 1)
            if fo in folders or fo == a.sources_folder:
                k = fo + "/" + nfc(sl)
                return k if k in pages else None
        return by_name.get(fold(t))

    ec = [k for k in pages if not k.startswith(a.sources_folder + "/")]

    # ---- sections ------------------------------------------------------
    sekt = []  # (page, heading, [(resolved, bare, title)])
    for k in ec:
        for s in sections:
            b = section(pages[k], s)
            if b is None:
                continue
            entries = []
            for line in b.splitlines():
                if not line.startswith("- [["):
                    continue
                m = LINK.search(line)
                if not m:
                    continue
                entries.append((resolve(m.group(1)), bool(BARE.fullmatch(line.strip())),
                                nfc(m.group(1).split("/")[-1])))
            if entries:
                sekt.append((k, s, entries))
    print(f"pages {len(ec)}, source pages {len(pages) - len(ec)}, Related sections {len(sekt)}")

    # ---- 1 cap ---------------------------------------------------------
    over = [(k, s, len(e), sum(1 for x in e if x[1])) for k, s, e in sekt if len(e) > a.cap]
    over_bare = [x for x in over if x[3] > a.cap]
    with_text = sum(1 for _, _, e in sekt for x in e if not x[1])
    print(f"\ncap {a.cap}: sections over {len(over)}, of which over in bare lines {len(over_bare)}, "
          f"lines with text after the link {with_text}")

    # ---- 2 order -------------------------------------------------------
    def shared(page, target):
        if target and target in prov:
            return len(prov[page] & prov[target])
        return 1
    ok, viol, alpha, length = 0, [], Counter(), Counter()
    for k, s, e in sekt:
        seq = [(shared(k, z), ti, z) for z, bare, ti in e if bare]
        if len(seq) < 2:
            continue
        n = min(len(seq), 6)
        length[n] += 1
        if [x[1] for x in seq] == sorted(x[1] for x in seq):
            alpha[n] += 1
        sh = [x[0] for x in seq]
        if sh == sorted(sh, reverse=True):
            ok += 1
        else:
            viol.append((k, s, seq))
    later = sum(1 for k, s, seq in viol if any(z and z in mtime and mtime[z] > mtime[k] + 1 for _, _, z in seq))
    n_sek = ok + len(viol)
    print(f"order: sections with >= 2 bare entries {n_sek}, shared sources descending {ok} = "
          f"{100 * ok / max(n_sek, 1):.0f} %, violated {len(viol)} (of which with a target written after the page {later})")
    print(f"  {'length':>6} | {'alphabetical':>12} | {'by chance':>9}")
    for n in sorted(length):
        z = 100 / math.factorial(n) if n < 6 else 0.1
        print(f"  {(str(n) if n < 6 else '>=6'):>6} | {alpha[n]:>4}/{length[n]:<4} {100 * alpha[n] / length[n]:>3.0f} % | {z:>8.1f} %")

    # ---- 3 curve -------------------------------------------------------
    per_page = Counter()
    for k, _, e in sekt:
        per_page[k] += len(e)
    dist = defaultdict(Counter)
    for k in ec:
        dist[bucket(len(prov.get(k, ())))][per_page[k]] += 1
    print(f"\ncurve: Related entries per page by source count (share at >= {a.cap} is where a cap bites, or censors)")
    print(f"  {'sources':>7} | {'pages':>5} | {'mean':>5} | {'median':>6} | {'max':>3} | {'>= cap':>7} | distribution")
    out = {}
    for b in sorted(dist):
        c = dist[b]
        vals = [v for v, n in c.items() for _ in range(n)]
        at = sum(n for v, n in c.items() if v >= a.cap)
        print(f"  {LABEL[b]:>7} | {len(vals):>5} | {statistics.mean(vals):>5.1f} | {statistics.median(vals):>6.0f} | "
              f"{max(vals):>3} | {100 * at / len(vals):>5.0f} % | " + " ".join(f"{v}:{c[v]}" for v in sorted(c)))
        out[LABEL[b]] = {"pages": len(vals), "mean": round(statistics.mean(vals), 2),
                         "median": statistics.median(vals), "max": max(vals),
                         "at_cap_share": round(at / len(vals), 3), "distribution": dict(sorted(c.items()))}

    if a.json:
        a.json.write_text(json.dumps({"version": __version__, "cap": a.cap, "pages": len(ec),
                                      "sections": len(sekt), "over_cap": len(over),
                                      "order_kept": ok, "order_sections": n_sek, "curve": out},
                                     ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
