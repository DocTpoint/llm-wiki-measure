# Changelog

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
