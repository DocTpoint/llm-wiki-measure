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

## `ambiguity-probe.test.ts`

Does a name that travels with its domain change the dedup decision? Two arms
over the same cases and the same model, interleaved draws: A is the plugin's
`resolveEntityDedup` prompt as it stands, B adds one `domains:` line per
candidate, one `- Domains:` line on the new item and one sentence on how to read
them. Everything else is the plugin's own chain over the vault — ConflictResolver
(cases it decides without a call are reported, not pushed through the model),
`selectDedupCandidates` (the real window), the prompt, the system prompt via
SchemaManager. The annotation is synthesized from the notes behind each page's
`sources:`, because no page carries the field before a rebuild; it is therefore
the upper bound of what the writer delivers.

The cases are yours: a JSON file of items as the extraction would hand them to
dedup, each with the expected decision (`LLM_WIKI_CASES`, default
`<vault>/wiki/schema/ambiguity-cases.json`). `LLM_WIKI_ORACLE_WINDOW=1` appends
the expected page to the window where the top-K left it out — that separates
"the annotation did not help" from "the target was not in the list".

Read the preparation report before the numbers. Three of the 18 cases in the
vault this was written for never reached the model (alias matches in the
resolver), four had their target outside the top-30 window. On the 15 that ran,
the annotation changed nothing except one case, for the worse — while the
full-list fallback missed every synonym in 18 of 18 calls and the same model
found the same targets 9 of 9 times in a 30-entry window. The lever is the
window, not the label. One model, 15 cases, three draws; 59 minutes, 0.96 M
prompt tokens on arm A, 1.51 M on arm B.

## `dedup-window-probe.test.ts`

The probe after the ambiguity probe's finding. If the model finds a synonym's
target in a 30-entry window and not in a 1,200-entry list, the question is no
longer whether to cap the list but **which ranking puts the target into 30
slots** using only what the caller has without a model call. Read-only, no
model; a run over ~2,400 pages takes 65–95 seconds.

Five window arms, all top-K: the shipped `selectDedupCandidates` (name-gate,
else the full list) · the same lexical score always ranked · plus a bonus per
shared domain · plus a bonus per item-summary keyword found in the page's own
prose · both. Two case sets, never pooled: the synonym cases of the ambiguity
file that have a target, and every curated alias of every page hidden from the
index (the S108 recall arm), with trials the ConflictResolver decides without
a call counted out.

Three design points, because each one flipped a number:

**Leave one source out.** A new mention comes from a note that is not yet
among the page's sources, so the item carries the tags of the page's first
source note and the page the union over its others. Give both sides the same
union (`LLM_WIKI_DOMAIN_MODE=all`) and the target wins the domain bonus by
construction — 69–79 % in-window, an oracle, not an upper bound. Under
leave-one-out two thirds of the target pages have no domains left, the bonus
lifts competitors over them, and the domain arm lands *below* the bare lexical
arm (24 % vs 27 %).

**Let the item's text come from somewhere else.** With the page's own first
paragraph as the item summary (the S108 arm) the text arm reaches 50 %; with
the first 300 characters of the left-out source note, 42 %. The ordering of
the arms is the same either way — the note-text run is the one to quote,
because page prose matching its own page is partly authorship, not signal.

**Read ranks, not only the hit rate.** On the ten synonym cases the text arm
misses four of ten windows but puts all ten targets under rank 100, where the
lexical arm had five above 380 or in the full list.

On the vault this was written for: the full-list fallback is not worth
keeping (the always-ranked arm already beats it); text overlap lifts the
window rate by ~15 points on both sets; domains help only where the page
already has domains from other notes, which is the minority; and the best
cheap arm still leaves ~60 % of alias trials outside the window — the part no
name or word index reaches. Side finding: 47 curated aliases resolve to a
*different* page than the one carrying them.

## `embedding-window-probe.test.ts`

The same window, ranked by meaning instead of by words. Two arms over one pool
in one run: `selectCandidateWindow` as shipped (dfCap 0.5) against the cosine
between one vector for the item and one per page, over the same 2,000-character
window of the page body the word arm reads. No reranking and no hybrid — a
hybrid that wins does not say which half won.

Needs an OpenAI-compatible `/v1/embeddings` endpoint (`LLM_WIKI_EMBED_URL`,
default LM Studio on 1234). Page vectors are cached by model and content in
`LLM_WIKI_EMBED_CACHE`, so the second run over a vault embeds only the items:
2,000 pages take about two minutes, a re-run thirteen seconds. Point the cache
outside the vault and outside the checkout.

Two controls ship with it, because neither arm's number is readable alone:

**The alias set is split by the target's source count.** An alias trial's item
text is the first paragraph of the page's first source note. On a one-source
page the page *is* a rewrite of that note, so a vector that finds it may be
recognising provenance rather than meaning — the same shape as a sibling
tautology. Read the multi-source block as the finding.

**A null model asks each trial with the next trial's item vector.** A median
rank of 2 means nothing until the line below it says that the wrong pairing
lands at 509 of 957.

`LLM_WIKI_ALIAS_LIMIT` (default 200 per page type) caps the alias draw, since
every trial costs one embedding; the seed fixes the draw only for one pool.

**Encoders that want a task prefix.** `LLM_WIKI_EMBED_DOC_PREFIX` and
`LLM_WIKI_EMBED_QUERY_PREFIX` are empty by default, which is correct for bge-m3
and wrong for several other families: Qwen3-Embedding asks for an instruction on
the query side and nothing on the document side, the E5 family prefixes both.
Run such a model without its prefix and the arm measures misuse, not the
encoder. The prefix rides in the embedded text itself, so the cache key
separates a prefixed run from an unprefixed one, and the run header prints both.

⚠️ **The recall arm is saturated on a built vault.** At 99.5 / 95.6 % it can no
longer tell two encoders apart — S176 ran bge-m3 against Qwen3-Embedding-0.6B
over one substrate and they landed within a percentage point of each other, on
identical median ranks. That answers the "one vault, one encoder" objection and
retires the question here; a further encoder comparison belongs at the precision
arm, where the distributions are not against the ceiling.

⚠️ Run it with `--disable-console-intercept` (or `--reporter=verbose
--silent=false`). Outside a TTY vitest swallows a probe's console output and
reports a passing test with nothing in it.

## `precision-window-probe.test.ts`

The other half of the window question. `embedding-window-probe` asks where a
known target lands, and every trial there has one. In production most items do
not: an extracted item is usually a new thing, or a thing the vault names in
passing. `core/candidate-window.ts` has no floor — it says so in its own header
— so both arms always return K pages, and the difference is what they return
when they know nothing. The word arm returns pool order. The embedding arm
returns the K nearest pages in the vault, every one of them the most plausible
wrong answer available.

Three populations over one pool, no model calls:

**Z+** the alias trials of the recall arm, unchanged — the target's own score.
**Z−** the same trials with the target page removed from the pool. The item then
provably has no page, and its text is real vault prose rather than something
written for the probe — the statistic is the top-1, the best wrong answer.
**F** constructed items from fields the vault does not cover. A floor, not a
rate: that text was written for the probe, so it says what "nothing here" looks
like and nothing about how often it happens.

The abstention question is then one comparison. A floor `t` drops every
candidate below it: on Z+ that is a loss, on Z− and F a correct empty window. A
rule exists only if the distributions separate. On the reference vault they do
not — median 0.691 / 0.673 for the target against 0.700 / 0.689 for the best
wrong answer, both far above a null pairing at 0.45 — and keeping 95 % of the
targets buys abstention in 5.3 % of the no-page trials. Read that as: the
encoder works, and it cannot tell whether the page exists. ⚠ That null pairing
at 0.45 is itself a finding, and `abstention-statistic-probe` follows it: most
of the raw number is the corpus, so this arm understates what a
corpus-corrected statistic can do.

The word arm additionally gets a measure only it can carry. Ties keep pool
order, so the same query over a reversed pool returns a different top-1 exactly
when the leader was not uniquely scored. That is the arm declaring its own
ignorance — 19 % / 15 % of trials here, which is less often than the design
assumed, so the honest contrast is not honest against dishonest but *visibly*
wrong against *plausibly* wrong.

Reuses `LLM_WIKI_EMBED_CACHE`, so a run after the recall arm embeds only what is
new. Same `--disable-console-intercept` warning as above.

## `precision-model-probe.test.ts`

The two windows in front of the real decision. Everything is the production
path — `PROMPTS.resolveEntityDedup` with the variables `resolvePagePath` passes,
the `index` system prompt via `SchemaManager`, `TOKENS_DEDUP_RESOLUTION`,
`json_schema` at the wire — and the arms differ in one thing: which thirty pages
the call is shown. W is `selectDedupCandidates` as shipped, E the top thirty by
cosine over the same pool.

**Both directions are scored or the measurement is worthless.** An arm judged
only on items that should not merge is won by answering "no match" every time;
one judged only on targets is won by merging everything. So each drawn alias is
asked twice — once with its page in the vault (correct answer: that page) and
once with the page removed (correct answer: none) — and the negative cases of
`ambiguity-cases.json` are asked alongside. Identical item, different vault: a
difference between the two is the vault, not the wording. Trials are drawn
stratified by the Z− top-1 cosine so the tempting end is represented rather than
averaged away.

`LLM_WIKI_PAIRS` sets the pairs per page type (default 6; 20 gives 168 calls in
about seven minutes on a local 26B). `LLM_WIKI_DRY=1` prints the system prompt
and the first user prompt and calls nothing — worth doing once, since the prompt
is the measurement.

⚠ Two things this probe cannot pin down. The absolute false-merge rate moves
with the draw: two disjoint samples from the same pool gave 4 of 12 and 2 of 40.
Only the *paired* comparison between arms is independent of that. And the
negative cases are hand-picked hard ones, so they concentrate the false merges
and are not a cross-section.

⚠ Pool order: production sorts the candidate pool by file ctime for the KV
prefix cache. In an unpacked archive ctime is the unpacking time, so this probe
sorts by the `created:` field instead. Scored candidates are unaffected; only
the order of the score-0 tail differs, in the word arm.


## `abstention-statistic-probe.test.ts`

The same question as `precision-window-probe`, asked with the corpus taken out.

That probe's own null model is the reason to doubt its statistic: a random item
paired with a random page scores 0.45, not 0. Whatever that is, it is not the
pair — it is one language, one register, one subject area, the same study words
on every page. Measured here directly: the mean page vector has length 0.70 and
two arbitrary pages already share a cosine of 0.50. About half of every score is
the corpus, so a threshold on the raw number is largely a threshold on a
constant, and a real difference riding on top of it is compressed out of sight.

Five statistics, all under the same rule shape so they are comparable — abstain,
offer no window at all, when the statistic falls below `t`:

**raw** cosine as shipped. **centred** with the pool's mean page vector
subtracted from every page and from the item. **abtt** centred, then the top
`LLM_WIKI_ABTT_K` principal directions of the page cloud projected out. **z**
how far the best candidate stands out from *this item's* own distribution over
the pool, which needs no vector surgery at all. **margin** top-1 minus top-2.

The last two are the interesting ones, because they sidestep the objection
rather than repairing it: a constant that lies on every page cancels out of a
ratio and out of a difference.

On the reference vault the correction is real and insufficient. Stripping twenty
directions widens the ratio of the medians from 1.08 to 1.33 and lifts the
abstention rate at 95 % target retention from 13.2 % to 21.7 %; the overlap
falls only from 87 % to 78 %. The margin is the worst of the five at 9 %, and
that failure carries the most information: even when the right page exists it
does not stand alone but sits in a crowd of near-equal neighbours — the vault's
own density, not a limit of the encoder.

⚠ Do not pair these numbers with `precision-window-probe`'s. That probe applies
a floor per candidate and scores the target's own cosine; this one abstains on
the window and scores its top. Both are legitimate rule shapes and neither
number is the other's baseline — raw reads 5.3 % there and 13.2 % here for that
reason alone.

⚠ At 189 and 183 trials the `k` sweep is not smooth: k = 20 abstains less than
k = 10 at 90 % retention. Read the direction, not an optimum.

Needs no endpoint and no model: every vector comes from the cache
`precision-window-probe` filled.
