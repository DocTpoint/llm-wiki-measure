#!/usr/bin/env python3
"""
rebuild-probe.py — is the graph a graph, or a pile of pages with dead pointers?

Read-only. No LLM, no network, no plugin. Runs against any llm-wiki vault.

Four counts over the entity and concept pages, all from the page bodies:

  strays        pages with no live outgoing link at all (link to a source page
                or to a note does not count — those are the star the page was
                born in, not a relation to another wiki page).
  dead links    `[[...]]` targets that resolve to no page, split into the
                prose above the Related sections and the Related sections
                themselves. Related is the list the plugin writes on purpose;
                prose is what the model wrote while summarising.
  ghost targets distinct dead targets, and how many of them are the title or
                alias of a note that simply has not been ingested yet — that
                subset is a frontier, not an error.
  birth         optional, needs `<wiki>/schema/paragraph-ledger.json` from the
                paragraph-ledger patch (not upstream): of the pages that have
                a note of their own, how many were created while ingesting
                that note, and how many as a by-product of another note.

Why these four: a rebuild that reorders or re-gates the ingest changes them
first. The July rebuild of the reference vault had 30 % strays; the frontier-
picked rebuild has 1 %. The dead-link split says whether a fix at the write
gate (Related) or in the prompt (prose) is the one that would move the number.

Folder names and the provenance field are the plugin's defaults and can be
changed (--page-folders, --sources-folder), so any vault that keeps typed
page folders plus one folder of per-note source pages can be measured.
Resolution follows the plugin: a target resolves if its folder-qualified path
exists, or if its bare name (case-folded, `-`/`_` treated as space) matches a
page basename or alias. Section titles are matched against every language the
plugin ships; pass --related / --mentions to override.

usage:
    python3 rebuild-probe.py --vault ~/Vault [--wiki wiki] [--notes Notes] [-v]
"""
import argparse, json, os, re, sys, unicodedata
from collections import Counter, defaultdict
from pathlib import Path

RELATED_TITLES = [
    'Related Concepts', 'Related Entities', 'Verwandte Konzepte', 'Verwandte Entitäten',
    'Concepts associés', 'Entités associées', 'Conceptos relacionados', 'Entidades relacionadas',
    'Conceitos relacionados', 'Concetti correlati', 'Entità correlate',
    'Связанные концепции', 'Связанные сущности', '相关概念', '相关实体', '相關概念', '相關實體',
    '関連概念', '関連エンティティ', '관련 개념', '관련 엔티티',
]
MENTIONS_TITLES = [
    'Mentions in Source', 'Erwähnungen in der Quelle', 'Mentions dans la source',
    'Menciones en la fuente', 'Menções na fonte', 'Menzioni nella sorgente',
    'Упоминания в источнике', 'ソースでの言及', '來源提及', '来源提及', '출처 언급',
]
__version__ = "0.4.0"
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


def frontmatter(text):
    m = re.match(r"^---\n(.*?)\n---", text, re.S)
    return m.group(1) if m else ""


def aliases(text):
    fm = frontmatter(text)
    out = []
    mb = re.search(r"^aliases:\s*\n((?:\s*-\s*.*\n?)+)", fm, re.M)
    if mb:
        out += [re.sub(r"^\s*-\s*", "", l).strip("\"' ") for l in mb.group(1).splitlines() if l.strip()]
    mi = re.search(r"^aliases:\s*\[(.*)\]", fm, re.M)
    if mi:
        out += [x.strip("\"' ") for x in mi.group(1).split(",") if x.strip()]
    return out


def body(text):
    return re.sub(r"^---\n.*?\n---\n", "", text, count=1, flags=re.S)


def cut_before(text, titles):
    """Body up to the first `## <title>` from the list."""
    alt = "|".join(re.escape(t) for t in titles)
    return re.split(r"^## (?:" + alt + r")\s*$", text, maxsplit=1, flags=re.M)[0]


def sections(text, titles):
    alt = "|".join(re.escape(t) for t in titles)
    return [m.group(1) for m in re.finditer(
        r"^## (?:" + alt + r")\s*\n(.*?)(?=^## |\Z)", text, re.S | re.M)]


def note_files(vault, wiki, notes_dir):
    """Every note file: under --notes if given, else every .md outside the wiki.

    Symlinked folders are walked. A vault that keeps its notes behind a
    symlink used to yield nothing here, and an empty note set is not
    distinguishable in the output from a vault that has no notes -- it turns
    the frontier and birth counts silently into zeros.
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
        dirnames[:] = [d for d in dirnames if not d.startswith(".")
                       and not (skip_wiki and Path(dirpath) == root and d == wiki)]
        for fn in sorted(filenames):
            if fn.endswith(".md"):
                yield Path(dirpath) / fn


def load_notes(vault, wiki, notes_dir):
    """fold(title or alias) -> title, for every note outside the wiki."""
    notes = {}
    for f in note_files(vault, wiki, notes_dir):
        title = nfc(f.stem)
        notes[fold(title)] = title
        try:
            for a in aliases(f.read_text(encoding="utf-8", errors="ignore")):
                notes[fold(a)] = title
        except OSError:
            pass
    return notes


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--vault", required=True, type=Path)
    ap.add_argument("--wiki", default="wiki", help="wiki folder name")
    ap.add_argument("--notes", default=None,
                    help="notes folder; default: every .md outside the wiki folder")
    ap.add_argument("--page-folders", default="entities,concepts",
                    help="comma-separated wiki subfolders that hold the pages (default: entities,concepts)")
    ap.add_argument("--sources-folder", default="sources",
                    help="wiki subfolder that holds the per-note source pages (default: sources)")
    ap.add_argument("--related", action="append", default=None,
                    help="Related section title (repeatable); default: every plugin language")
    ap.add_argument("--mentions", action="append", default=None,
                    help="Mentions section title (repeatable); default: every plugin language")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--json", type=Path, default=None)
    a = ap.parse_args()
    related_titles = a.related or RELATED_TITLES
    mentions_titles = a.mentions or MENTIONS_TITLES
    wiki = a.vault / a.wiki
    page_folders = [x.strip() for x in a.page_folders.split(",") if x.strip()]
    FOLDERS = tuple(page_folders) + (a.sources_folder,)

    pages, names = {}, {}
    for folder in FOLDERS:
        d = wiki / folder
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.md")):
            key = folder + "/" + nfc(f.stem)
            t = f.read_text(encoding="utf-8", errors="ignore")
            pages[key] = t
            names.setdefault(fold(f.stem), key)
            for al in aliases(t):
                names.setdefault(fold(al), key)
    notes = load_notes(a.vault, a.wiki, a.notes)
    note_prefix = (a.notes.rstrip("/") + "/") if a.notes else None

    def resolve(target):
        target = nfc(target)
        if note_prefix and target.startswith(note_prefix):
            return "note" if fold(target[len(note_prefix):]) in notes else None
        if "/" in target:
            folder, slug = target.split("/", 1)
            if folder in FOLDERS:
                return folder + "/" + nfc(slug) if folder + "/" + nfc(slug) in pages else None
        return names.get(fold(target))

    ec = {k: v for k, v in pages.items() if not k.startswith(a.sources_folder + "/")}
    strays, ghosts = [], Counter()
    total_links = prose_dead = rel_total = rel_dead = rel_dead_note = 0
    rel_dead_targets = Counter()
    for k, t in ec.items():
        b = cut_before(body(t), mentions_titles)
        live = False
        for m in LINK.finditer(b):
            total_links += 1
            r = resolve(m.group(1))
            if r and r != "note":
                live = True
            if not r:
                ghosts[nfc(m.group(1))] += 1
        if not live:
            strays.append(k)
        for s in sections(t, related_titles):
            for m in LINK.finditer(s):
                rel_total += 1
                if not resolve(m.group(1)):
                    rel_dead += 1
                    tgt = nfc(m.group(1)).split("/")[-1]
                    rel_dead_targets[tgt] += 1
                    if fold(tgt) in notes:
                        rel_dead_note += 1
        for m in LINK.finditer(cut_before(b, related_titles)):
            if not resolve(m.group(1)):
                prose_dead += 1

    # optional: birth from the paragraph ledger (local patch, not upstream)
    birth, own, foreign, foreign_list = {}, 0, 0, []
    ledger = wiki / "schema" / "paragraph-ledger.json"
    if ledger.exists():
        L = json.loads(ledger.read_text(encoding="utf-8")).get("pages", {})
        for p, paras in L.items():
            srcs = [x.get("source") for x in paras if x.get("route") == "createNewPage" and x.get("source")]
            if srcs:
                birth[re.sub(r"^" + re.escape(a.wiki) + "/", "", p)[:-3]] = Path(srcs[0]).stem
        for k in ec:
            slug = k.split("/", 1)[1]
            if fold(slug) in notes and k in birth:
                bn = birth[k]
                if fold(bn) == fold(slug) or notes.get(fold(slug)) == bn:
                    own += 1
                else:
                    foreign += 1
                    foreign_list.append((slug, bn))

    n = len(ec)
    ghost_notes = sum(1 for g in ghosts if fold(g.split("/")[-1]) in notes)
    print(stamp())
    per_folder = ", ".join(f"{pf} {sum(1 for k in ec if k.startswith(pf + '/'))}" for pf in page_folders)
    print(f"pages {n} ({per_folder}), source pages {len(pages) - n}, notes {len(set(notes.values()))}")
    print(f"links in body (mentions excluded) {total_links}; dead: prose {prose_dead}, related {rel_dead}")
    print(f"strays (no live outgoing link) {len(strays)} = {100 * len(strays) / max(n, 1):.0f} %")
    print(f"related {rel_dead}/{rel_total} dead = {100 * rel_dead / max(rel_total, 1):.0f} %; "
          f"of those a note title/alias {rel_dead_note}")
    print(f"ghost targets (distinct dead) {len(ghosts)}; of those a note title/alias {ghost_notes} (frontier, not error)")
    if birth:
        print(f"birth from own note {own} / {own + foreign} = {100 * own / max(own + foreign, 1):.0f} % (ledger)")
    else:
        print("birth: no paragraph ledger found — skipped")
    if a.verbose:
        print("\nstrays:", strays[:30])
        print("\ndead related targets:", rel_dead_targets.most_common(40))
        print("\nghost targets:", ghosts.most_common(40))
        if birth:
            print("\nborn from another note:", foreign_list[:30])
    if a.json:
        a.json.write_text(json.dumps({
            "pages": n, "source_pages": len(pages) - n, "links": total_links,
            "dead_prose": prose_dead, "dead_related": rel_dead, "related_total": rel_total,
            "strays": len(strays), "ghost_targets": len(ghosts), "ghost_note_titles": ghost_notes,
            "birth_own": own, "birth_foreign": foreign,
        }, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
