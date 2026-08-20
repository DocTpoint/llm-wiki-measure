#!/usr/bin/env bash
# Draw alternating extraction runs from two checkouts of the plugin and record
# each draw as one JSON line.
#
# The question this answers is never "did the two arms differ?" -- on a
# sampling model they always differ. It is "did they differ by more than the
# same arm differs from itself?" That needs several draws per arm, and it needs
# them interleaved: run all of A then all of B and any drift over the session
# (cache state, thermal, a model reload) lands entirely on one arm.
#
# Writes nothing to the vault: --extract-only runs the real pipeline and stops
# before the write phase.
#
# Usage:
#   two-arm-draw.sh --arm-a DIR --arm-b DIR --vault DIR --note REL [options]
#
#   --draws N            draws per arm (default 5)
#   --out FILE           JSONL output (default ./two-arm-draws.jsonl)
#   --                   everything after this goes to the CLI verbatim
#
# Example:
#   ./two-arm-draw.sh --arm-a ~/dev/wiki-base --arm-b ~/dev/wiki-patch \
#     --vault ~/MyVault --note "Notes/Fasting.md" --draws 5 \
#     -- --temperature 0 --thinking-mode plugin-off --batch-size 10
set -uo pipefail

DRAWS=5; OUT="./two-arm-draws.jsonl"; ARM_A=""; ARM_B=""; VAULT=""; NOTE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arm-a) ARM_A="$2"; shift 2;;
    --arm-b) ARM_B="$2"; shift 2;;
    --vault) VAULT="$2"; shift 2;;
    --note)  NOTE="$2";  shift 2;;
    --draws) DRAWS="$2"; shift 2;;
    --out)   OUT="$2";   shift 2;;
    --) shift; break;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done
CLI_ARGS=("$@")

for v in ARM_A ARM_B VAULT NOTE; do
  [[ -n "${!v}" ]] || { echo "missing --$(echo "$v" | tr 'A-Z_' 'a-z-')" >&2; exit 2; }
done
for d in "$ARM_A" "$ARM_B"; do
  [[ -f "$d/tools/llm-wiki-cli/run-llm-wiki.mjs" ]] || {
    echo "no CLI at $d/tools/llm-wiki-cli/ -- is this a plugin checkout with deps installed?" >&2
    exit 2; }
  [[ -d "$d/node_modules" ]] || {
    echo "$d has no node_modules -- a git worktree does not inherit them" >&2; exit 2; }
done
[[ -f "$VAULT/$NOTE" ]] || { echo "no note at $VAULT/$NOTE" >&2; exit 2; }
[[ "$DRAWS" =~ ^[0-9]+$ && "$DRAWS" -gt 0 ]] || { echo "--draws must be a positive integer" >&2; exit 2; }

: > "$OUT"
self="${BASH_SOURCE[0]}"; selfdir="$(cd "$(dirname "$self")" && pwd)"
probe_rev="$(git -C "$selfdir" rev-parse --short HEAD 2>/dev/null || echo '?')"
[[ -n "$(git -C "$selfdir" status --porcelain -- "$self" 2>/dev/null)" ]] && probe_rev="${probe_rev}+dirty"
echo "# llm-wiki-measure · $(basename "$self") · ${probe_rev} · $(date '+%Y-%m-%d %H:%M %z')" >&2
echo "arm a: $(git -C "$ARM_A" rev-parse --short HEAD 2>/dev/null || echo '?')  $ARM_A" >&2
echo "arm b: $(git -C "$ARM_B" rev-parse --short HEAD 2>/dev/null || echo '?')  $ARM_B" >&2
echo "note : $NOTE   draws: $DRAWS per arm, interleaved" >&2

for ((draw = 1; draw <= DRAWS; draw++)); do
  for arm in a b; do
    dir=$([[ $arm == a ]] && echo "$ARM_A" || echo "$ARM_B")
    start=$(date +%s)
    raw=$(cd "$dir" && WIKI_API_KEY=${WIKI_API_KEY:-unused} \
      node tools/llm-wiki-cli/run-llm-wiki.mjs ingest \
      --vault "$VAULT" --source "$NOTE" --extract-only --force \
      ${CLI_ARGS[@]+"${CLI_ARGS[@]}"} 2>&1)
    rc=$?
    end=$(date +%s)
    ent=$(printf '%s\n' "$raw" | grep -m1 '^  entity names'  | sed 's/^  entity names *//')
    con=$(printf '%s\n' "$raw" | grep -m1 '^  concept names' | sed 's/^  concept names *//')
    bat=$(printf '%s\n' "$raw" | grep -m1 'Total batches:'   | sed 's/.*Total batches: *//')
    fail=$(printf '%s\n' "$raw" | grep -c 'Call failed')
    head=$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo "")
    [[ $rc -ne 0 ]] && echo "  cli exited $rc -- see the draw's empty fields" >&2
    python3 -c '
import json,sys
print(json.dumps({"draw":int(sys.argv[1]),"arm":sys.argv[2],"head":sys.argv[3],
"sec":int(sys.argv[4]),"batches":sys.argv[5],"failed_calls":int(sys.argv[6]),
"cli_exit":int(sys.argv[9]),
"entities":[x.strip() for x in sys.argv[7].split(",") if x.strip()],
"concepts":[x.strip() for x in sys.argv[8].split(",") if x.strip()]},ensure_ascii=False))' \
      "$draw" "$arm" "$head" "$((end-start))" "$bat" "$fail" "$ent" "$con" "$rc" >> "$OUT"
    printf '[%s] draw %s arm %s  %ss  batches=%s failed=%s\n' \
      "$(date +%H:%M:%S)" "$draw" "$arm" "$((end-start))" "${bat:-?}" "$fail" >&2
  done
done
echo "done -> $OUT" >&2
echo >&2
echo "Before comparing arms, look at failed_calls and batches. A draw that lost a" >&2
echo "batch produced fewer names for a reason that has nothing to do with the arm." >&2
