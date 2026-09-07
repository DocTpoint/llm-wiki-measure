# Changelog

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
