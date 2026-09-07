#!/usr/bin/env python3
"""
graph-yield.py — what does the graph add over full-text search and embeddings?

Read-only. Works on any llm-wiki vault. Needs numpy and an OpenAI-compatible
embedding endpoint (LM Studio, Ollama, or a hosted one).

Three encodings of the same corpus are compared:

  A  graph        edges from the Related sections of the wiki pages
  B  full text    two pages occur literally in the same note (word boundaries,
                  case sensitive, URLs stripped) — no model involved
  C  embeddings   cosine kNN over each page's PROSE. The Related link lists are
                  stripped BEFORE embedding; otherwise C encodes the graph and
                  then "rediscovers" it, and the comparison is circular.

Two questions are asked, in this order:

  1. How much of A is reproducible from B and C? (redundancy)
  2. Of the pairs reachable only by traversing A — two hops, no direct edge,
     invisible to B and C — how many are there, and are they any good?

Question 2 cannot be answered by counting. A graph built by randomly rewiring
A while preserving its degree sequence produces MORE such pairs than A does,
because random edges join unrelated things. The script therefore builds three
control arms at the same edge budget (PMI-ranked co-occurrence, embedding
neighbours, degree-preserving rewiring) and emits a blind rating list: equal
numbers of pairs per arm, shuffled, unlabelled, with a separate key file.
Rate it, then score it. The counts alone mean nothing.

usage:
  python3 graph-yield.py --vault ~/Vault \\
      --embed-url http://localhost:1234/v1/embeddings \\
      --embed-model text-embedding-bge-m3
"""
import argparse, json, math, random, re, sys, time, urllib.request
from collections import Counter, defaultdict
from pathlib import Path

try:
    import numpy as np
except ImportError:
    sys.exit("needs numpy:  pip install numpy")

URL_RE = re.compile(r"https?://\S+|\]\([^)]*\)|\bwww\.\S+")
LINK_RE = re.compile(r"\[\[(entities|concepts)/([^\]|#]+)")
WIKILINK = re.compile(r"\[\[[^\]|]*\|([^\]]*)\]\]|\[\[([^\]]*)\]\]")
RELATED = ("verwandte", "related", "siehe auch", "see also")
SKIP_DIRS = {".obsidian", ".trash", ".git", "node_modules", ".smart-env"}


__version__ = "0.2.1"


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


def frontmatter(t):
    m = re.match(r"^---\n(.*?)\n---", t, re.S)
    return m.group(1) if m else ""


def body(t, strip_urls=True):
    m = re.match(r"^---\n.*?\n---\n?(.*)$", t, re.S)
    b = m.group(1) if m else t
    # URLs produce phantom mentions: a citation path .../kupfer-mangan-chrom/
    # matches a page named "Chrom", and ncbi.nlm.nih.gov matches "NIH".
    return URL_RE.sub(" ", b) if strip_urls else b


def fm_list(fm, key):
    m = re.search(rf"^{key}:[ \t]*\[(.*?)\]", fm, re.M)
    if m:
        return [x.strip().strip("\"'") for x in m.group(1).split(",") if x.strip()]
    m = re.search(rf"^{key}:[ \t]*\n((?:[ \t]*-[ \t]*.+\n?)+)", fm, re.M)
    if m:
        return [re.sub(r"^[ \t]*-[ \t]*", "", l).strip().strip("\"'")
                for l in m.group(1).splitlines() if l.strip()]
    return []


def prose(t):
    """Page text WITHOUT the Related sections — see the circularity note above."""
    out, skip = [], False
    for line in body(t).splitlines():
        h = re.match(r"^(#{1,6})\s+(.*)$", line)
        if h:
            skip = h.group(2).strip().lower().startswith(RELATED)
            if not skip:
                out.append(h.group(2))
            continue
        if skip or re.match(r"^\s*[-*]\s*\[\[", line):
            continue
        out.append(WIKILINK.sub(lambda m: m.group(1) or m.group(2) or "", line))
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def mentions(needle, text):
    return needle in text and re.search(
        rf"(?<!\w){re.escape(needle)}(?!\w)", text) is not None


def embed_all(items, url, model, batch, cache):
    """items: [(slug, text)]. Appends to cache as jsonl, resumable."""
    done = {}
    if cache.exists():
        for line in cache.read_text(encoding="utf-8").splitlines():
            try:
                d = json.loads(line)
                done[d["slug"]] = d["vec"]
            except Exception:
                pass
    todo = [(s, t) for s, t in items if s not in done]
    if todo:
        print(f"embedding {len(todo)} pages ({len(done)} cached) …", flush=True)
        t0 = time.time()
        with cache.open("a", encoding="utf-8") as fh:
            for i in range(0, len(todo), batch):
                chunk = todo[i:i + batch]
                req = urllib.request.Request(
                    url, data=json.dumps({"model": model,
                                          "input": [t for _, t in chunk]}).encode(),
                    headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=600) as r:
                    d = json.load(r)
                vecs = [e["embedding"] for e in sorted(d["data"],
                                                       key=lambda x: x["index"])]
                for (s, _), v in zip(chunk, vecs):
                    done[s] = v
                    fh.write(json.dumps({"slug": s, "vec": v}) + "\n")
                fh.flush()
        print(f"  done in {time.time()-t0:.0f}s", flush=True)
    return {s: done[s] for s, _ in items if s in done}


def compositional(edges, cooc, near, hub):
    """Pairs two hops apart, no direct edge, invisible to B and C, not
    reachable only through hubs; endpoints must not be hubs either."""
    adj = defaultdict(set)
    for a, b in edges:
        adj[a].add(b)
        adj[b].add(a)
    deg = {n: len(v) for n, v in adj.items()}
    hubs = {n for n, d in deg.items() if d >= hub}
    mid = defaultdict(set)
    for b, nb in adj.items():
        nl = sorted(nb)
        for i, a in enumerate(nl):
            for c in nl[i + 1:]:
                if c not in adj[a]:
                    mid[(a, c) if a < c else (c, a)].add(b)
    keep = {p: sorted(m - hubs) for p, m in mid.items()
            if not cooc(*p) and not near(*p) and (m - hubs)
            and p[0] not in hubs and p[1] not in hubs}
    return mid, keep, deg, hubs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", required=True, type=Path)
    ap.add_argument("--wiki", default="wiki")
    ap.add_argument("--notes", default=None,
                    help="notes folder; default: every .md outside the wiki folder")
    ap.add_argument("--embed-url", default="http://localhost:1234/v1/embeddings")
    ap.add_argument("--embed-model", default="text-embedding-bge-m3")
    ap.add_argument("--embed-batch", type=int, default=32)
    ap.add_argument("--cache", type=Path, default=Path("embeddings.jsonl"))
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--hub", type=int, default=30)
    ap.add_argument("--min-alias", type=int, default=3)
    ap.add_argument("--page-folders", default="entities,concepts",
                    help="comma-separated wiki subfolders that hold the pages (default: entities,concepts)")
    ap.add_argument("--blind", type=Path, default=Path("blind-pairs.md"))
    ap.add_argument("--per-arm", type=int, default=30)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    random.seed(a.seed)

    vault = a.vault.expanduser()
    wiki = vault / a.wiki
    if not wiki.is_dir():
        sys.exit(f"no wiki folder at {wiki}")

    notes = {}
    paths = ((vault / a.notes).rglob("*.md") if a.notes
             else (p for p in vault.rglob("*.md")
                   if wiki not in p.parents
                   and not SKIP_DIRS & set(p.relative_to(vault).parts)))
    for p in sorted(paths):
        notes[p.stem] = body(p.read_text(encoding="utf-8", errors="replace"))
    pages, edges, texts = {}, set(), {}
    for sub in [x.strip() for x in a.page_folders.split(",") if x.strip()]:
        for p in sorted((wiki / sub).glob("*.md")):
            t = p.read_text(encoding="utf-8", errors="replace")
            fm = frontmatter(t)
            h1 = re.search(r"^#\s+(.+)$", body(t), re.M)
            title = h1.group(1).strip() if h1 else p.stem.replace("-", " ")
            pages[p.stem] = {
                "title": title,
                "needles": sorted({n for n in [title] + [
                    x for x in fm_list(fm, "aliases") if len(x) >= a.min_alias] if n}),
            }
            texts[p.stem] = prose(t)
            for _, tgt in LINK_RE.findall(body(t)):
                tgt = tgt.strip()
                if tgt != p.stem:
                    edges.add(tuple(sorted((p.stem, tgt))))
    edges = {(x, y) for x, y in edges if x in pages and y in pages}
    if not edges:
        sys.exit("no edges found — are the Related sections present?")
    print(stamp())
    print(f"vault {vault}\npages {len(pages)} · notes {len(notes)} · "
          f"edges {len(edges)}\n")

    hits = defaultdict(set)
    for slug, pg in pages.items():
        for stem, txt in notes.items():
            if any(mentions(n, txt) for n in pg["needles"]):
                hits[slug].add(stem)
    cooc = lambda x, y: bool(hits.get(x, set()) & hits.get(y, set()))

    vecs = embed_all([(s, texts[s] or pages[s]["title"]) for s in sorted(pages)],
                     a.embed_url, a.embed_model, a.embed_batch, a.cache)
    stems = sorted(vecs)
    M = np.asarray([vecs[s] for s in stems], dtype=np.float32)
    M /= np.linalg.norm(M, axis=1, keepdims=True) + 1e-9
    idx = {s: i for i, s in enumerate(stems)}
    S = M @ M.T
    np.fill_diagonal(S, -1.0)
    knn = [set(np.argsort(-S[i])[:a.k]) for i in range(len(stems))]
    near = lambda x, y: (x in idx and y in idx
                         and (idx[y] in knn[idx[x]] or idx[x] in knn[idx[y]]))
    print(f"embedded {len(stems)}/{len(pages)} pages "
          f"({len(stems)/len(pages):.0%})\n")

    usable = [e for e in sorted(edges) if e[0] in idx and e[1] in idx]
    co = sum(cooc(*e) for e in usable)
    nk = sum(near(*e) for e in usable)
    both = sum(1 for e in usable if cooc(*e) and near(*e))
    neither = sum(1 for e in usable if not cooc(*e) and not near(*e))
    rnd = [(random.choice(stems), random.choice(stems)) for _ in range(30000)]
    rnd = [(x, y) for x, y in rnd if x != y]
    print("EDGE LEVEL — how much of the graph do the cheap layers reproduce?")
    print(f"  B co-occurrence   {co:>6} ({co/len(usable):>5.1%})   "
          f"random pairs {sum(cooc(*e) for e in rnd)/len(rnd):>5.2%}")
    print(f"  C kNN k={a.k:<3}       {nk:>6} ({nk/len(usable):>5.1%})   "
          f"random pairs {sum(near(*e) for e in rnd)/len(rnd):>5.2%}")
    print(f"  both              {both:>6} ({both/len(usable):>5.1%})")
    print(f"  NEITHER           {neither:>6} ({neither/len(usable):>5.1%})"
          "   <- the graph's own share\n")

    budget = len(edges)
    per_note = defaultdict(set)
    for slug, ns in hits.items():
        for n in ns:
            per_note[n].add(slug)
    pair_n, page_n = Counter(), Counter()
    for n, ps in per_note.items():
        pl = sorted(ps)
        for x in pl:
            page_n[x] += 1
        for i, x in enumerate(pl):
            for y in pl[i + 1:]:
                pair_n[(x, y)] += 1
    N = max(1, len(per_note))
    pmi = {e: math.log((c / N) / ((page_n[e[0]] / N) * (page_n[e[1]] / N)))
           for e, c in pair_n.items()}
    armB = set(sorted(pmi, key=lambda e: (-pmi[e], -pair_n[e]))[:budget])
    tri = np.triu_indices(len(stems), k=1)
    top = np.argpartition(-S[tri], min(budget, len(tri[0]) - 1))[:budget]
    armC = {tuple(sorted((stems[tri[0][t]], stems[tri[1][t]]))) for t in top}
    Z = [list(e) for e in edges]
    eset = {tuple(sorted(e)) for e in Z}
    for _ in range(10 * len(Z)):
        i, j = random.randrange(len(Z)), random.randrange(len(Z))
        (x, y), (u, v) = Z[i], Z[j]
        if len({x, y, u, v}) < 4:
            continue
        n1, n2 = tuple(sorted((x, v))), tuple(sorted((u, y)))
        if n1 in eset or n2 in eset:
            continue
        eset.discard(tuple(sorted((x, y))))
        eset.discard(tuple(sorted((u, v))))
        Z[i], Z[j] = [x, v], [u, y]
        eset |= {n1, n2}
    arms = {"A graph": edges, "B co-occurrence": armB,
            "C embedding": armC, "0 rewired": eset}

    print(f"COMPOSITION — control arms at the same edge budget ({budget})")
    print("  a pair counts if it is two hops apart, has no direct edge, and is")
    print("  invisible to B and C; hub-only paths and hub endpoints excluded\n")
    keeps = {}
    for name, E in arms.items():
        mid, keep, deg, hubs = compositional(E, cooc, near, a.hub)
        keeps[name] = keep
        ds = sorted(deg.values()) or [0]
        print(f"  {name:<17} two-hop {len(mid):>7} · compositional {len(keep):>7}"
              f" · hubs {len(hubs):>3} · median degree {ds[len(ds)//2]}")
    print("\n  Note the ordering: if the rewired graph is at or near the top,")
    print("  that is the point — the count measures dissimilarity, not insight.")
    print("  Only the blind rating below separates the arms.\n")

    lines, key = [], []
    for name, keep in keeps.items():
        if not keep:
            continue
        for pair in random.sample(sorted(keep), min(a.per_arm, len(keep))):
            lines.append((pair, keep[pair][:2]))
            key.append(name)
    order = list(range(len(lines)))
    random.shuffle(order)
    a.blind.write_text(
        "# Blind rating — does the connection carry?\n\n"
        "Each line: two pages and the node connecting them. Mark **y**, **n** "
        "or **?**.\nWhich arm produced a line is deliberately not shown.\n\n" +
        "\n".join(f"{i+1:>3}. {lines[order[i]][0][0]} —[{', '.join(lines[order[i]][1])}]— "
                  f"{lines[order[i]][0][1]}   ___" for i in range(len(order))) + "\n",
        encoding="utf-8")
    keyfile = a.blind.with_name(a.blind.stem + "-key.json")
    keyfile.write_text(json.dumps(
        [{"nr": i + 1, "arm": key[order[i]]} for i in range(len(order))], indent=1))
    print(f"blind list: {len(order)} pairs -> {a.blind}   key -> {keyfile}")
    print("score it with:  python3 score-blind.py --ratings my.txt "
          f"--key {keyfile}")


if __name__ == "__main__":
    main()
