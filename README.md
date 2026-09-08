# llm-wiki-measure

Small, read-only measuring tools for a knowledge vault that was compiled
from your notes by an LLM — built for
[obsidian-llm-wiki](https://github.com/GD4AI/obsidian-llm-wiki), usable on
any vault that keeps the same shape.

If you have ever looked at the graph view of such a vault and wondered
*"is this actually good, or does it just look busy?"*, this repository is
for you. The plugin can tell you how many pages it wrote. It cannot tell
you how much of your notes made it into the graph, whether the links it
drew are ones a search would have found anyway, or whether the impressive
hubs in the middle of the graph are real or an artifact of how the pages
were born. These scripts answer those questions, with numbers you can
reproduce.

Nothing here writes to your vault. Nothing talks to the network, except
the one script that needs an embedding model, and that only talks to the
endpoint you give it. Python 3.9 or newer is all you need; `numpy` for the
embedding comparison.

---

## Contents

- [The vault shape the probes expect](#the-vault-shape-the-probes-expect)
- [Quick start](#quick-start)
- [The provenance line — please keep it with the number](#the-provenance-line)
- [The probes, one by one](#the-probes-one-by-one)
  - [rebuild-probe — is the graph a graph?](#rebuild-probe)
  - [indegree-probe — who draws the links?](#indegree-probe)
  - [picker-probe — did the ingest order choose well?](#picker-probe)
  - [coverage-probe — how much of the notes reached the graph?](#coverage-probe)
  - [graph-yield — what does the graph add over search and embeddings?](#graph-yield)
  - [forced-choice — is that a tie, or a blunt instrument?](#forced-choice)
  - [designator-span — which names are claimed twice?](#designator-span)
- [Four ways to fool yourself](#four-ways-to-fool-yourself-all-of-which-happened-here)
- [A worked example](#a-worked-example)
- [Probes that run inside the plugin](#probes-that-run-inside-the-plugin)
- [Limits, versioning, licence](#limits)

---

## The vault shape the probes expect

```
MyVault/
  Notes/                 your own notes, one .md per topic (any folder name)
  wiki/
    entities/            one page per thing   (people, substances, organs …)
    concepts/            one page per idea    (mechanisms, hypotheses …)
    sources/             one page per ingested note, with `source_file:`
```

Pages link to each other with `[[wikilinks]]`, carry `aliases:` in their
frontmatter, list the notes they were built from under `sources:`, and end
with one or two *Related* sections the plugin writes as bullet lists.

That is the plugin's default layout. **All folder and field names are
parameters.** If your wiki keeps typed page folders, one folder of per-note
source pages and a provenance field, you can point the probes at it:

| parameter | default | meaning |
|---|---|---|
| `--wiki` | `wiki` | the wiki folder inside the vault |
| `--notes` | *(every `.md` outside the wiki)* | the folder your notes live in — set it, see below (not used by `indegree-probe`, which reads pages only) |
| `--page-folders` | `entities,concepts` | wiki subfolders that hold pages |
| `--sources-folder` | `sources` | wiki subfolder of the per-note source pages |
| `--provenance-field` | `sources` | frontmatter field listing where a page came from (indegree, coverage) |
| `--source-field` | `source_file` | frontmatter field on a source page naming its note (picker) |
| `--related`, `--mentions` | *(every plugin language)* | section titles, repeatable (rebuild) |

`--page-folders` is understood by every probe that reads pages (`designator-span`
also accepts it under its older name `--folders`); `score-blind` reads no vault.

Do set `--notes` when your notes live in one folder. Without it, every
markdown file outside the wiki counts as a note — working documents,
templates, a README — and the picker's reference ranking drifts by a few
points.

---

## Quick start

```bash
git clone https://github.com/GD4AI/llm-wiki-measure
cd llm-wiki-measure

# the three rebuild probes: seconds, no dependencies
python3 rebuild-probe.py  --vault ~/MyVault --notes Notes
python3 indegree-probe.py --vault ~/MyVault
python3 picker-probe.py   --vault ~/MyVault --notes Notes

# coverage of your notes: seconds, no dependencies
python3 coverage-probe.py --vault ~/MyVault --notes Notes

# names claimed by both page types: seconds; --verify needs no vault
python3 designator-span.py --verify
python3 designator-span.py --vault ~/MyVault --expect SOME-NAME-YOU-KNOW

# a tie between two arms, forced apart: seconds, no dependencies
python3 forced-choice.py --blind pool.md --key pool-key.json \
    --arms "A graph" "C embedding" --duels 60 --out duels.md
python3 score-duels.py --choices my.txt --key duels-key.json

# graph versus search versus embeddings: minutes, needs numpy + an endpoint
python3 graph-yield.py --vault ~/MyVault \
    --embed-url http://localhost:1234/v1/embeddings \
    --embed-model text-embedding-bge-m3
```

`--help` prints each probe's full explanation. The rebuild, in-degree,
picker and coverage probes also accept `--json out.json` to save their
numbers next to the printed ones; `graph-yield` writes its rating list and
key as files of its own.

---

## The provenance line

Every probe prints two lines before its numbers:

```
# llm-wiki-measure 0.2.0 · indegree-probe.py · 211d850 · sha256:91640edb
# 2026-09-07 11:02 +0200
```

That is the version, the script, the git commit it ran from, a hash of the
file as it actually ran, and the time. If you quote a number from these
tools — in an issue, a discussion, a paper — please quote this line with
it. A number without its origin cannot be reproduced later, not even by the
person who produced it.

The marker `+dirty` appears after the commit when the script had
uncommitted edits. That marker is the important part: a bare commit hash
on an edited file is a false claim of reproducibility, and an edited script
is precisely when a number is most likely to be wrong.

---

## The probes, one by one

Each section says what the probe measures, how it measures it, what the
output means, and what it cannot tell you.

### rebuild-probe

**Question:** is the graph a graph, or a pile of pages with dead pointers?

**How it measures.** The probe reads every page in the page folders and
every note, and builds a name index: page basenames and aliases, case-folded,
with `-` and `_` treated as spaces. It then walks the `[[links]]` in each
page body — the *Mentions* section is cut off first, because that section
quotes your notes and is not a relation the model drew — and resolves each
target the way Obsidian would: a folder-qualified link (`[[concepts/X]]`)
resolves only if that path exists; a bare name resolves by basename or alias.

From that it counts:

- **strays** — pages with no live outgoing link to another page at all.
  A link to a source page or to a note does not count; that is the star the
  page was born in, not a relation to the rest of the wiki. A high stray
  share means the wiki is a set of islands.
- **dead links, split in two** — targets that resolve to nothing, counted
  separately for the *prose* above the Related sections and for the Related
  sections themselves. The split matters: Related is a list the plugin
  writes deliberately and can be fixed at the write gate; prose is what the
  model wrote while summarising and can only be fixed in the prompt.
- **ghost targets** — the distinct dead names, and how many of them are the
  title or alias of a note that simply has not been ingested yet. That
  subset is not an error. It is the wiki's *frontier*: the material it
  already knows it is missing.
- **birth from own note** — optional. If the vault has a paragraph ledger
  (`wiki/schema/paragraph-ledger.json`, written by a local patch that is
  not in the upstream plugin), the probe reports, for pages that have a note
  of their own, whether the page was created while ingesting that note or
  as a by-product of another note. Without the ledger this line is skipped.

**Reading the output.** On the reference vault, the July rebuild had 30 %
strays and 8 % dead Related links; the frontier-ordered September rebuild
has 1 % and 7 %. The ghost-target line usually shows a few hundred names of
which a tenth are un-ingested notes — that tenth is what an ingest picker
should go after next.

**What it cannot tell you:** whether the live links are *good*. A page with
one live link to a hub is not a stray, but it is not well connected either.
That is the next probe.

### indegree-probe

**Question:** who draws the links — and would they still, if the edges
between pages born from the same note were taken away?

**How it measures.** The probe builds the directed graph between pages in
the page folders: one edge per ordered pair, self-links and links to source
pages excluded, targets resolved as above. It reports the concentration of
incoming links: the strongest page, the share of all edges that the top 5
and top 10 pages receive, how many pages nobody links to, and a Gini
coefficient over the in-degrees (0 = every page equally linked, 1 = one
page has everything).

Then it does the whole thing again over a **subset**: only the edges between
pages that share *no* entry in their provenance field. Here is why. When
the plugin ingests one note, it creates several pages from it and — since
v1.27.1 deterministically — links those pages to each other. They are
*siblings*. Those edges are real, but they are a function of which note the
pages came from, not of any judgement that the two things are related
across your notes. On the reference vault, sibling edges were 94–98 % of
all edges. They made every hub look four times as strong as it is: when a
cap on sibling links was introduced, the strongest page dropped from 172 to
39 incoming links, and the cross-source graph did not change at all.

**Reading the output.** Read the second block as *the graph the model
actually drew*. Read the difference between the two blocks as *the sibling
rule*. The second block is thin on every vault we have seen: a few hundred
edges over a thousand pages, most pages with no cross-source link at all.
That is not a failure of your vault; it is what note-local extraction
produces, and it is the number any improvement to relatedness should move.

**What it cannot tell you:** whether the sibling edges are useless. A reader
navigating from one page to its siblings is well served. The probe only
separates the two kinds so that you do not measure one while believing you
measure the other.

### picker-probe

**Question:** did the ingest order choose the notes the vault refers to, or
the ones that sort first?

**How it measures.** The set of ingested notes is read from the source
pages (the `source_file:` field names the note). The probe then builds two
other sets of the same size N: the first N notes alphabetically — what a
folder ingest does — and the N notes most often linked as `[[Title]]` from
the *other* notes. That reference ranking is a cheap, model-free stand-in
for "what this vault is about": no model, no wiki, just your own links. It
has a long flat tail — on the reference vault, 41 % of notes are linked by
no other note — so the head of the ranking is what matters.

Reported: how many of the reference top-N each set hits, the median number
of references of the notes each set chose, and the overlap between the
ingested and the alphabetical set.

**Reading the output.** After 101 notes on the reference vault, a picker
that follows the wiki's dead links and unlinked mentions had chosen 60 of
the 101 most-referenced notes; the alphabet would have chosen 27. Median
references per chosen note: 7 against 1. If your own numbers are close to
the alphabetical column, your ingest order is not using what the vault
already knows.

**What it cannot tell you:** whether the finished graph differs. This probe
measures the *choice* of notes, not its consequence. Whether a different
order leaves a different graph needs the same vault built twice, and that
is a measurement we have not completed.

### coverage-probe

**Question:** how much of the source material actually became graph edges?

**How it measures.** Two layers over the same page–note pairs:

1. a *literal mention*: the page's title or one of its aliases occurs
   verbatim in a note's text — word boundaries, case sensitive, URLs
   stripped, aliases shorter than `--min-alias` (default 3) ignored;
2. what the graph *recorded*: the page lists that note under `sources:`.

Before it reports anything, the probe calibrates itself: on the pairs the
graph already records, how often does the literal layer find the name in
that note at all? That is the literal layer's recall, and every gap figure
below inherits its error. Read that number first.

**Reading the output.** The gap between the two layers is the space the
extraction operated in. It is a **denominator, not a defect count** — a
literal mention is not automatically a relation worth an edge. What the
number does say is how much material was available to be judged, against
how much a single extraction pass took.

### graph-yield

**Question:** what does the graph add over a full-text search and an
embedding index over the same notes?

**How it measures.** Three encodings of the same corpus:

| | layer | how |
|---|---|---|
| **A** | graph | edges from the Related sections of the wiki pages |
| **B** | full text | two pages occur literally in the same note — no model involved |
| **C** | embeddings | cosine k-nearest-neighbours over each page's prose |

For **C** the Related lists are stripped *before* embedding. Leave them in
and the embedding encodes the graph, then "rediscovers" it, and the whole
comparison is circular.

The interesting quantity is not how many edges the graph has but what it
can do that the cheap layers cannot: pairs reachable only by traversing it —
two hops apart, no direct edge, invisible to both B and C. Counting those
pairs alone is worthless, so the probe builds three control arms at the
**same edge budget** as the real graph: co-occurring pairs ranked by PMI, the
closest embedding neighbours, and the real graph randomly rewired with its
degree sequence preserved. On the reference vault the *rewired* graph
produced the most such pairs — two and a half times the real graph's. That
is not a paradox: random edges join unrelated things, which of course never
co-occur. **The count measures dissimilarity, not insight.**

So the probe ends by writing a blind rating list: equal numbers of pairs
per arm, shuffled, unlabelled, with the key in a separate file. Rate it —
yourself, or with a model — then score it with `score-blind.py`, which
reports per-arm shares with Wilson intervals. Rate before you look at the
key. If two arms come out close, that is not a tie — take them into a
[forced-choice](#forced-choice) round.

Any OpenAI-compatible embedding endpoint works (LM Studio, Ollama, hosted).
Use a multilingual model if your notes are not in English: an English-only
model finds fewer of the graph's edges, and every edge it misses is
credited to the graph as its own achievement.

### forced-choice

**Question:** two arms scored about the same in the blind rating — is that a
tie, or an instrument too blunt to separate them?

**Why it exists.** `score-blind.py` asks *does this connection carry?* one line
at a time, and a rater who wants to be fair says yes to both arms. A generous
yes costs nothing, and a determined reader can construct a story for almost any
pair. On the reference vault that showed as a **13 % floor on the randomly
rewired arm** — four pairs out of thirty that the rater talked himself into,
three of them after looking up literature. A floor that high eats most of the
distance between the arms above it, and it is not a property of the arm: it is
the rater's own construction rate.

**How it measures.** `forced-choice.py` reshapes a `graph-yield` blind list into
duels: one pair from each of two arms, side by side, left and right assigned by
coin flip, and the rater must pick one. Saying *both are fine* is gone, and so
is *both are junk* — if both are junk, the less bad one still carries the
signal. `score-duels.py` reports how often each arm won, a Wilson interval, a
two-sided binomial p against a coin flip, and — the failure mode of this design
— the **side bias**. If the left-hand side wins far from half the time, the
rater leaned rather than judged and the round is spoiled.

On the reference vault the two arms that the y/n round had put at 47 % and
53 % came out at **23 % and 77 %** over 60 duels, side bias 50 %. The tie was
the instrument, not the arms.

**Contamination.** A rater who has already scored some of these pairs is not
blind to them any more. Draw a fresh pool (`graph-yield --seed N --per-arm M`)
and pass the pairs already seen to `--exclude`; the pair text is matched, not
its number. Check that the filter bites — held against the pool itself it must
leave nothing.

```bash
python3 forced-choice.py --blind pool.md --key pool-key.json \
    --arms "A graph" "C embedding" --exclude already-rated.md \
    --duels 60 --out duels.md
# rate duels.md, then:
python3 score-duels.py --choices my.txt --key duels-key.json
```

### designator-span

**Question:** which names are claimed by both page types at once?

**How it measures.** Every basename and alias is a *designator*. The probe
lists the designators that appear on an entity page *and* a concept page,
classified by **where** on each page the designator sits (basename, or
alias). It deliberately does not decide what the collision means — a
homonym, a duplicate, or a typed relation between the two — because that
decision needs a reader.

Give it an answer you already know via `--expect` before you trust one you
do not. The flag exists because an earlier version of this probe silently
dropped the first alias of every page and returned a smaller, entirely
plausible number. `--verify` runs its self-test and needs no vault.

---

## Four ways to fool yourself, all of which happened here

1. **URLs.** A citation path `.../kupfer-mangan-chrom-molybdaen/` matches a
   page named `Chrom`; `ncbi.nlm.nih.gov` matched a page named `NIH` in 261
   of 415 notes. Link targets are stripped before matching.
2. **Case folding.** Lowercasing made an alias `ALS` match the German word
   "als" in 373 notes. Literal matching is case sensitive for that reason.
3. **Append-only state.** Plugin index files keep a history; the last record
   for a key wins. Counting every record that ever had a value overstates
   coverage — here by a factor of two.
4. **No null model.** Any count of "invisible to the cheap layers" needs a
   shape-matched random graph next to it, or it says nothing.

A note on edge counts: `graph-yield` and `indegree-probe` report different
numbers of edges on the same vault, and both are right. `graph-yield` counts
*undirected* page pairs from the Related sections only, because those are
the edges the plugin drew as relations. `indegree-probe` counts *directed*
links anywhere in the page body, because a reader can follow any of them.
On the reference vault that is 2 994 against 4 258.

And a fifth, from the newer probes: **sibling edges.** A graph built from
notes links the pages of one note to each other by construction. Measure
concentration without separating those edges and you will measure the
ingest, believing you measure the model.

---

## A worked example

One vault, one domain (medicine), German notes, local models. Numbers from
the August measurement (plugin 1.26.2, 2416 pages, 415 notes, 6354 edges)
and the September rebuild (plugin 1.27.1 with local patches, 1037 pages
after 184 notes).

**Edge level** — how much of the graph the cheap layers reproduce (August):

| layer | of 6354 edges | random page pairs |
|---|---|---|
| B co-occurrence | 87.0 % | 6.6 % |
| C kNN (k=10, bge-m3) | 48.3 % | 0.6 % |
| neither | 8.3 % | — |

**Composition** — pairs invisible to both cheap layers (August), rated blind
by a human domain reader and a local 26B model:

| arm | compositional pairs | rated as carrying (n=30 each) |
|---|---|---|
| A graph | 10 379 | 88 % · 63 % |
| C embedding | 13 458 | 71 % · 77 % |
| B co-occurrence | 8 885 | 19 % · 33 % |
| rewired null | 26 639 | 7 % · 21 % |

The gap between the real graph and the rewired null is large under both
raters. The gap between the graph and a purely embedding-built graph is not
established: the raters disagree on its sign, and a forced-choice round
(24 head-to-head comparisons) came out 12:9 and 15:9 for the graph,
p = 0.66 and p = 0.31. Inter-rater agreement was moderate (Cohen's kappa
0.41). This quantity is genuinely hard to judge, which is probably why
nobody measures it.

**Rebuild** (September, 184 notes in):

| | all edges | edges between pages sharing no source |
|---|---|---|
| edges | 4 217 | 243 |
| strongest page, incoming | 63 | 12 |
| pages with no incoming | 29 % | 87 % |

Strays 1 % (July: 30 %). Ingest order: 134 of the 184 most-referenced
notes chosen, against 90 for the alphabet.

---

## Probes that run inside the plugin

[`plugin-probes/`](plugin-probes/) holds a second family: probes that run
*inside* a checkout of the plugin and drive its real functions over your
vault — the dedup candidate window, related-link resolution, the ambiguity
records. Those depend on the plugin on purpose. A probe that reimplements
the code it measures measures the reimplementation, and the interesting
failures live in the difference between the two. They are still read-only.
The folder has its own README.

---

## Limits

One vault is not a reference value. The numbers above show what the output
looks like; they are not a benchmark to compare against. Detecting a small
difference between two arms needs a few hundred forced-choice comparisons,
not thirty absolute judgements. The rater matters: an LLM judge from the
same family as the pipeline that built the graph is not a neutral
instrument. And the probes measure structure, not truth — a well-connected
page can still say something wrong.

If you run these on your own vault, the two numbers worth comparing first
are the co-occurrence share from `graph-yield` and the cross-source edge
count from `indegree-probe`. Both are probably mechanical rather than
domain-specific: extraction is note-local, so pages that never share a note
can only be linked through merge and dedup. A vault that disagrees would be
more interesting than one that confirms it — please open an issue with the
provenance lines.

## Versioning

Releases are tagged (`v0.2.0` was the first). Each probe carries the version
in its provenance line. `CHANGELOG.md` lists what changed between versions,
so that a number quoted with an older version can be compared honestly.

## Licence

MIT.
