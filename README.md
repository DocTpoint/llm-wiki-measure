# llm-wiki-measure

Two read-only probes for an [llm-wiki](https://github.com/green-dalii/obsidian-llm-wiki)
vault. They answer questions the plugin cannot answer about itself:

1. **Coverage** — how much of the source material actually became graph edges?
2. **Yield** — what does the graph add over a full-text search and an embedding
   index over the same notes?

No writes, no network beyond your own embedding endpoint, no plugin dependency.
Python 3.9+, `numpy` for the second script.

There is a second family in [`plugin-probes/`](plugin-probes/): probes that run
*inside* a checkout of the plugin and drive its real functions over your vault.
Those do depend on the plugin, on purpose — a probe that reimplements the code
it measures measures the reimplementation. Everything above about these two
Python scripts stays true; the exception is fenced into that folder.

---

## Quick start

```bash
python3 coverage-probe.py --vault ~/MyVault

python3 graph-yield.py --vault ~/MyVault \
    --embed-url http://localhost:1234/v1/embeddings \
    --embed-model text-embedding-bge-m3
```

Any OpenAI-compatible embedding endpoint works (LM Studio, Ollama, hosted).
A multilingual model matters if your notes are not in English: an English-only
model finds fewer of the graph's edges, and every edge it misses is credited to
the graph as its own achievement.

---

## What the probes compare

Three encodings of the same corpus:

| | layer | how |
|---|---|---|
| **A** | graph | edges from the Related sections of the wiki pages |
| **B** | full text | two pages occur literally in the same note — word boundaries, case sensitive, URLs stripped. No model involved. |
| **C** | embeddings | cosine kNN over each page's prose |

For **C** the Related link lists are stripped *before* embedding. Leave them in
and the embedding encodes the graph, then "rediscovers" it, and the whole
comparison is circular.

`coverage-probe.py` asks a smaller question: for every page, in how many notes
does its title or an alias literally appear, and how many of those notes are
recorded as its `sources:`? The gap is the space the extraction operated in.
It is a **denominator, not a defect count** — a literal mention is not
automatically a relation worth an edge.

---

## The trap this repo exists for

The interesting quantity is not how many edges a graph has but what it can do
that the cheap layers cannot: pairs reachable only by traversing it — two hops
apart, no direct edge, invisible to both B and C.

Counting those pairs is worthless. `graph-yield.py` therefore builds three
control arms at the **same edge budget** as the real graph:

- **B-graph** — co-occurring page pairs ranked by PMI
- **C-graph** — the closest embedding neighbours
- **rewired** — the real graph, randomly rewired, degree sequence preserved

On the vault this was developed against, the *rewired* graph produced the most
compositional pairs — two and a half times the real graph's. That is not a
paradox: random edges join unrelated things, so of course those pairs never
co-occur and are never embedding neighbours. **The count measures
dissimilarity, not insight.**

So the script ends by writing a blind rating list: equal numbers of pairs per
arm, shuffled, unlabelled, with the key in a separate file. Rate it, then score
it with `score-blind.py`. Rate before you look at the key.

---

## Four ways to fool yourself, all of which happened here

1. **URLs.** A citation path `.../kupfer-mangan-chrom-molybdaen/` matches a page
   named `Chrom`; `ncbi.nlm.nih.gov` matched a page named `NIH` in 261 of 415
   notes. Link targets are stripped before matching.
2. **Case folding.** Lowercasing made an alias `ALS` match the German word
   "als" in 373 notes. Matching is case sensitive.
3. **Append-only state.** Plugin index files (`.ajson`) keep a history; the last
   record for a key wins. Counting every record that ever had a value
   overstates coverage — here by a factor of two.
4. **No null model.** See above. Any count of "invisible to the cheap layers"
   needs a shape-matched random graph next to it, or it says nothing.

`coverage-probe.py` prints its own recall control first: on edges the graph
already records, how often does the literal layer find the page name in that
note at all? If that number is low, every figure below it inherits the error.

---

## Worked example

One vault, one domain (medicine), German notes, plugin 1.26.2, local models:
2416 entity/concept pages, 415 notes, 6354 edges.

**Edge level** — how much of the graph the cheap layers reproduce:

| layer | of 6354 edges | random page pairs |
|---|---|---|
| B co-occurrence | 87.0 % | 6.6 % |
| C kNN (k=10, bge-m3) | 48.3 % | 0.6 % |
| neither | 8.3 % | — |

Only 13.9 % of the graph's edges are among the top 6354 co-occurring pairs by
PMI: the candidate space is shared, the selection is not.

**Composition** — pairs invisible to both cheap layers, after the hub filter:

| arm | compositional pairs | rated as carrying (n=30 each) |
|---|---|---|
| A graph | 10 379 | 88 % · 63 % |
| C embedding | 13 458 | 71 % · 77 % |
| B co-occurrence | 8 885 | 19 % · 33 % |
| rewired null | 26 639 | 7 % · 21 % |

Two independent raters (a human domain reader and a local 26B model), blind to
the arm, ratings committed before the key was opened. The gap between the real
graph and the rewired null is large under both — the compositional pairs are
not an artifact of graph shape. The gap between the graph and a purely
embedding-built graph is not established: the raters disagree on its sign, and
a forced-choice round with evidence attached (24 head-to-head comparisons)
came out 12:9 and 15:9 for the graph, p = 0.66 and p = 0.31.

Inter-rater agreement was moderate (Cohen's kappa 0.41 on bare triples, higher
with one-sentence descriptions attached). This quantity is genuinely hard to
judge, which is the most likely reason nobody measures it.

---

## Limits

One vault is not a reference value. The numbers above are an example of what
the output looks like, not a benchmark to compare against. Detecting a small
difference between two arms needs a few hundred forced-choice comparisons, not
thirty absolute judgements. And the rater matters: an LLM judge from the same
family as the pipeline that built the graph is not a neutral instrument, which
is why the second rater here is reported separately rather than averaged in.

If you run this on your own vault, the number worth comparing first is the
co-occurrence share. It is probably mechanical rather than domain-specific:
extraction is note-local, so entities that never share a note can only be
linked through merge and dedup. A vault that disagrees would be more
interesting than one that confirms it.

MIT licensed.
