# Changelog

## 0.5.0 — 2026-09-09

- New: `plugin-probes/precision-window-probe.test.ts` — the other half of the
  window question. The recall arm asks where a known target lands; every trial
  there has one. In production most items have no page at all, and
  `core/candidate-window.ts` has no floor: both arms always return K pages. So
  the question is what each arm returns when it knows nothing — pool order in
  the word arm, the K nearest pages in the vault in the embedding arm, every
  one of them the most plausible wrong answer available.
- Three populations over one pool: the target present, the same trials with the
  target page removed from the pool, and constructed items from fields the
  vault does not cover. The held-out condition is the point — the item then
  provably has no page, and its text is real vault prose rather than something
  written for the occasion.
- On the reference vault the distributions do not separate. Median cosine of
  the target 0.691 / 0.673 against 0.700 / 0.689 for the best wrong answer once
  the target is taken out, with a null pairing at 0.45.
- New: `plugin-probes/abstention-statistic-probe.test.ts` — the same populations
  asked with the corpus taken out. A null pairing at 0.45 rather than at 0 says
  that most of every score is shared vocabulary: one language, one register, one
  subject area. The mean page vector has length 0.70 and two arbitrary pages
  already share a cosine of 0.50, so a threshold on the raw number is largely a
  threshold on that constant. Five statistics under one rule shape — raw,
  mean-centred, all-but-the-top, the top hit's z against the item's own
  distribution, and the top-1/top-2 margin.
- Removing the constant helps and does not rescue the rule. Stripping the top
  twenty directions widens the median ratio from 1.08 to 1.33 and lifts the
  abstention rate at 95 % target retention from 13.2 % to 21.7 %, but the
  overlap only falls from 87 % to 78 %: four in five no-page items still get a
  full window. So a raw-cosine floor is nearly useless, a floor on a
  corpus-corrected number is meaningfully better and still weak.
- The margin is the worst statistic of the five (9 %), and that is the
  informative failure: even when the right page exists it does not stand alone
  but sits in a crowd of near-equal neighbours. That is the vault's own density
  showing through, not a limit of the encoder.
- New: `plugin-probes/precision-model-probe.test.ts` — the same two windows in
  front of `resolveEntityDedup` on the production path, scored in both
  directions at once. An arm measured only on items that should not merge is
  won by answering "no match" every time, so each alias is asked twice, with
  and without its page, and the negative cases of the case file are asked
  alongside.
- On the reference vault the arms are indistinguishable where the risk was
  expected — 5 of 48 false merges each, four paired disagreements, two in each
  direction, and identical verdicts on all eight hand-picked cases. The
  difference is on the other side: the target is found in 31 of 40 trials
  against 12, the embedding better in 19 pairs and the word arm in none. The
  tempting pages are lexical neighbours the word window already contains.
- Version bumped in every probe's provenance line; no probe changed what it
  counts.

## 0.4.0 — 2026-09-09

- New: `plugin-probes/embedding-window-probe.test.ts` — the candidate window
  ranked by meaning instead of by words, against `selectCandidateWindow` as
  shipped, same pool and same K in one run. Both arms are asked for the full
  ordering, so a target that misses the window still has a readable rank.
- It carries its own two controls, because neither number is readable without
  them: the alias set is split by the target's source count (on a one-source
  page the item text is the note the page was written from, so a hit may be
  provenance rather than meaning), and a null model asks each trial with the
  next trial's item vector.
- On the reference vault the embedding arm put the target in the window in
  99.5 % / 95.1 % of alias trials against 56.1 % / 33.9 % for words, held at
  100 % / 88.7 % on multi-source targets, and the null model sat at chance
  (median rank 509 of 957). Read that as one vault and one encoder, not as a
  reference value.
- Version bumped in every probe's provenance line; no probe changed what it
  counts.

## 0.3.1 — 2026-09-09

- Fix: the four probes that read notes (`rebuild-probe`, `picker-probe`,
  `coverage-probe`, `graph-yield`) now walk symlinked folders and accept an
  absolute `--notes` path. A vault whose notes folder is a symlink came out as
  `notes 0` without a word of warning, and every count that needs the notes —
  the frontier share of the dead links, the ghost targets that are really
  uningested notes, the birth counts — silently became zero or meaningless.
  An absolute `--notes` outside the vault crashed with a `ValueError` from
  `relative_to` instead of a message.
- A `--notes` folder that does not exist now exits with `no notes folder at
  <path>` instead of counting nothing.
- No probe changed what it counts: all four print identical numbers on a
  vault with a plain notes folder, checked before and after against the
  reference vault.

## 0.3.0 — 2026-09-08

- New: `forced-choice.py` — turns a `graph-yield` blind list into duels
  between two arms: one pair from each, side by side, side assigned by coin
  flip, no tie on offer. `--exclude` drops pairs the rater has already scored,
  matched by pair text rather than by number.
- New: `score-duels.py` — win share per arm with a Wilson interval, a
  two-sided binomial p against a coin flip, and the side bias, which is the
  failure mode of the design: a rater who leans left produces a difference out
  of nothing.
- Why they exist: on the reference vault the y/n round of `score-blind.py` put
  two arms at 47 % and 53 % — indistinguishable at n=30 — while the rewired
  control arm sat at 13 %, a floor that is the rater's construction rate and
  not a property of the arm. Forced apart over 60 duels the same two arms came
  out at 23 % and 77 %, side bias 50 %. A close y/n result is a blunt
  instrument, not a tie.
- README: the two probes in the table of contents, the quick start and a
  section of their own, including the contamination rule — a fresh pool and
  `--exclude`, because a rater is no longer blind to pairs already scored.
- Version bumped in every probe's provenance line; no probe changed what it
  counts.

## 0.2.1 — 2026-09-07

- The four older probes carry the version in their provenance line too.
- `coverage-probe.py` takes `--page-folders` and `--provenance-field`;
  `graph-yield.py` takes `--page-folders`; `designator-span.py` accepts
  `--page-folders` as an alias of its existing `--folders`. Defaults
  unchanged, output unchanged.

## 0.2.0 — 2026-09-07

- New: `rebuild-probe.py` — strays, dead links split into prose and Related,
  ghost targets with their frontier share, optional birth count from a
  paragraph ledger.
- New: `indegree-probe.py` — in-degree concentration over all edges and over
  the edges between pages that share no source (the sibling split).
- New: `picker-probe.py` — the ingested set of notes against the alphabetical
  set and the most-referenced set of the same size.
- All three take `--page-folders`, `--sources-folder` and the provenance /
  source field name as parameters, so wikis that are not built by the plugin
  but keep the same shape can be measured.
- Every probe now prints its version in the provenance line.

## 0.1.0 — 2026-08-21

- `coverage-probe.py`, `graph-yield.py`, `score-blind.py`,
  `designator-span.py` and the `plugin-probes/` family, as used for the
  August measurements. Never tagged; `46713dd` is the state this refers to.
