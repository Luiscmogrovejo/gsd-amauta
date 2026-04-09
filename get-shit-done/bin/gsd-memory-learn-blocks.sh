#!/usr/bin/env bash
#
# gsd-memory-learn-blocks.sh — Phase 10 LEARN-02 helper
#
# Parses a D-phase content blob containing one or more structured LEARNING
# blocks (`LEARNING: ...` followed by indented WHAT/WHY/WHEN/CATEGORY/TAGS
# lines), then stores each block via `gsd-memory learn --structured`.
#
# Usage:
#   gsd-memory-learn-blocks.sh "<d_phase_text>"
#   echo "<d_phase_text>" | gsd-memory-learn-blocks.sh -
#
# Honors GSD_D_STRUCTURED=false kill switch by short-circuiting to exit 0
# (the caller falls through to the legacy `$MEM learn` path).
#
# Environment:
#   MEM        — path to gsd-memory.cjs (default: auto-detect)
#   GSD_AGENT  — agent name stored with the learning (default: operator)

set -euo pipefail

# Kill switch — the caller should also check, but defense in depth
if [ "${GSD_D_STRUCTURED:-true}" = "false" ]; then
  printf 'gsd-memory-learn-blocks: GSD_D_STRUCTURED=false — no-op\n' >&2
  exit 0
fi

# Resolve MEM binary (matches cli-variables.md fallback pattern)
MEM_BIN="${MEM:-node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-memory.cjs}"
AGENT="${GSD_AGENT:-operator}"

# Accept input via stdin ("-") or positional arg
if [ "${1:-}" = "-" ]; then
  D_CONTENT="$(cat)"
elif [ -n "${1:-}" ]; then
  D_CONTENT="$1"
else
  printf 'Usage: gsd-memory-learn-blocks.sh "<d_phase_text>" | -\n' >&2
  exit 1
fi

# Short-circuit if no structured block present (no `  WHAT:` indented line)
if ! printf '%s' "$D_CONTENT" | grep -q '^  WHAT:'; then
  printf 'gsd-memory-learn-blocks: no structured block detected, skipping\n' >&2
  exit 0
fi

# Delegate parsing to gsd-memory.cjs parse-learning subcommand
PARSED_JSON="$($MEM_BIN parse-learning "$D_CONTENT" 2>/dev/null || true)"
if [ -z "$PARSED_JSON" ]; then
  printf 'gsd-memory-learn-blocks: parse-learning returned empty output\n' >&2
  exit 0
fi

# Iterate each block via a small node filter that reads the parse-learning
# JSON from stdin and prints one shell-quoted `learn --structured` command
# per block. The parent shell then evals each line.
printf '%s' "$PARSED_JSON" | node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf-8"));
  if (!data || !data.parsed || !Array.isArray(data.blocks)) process.exit(0);
  function q(s) { return "'"'"'" + String(s).replace(/'"'"'/g, "'"'"'\\'"'"''"'"'") + "'"'"'"; }
  for (const b of data.blocks) {
    if (!b || b.parse_failed || !b.what) continue;
    const parts = ["learn", "--structured"];
    parts.push("--what", q(b.what));
    if (b.why)      parts.push("--why",      q(b.why));
    if (b.when)     parts.push("--when",     q(b.when));
    if (b.category) parts.push("--category", q(b.category));
    if (b.tags && b.tags.length) parts.push("--tags", q(b.tags.join(",")));
    process.stdout.write(parts.join(" ") + "\n");
  }
' | while IFS= read -r cmd; do
  [ -z "$cmd" ] && continue
  # shellcheck disable=SC2086
  eval "$MEM_BIN $cmd --agent $AGENT" || printf 'gsd-memory-learn-blocks: store failed for block\n' >&2
done

exit 0
