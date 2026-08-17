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
