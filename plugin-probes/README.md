# plugin-probes

Probes that run **inside** the plugin's own repository and drive its real
functions over your vault.

This is a different contract from the Python probes at the top level. Those are
standalone and have no plugin dependency. These do — deliberately. A probe that
reimplements the code it is measuring measures the reimplementation, and the
interesting failures live in the difference between the two.

Still read-only: they open your vault's files and write nothing back.

## Running one

There is no runner here. Copy the probe into a checkout of the plugin, where its
imports resolve and `vitest` will pick it up:

```bash
cp plugin-probes/related-link-resolution.test.ts /path/to/obsidian-llm-wiki/src/
cd /path/to/obsidian-llm-wiki

LLM_WIKI_VAULT=~/MyVault \
LLM_WIKI_LABEL_ENTITIES='Related Entities' \
LLM_WIKI_LABEL_CONCEPTS='Related Concepts' \
npx vitest run src/related-link-resolution.test.ts --reporter=verbose --silent=false
```

Then delete it from `src/` — it is a probe, not a test, and it fails on any
machine without that vault.

| variable | default | note |
|---|---|---|
| `LLM_WIKI_VAULT` | — | required, vault root |
| `LLM_WIKI_FOLDER` | `wiki` | the plugin's wiki folder |
| `LLM_WIKI_LABEL_ENTITIES` | `Related Entities` | **check against a real page** |
| `LLM_WIKI_LABEL_CONCEPTS` | `Related Concepts` | localized wikis differ |
| `LLM_WIKI_SLUG_CASE` | `preserve` | must match your `slugCase` setting |

The two labels are the most common way to get a silent zero: if they do not
match your pages, no section is ever entered and every count is empty rather
than wrong.

## `related-link-resolution.test.ts`

Counts how many related links point at a page that exists, before and after
whatever the currently checked-out resolver does.

Two things about it are worth stealing for other probes:

**The vault is the baseline arm.** A built vault's related sections are model
output that already went through whatever resolver was current when those pages
were written. You do not have to deploy the old build, re-run an ingest, or
write anything — read the pages, run the current resolver over the same text,
count both sides. On a vault of ~2,840 pages this takes about six seconds.

**The measurement point decides the sign.** Resolution here is judged the way
`scanDeadLinks` judges it, through `buildKnownTargets`, which accepts a basename
and every path suffix. Ask the narrower question — does this exact path exist —
and a bare `[[Dopamin]]` counts as dead, gains inflate, and regressions
disappear. On the vault this was written for, the narrow check reported *zero*
regressions where the plugin's own semantics found *seven*. Same run, same code,
opposite verdict.

Read the regression list, not just the totals. It is short by construction, and
it is the only part of the output that can veto a change.

## What it does not measure

Only the resolution half. Whether a prompt change alters *which* names the model
extracts is a stochastic question: it needs repeated draws against a live model,
because the extracted set varies noticeably between draws of the same note. A
single run there measures sampling noise.

## `two-arm-draw.sh`

Draws alternating extraction runs from two checkouts and writes one JSON line
per draw. Use it when the question is whether a code change altered *what the
model extracts*, which the resolution probe above deliberately does not answer.

```bash
./two-arm-draw.sh --arm-a ~/dev/wiki-base --arm-b ~/dev/wiki-patch \
  --vault ~/MyVault --note "Notes/Fasting.md" --draws 5 \
  -- --temperature 0 --thinking-mode plugin-off --batch-size 10
```

Everything after `--` is passed to the CLI unchanged. Both arms must be full
checkouts with `node_modules` — **a git worktree does not inherit them**, and
the probe refuses to start rather than half-run.

Three things it is built around:

**The within-arm spread is the yardstick.** Two arms of a sampling model always
differ. The only question that means anything is whether they differ by more
than the same arm differs from itself, so a single draw per arm settles
nothing. On the run this was written for, one arm's concept set varied across
five distinct variants between draws of the same note.

**Interleave, or the drift picks a side.** Run all of A and then all of B and
anything that changes over the session — prompt-cache state, a model reload,
thermal throttling — lands entirely on the second arm and reads as an effect.
The cost is that neither arm keeps a warm cache, so the *timings* in the output
are an artifact of the design and must not be reported as a result.

**Read `cli_exit`, `failed_calls` and `batches` before the names.** A draw whose
CLI exited non-zero produced nothing at all, which looks identical to a draw
where the model found nothing unless you check. A draw that lost a batch
produced fewer names for a reason unrelated to the arm. On the original run
every draw of one arm lost its second round to the output-token ceiling — which
was itself the finding, but only because it was visible per draw rather than
averaged away. Both arms' *first* draw came back empty on a cold cache; treat
cache state as a covariate you record, not a variable you control.

`--extract-only` stops the pipeline before the write phase, so the vault is not
touched. It still calls your model, which costs real time: five draws per arm
was roughly forty minutes on a local 26B.

## `dedup-candidate-cost.test.ts` and `dedup-candidate-recall.test.ts`

A cost arm and a recall arm for the same design decision, meant to be read
together. Both are read-only and make no model call; a run over ~2,400 pages
takes a few seconds.

Semantic dedup sends the LLM a list of existing pages to compare a newly
extracted name against. A lexical pre-filter keeps the top 30 — but when the
*name* alone produces no keyword hit, it returns **every** same-type page, on
the reasoning that a missed duplicate becomes a duplicate page and that this
case is rare.

**The cost arm** asks how rare. On the vault this was written for: **61% of
entity dedups and 41% of concept dedups** take the fallback, shipping ~1,295
pages into a prompt where the filtered path sends 15. In pre-filter-era logs
those calls averaged 33,745 prompt tokens and 53 seconds to produce an
18-token answer.

**The recall arm** asks what the fallback buys. A curated alias is an
alternative name for its own page, and one a model demonstrably produced. The
arm hides that alias from the index first — a surface form the vault already
lists is resolved before the LLM is ever called, so leaving it in measures
nothing (the first version of this probe reported 0.0% and that is what a
broken arm looks like). Result: the pre-filter drops the correct page in
**13.6% / 9.8%** of trials even when it does fire.

Two things worth taking from the pair:

**Pass the ranking signal the production caller passes.** Running the recall
arm with an empty summary reports 21.2% loss; with the summary the real caller
supplies, 13.6%. Same code, same vault — a probe that starves the ranker
measures the starvation.

**The two arms answer different questions and must not be pooled.** The cost
arm asks about names whose page does not exist yet, the recall arm about names
for a page that does. Their fallback rates differ (61% vs 26%) for that reason
alone, and averaging them would describe no situation that occurs.
