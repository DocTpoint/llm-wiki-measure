# AGENTS.md

Rules for anyone — human or agent — editing this repository. The README says
what the probes do; this file says what must not change while doing it.

## Four rules that the code does not show

1. **Helpers are duplicated on purpose.** `stamp()`, `aliases()`, `fold()` and
   the like appear in every probe. Do not extract them into a shared module.
   Each script must stay copyable on its own, into any vault, with no import
   next to it.
2. **The output is a contract.** Numbers from these probes are quoted in
   issues, changelogs and notes together with their provenance line. If you
   change *what* a line counts — resolution rules, which sections are read,
   how an edge is defined — bump `__version__` in that probe, add a line to
   `CHANGELOG.md`, and tag. Changing the wording of a line is free; changing
   its meaning without a version is not.
3. **Read-only is not negotiable.** No probe writes into the vault, not even a
   cache. `graph-yield` writes its embedding cache and blind list where
   `--cache` / `--blind` point, and those default to the working directory,
   never to the vault.
4. **A number without its stamp is not a result.** Every probe prints two
   provenance lines first. A stamp with `+dirty` means the script had
   uncommitted edits; do not quote such a number anywhere. Commit, re-run,
   then quote.

## Before you change a probe

- Run it on a vault you know before and after, and compare the numbers. If a
  count moves, you changed the meaning (rule 2), or you found a bug — say
  which in the commit message.
- Keep the docstring at the top current: `--help` prints it, and it is the
  only documentation a copied script carries.
- Default folder and field names are the plugin's (`entities`, `concepts`,
  `sources`, `sources:`, `source_file:`). They are parameters; do not hard-code
  a new one.

## Running

- Python 3.9+. Only `graph-yield` needs `numpy`; use the ignored `.venv/`.
- `graph-yield` needs an OpenAI-compatible embedding endpoint. If that
  endpoint is also serving an ingest, load the embedding model first — a
  just-in-time load next to a busy generator was refused on LM Studio. A small
  embedder running beside the ingest did not measurably slow it (one probe,
  one machine); if you need the ingest's timing clean, run the probe after it.
- Give `--notes` when the notes live in one folder; without it every `.md`
  outside the wiki counts as a note.

## Remotes and releases

- `origin` is the fork under `DocTpoint`, the working copy. `upstream` is
  `GD4AI/llm-wiki-measure`, the published one.
- A release is a version bump, a `CHANGELOG.md` entry, an annotated tag
  `vX.Y.Z`, and a push of `main` **and** the tag to **both** remotes. Nothing
  here checks for drift between them; the push is the check.
- Commit messages: one line saying what changed for a reader of the log, then
  the why. No tool trailers.

## What this repository is not

It measures structure — links, coverage, order — not whether a page is
true. It is built for obsidian-llm-wiki vaults and generalises only as far as
the folder-and-field parameters go. One vault is not a benchmark; a number
from here is an example of the output, not a reference value.
