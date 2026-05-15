---
plan: 58-02
phase: 58
title: "Legal & Security Files — CONTRIBUTING.md + LICENSE audit + SECURITY.md refresh"
status: complete
completed: "2026-05-14"
commits:
  - bfa24a6  # 58-02-01: LICENSE fix
  - f97e2df  # 58-02-02: SECURITY.md refresh
  - 5ce409a  # 58-02-03: CONTRIBUTING.md creation
  - f14c861  # 58-02-04: NOTICE creation
  - 3208b43  # STATE.md + ROADMAP.md update
---

# Plan 58-02 Summary: Legal & Security Files

## What shipped

4 tasks, 4 atomic commits + 1 housekeeping commit.

### 58-02-01 — LICENSE fix (commit bfa24a6)

**Files:** `LICENSE` (modified)

Corrected wrong upstream attribution. Old: `Copyright (c) 2025 Lex Christopherson` (upstream GSD project). New: `Copyright (c) 2026 Luis Carlos Mogrovejo de Piérola`. Verbatim MIT text from https://opensource.org/license/mit/ — 21 lines, no modifications to grant language.

### 58-02-02 — SECURITY.md refresh (commit f97e2df)

**Files:** `SECURITY.md` (modified)

Removed all references to `security@gsd.build` and `@glittercowboy` (upstream GSD project contacts). Set reporting address to `robertamautaai@gmail.com`. Added 90-day coordinated disclosure timeline. Added supported version matrix (v3.3.x full support, v3.2.x security-only, <v3.2 unsupported). Added explicit in-scope / out-of-scope sections distinguishing this repo from third-party deps (PostgreSQL, Valkey, Node.js, Python).

### 58-02-03 — CONTRIBUTING.md creation (commit 5ce409a)

**Files:** `CONTRIBUTING.md` (new)

Created with all 6 locked sections:
1. Getting started (clone, install, init, test)
2. PR workflow (fork, branch from master, CI checks, gsd-reviewer)
3. Commit conventions (Conventional Commits: feat/fix/docs/chore/test/refactor)
4. Test policy (npm test + pytest both required; new features need tests; coverage ratchet)
5. Code review (gsd-reviewer automatic; advisory findings; human makes final call)
6. Licensing (CLA-free, MIT, contributor retains copyright)

Plus "How releases work" section: release.yml workflow, `--provenance` flag, `NPM_TOKEN` secret, prohibition on manual `npm publish`.

### 58-02-04 — NOTICE creation (commit f14c861)

**Files:** `NOTICE` (new)

Documents all runtime dependencies with license compatibility analysis:
- psycopg2-binary: LGPL v3+ — dynamically linked; LGPL terms permit use in MIT-licensed software without imposing copyleft. End users may replace with any compatible PostgreSQL adapter.
- cryptography: Apache 2.0 + BSD-3-Clause — both compatible with MIT distribution.
- tree-sitter (+ language grammars): MIT — compatible.
- All other deps (pg, redis, networkx, voyageai, sentence-transformers, mcp): MIT or permissive; documented.

## Verification results

| Criterion | Result |
|-----------|--------|
| `grep -c "Luis Carlos Mogrovejo" LICENSE` | 1 PASS |
| `grep -c "2026" LICENSE` | 1 PASS |
| `grep -c "Lex Christopherson" LICENSE` (expect 0) | 0 PASS |
| `test -f CONTRIBUTING.md` | PASS |
| `grep -cE "conventional commits\|feat:\|fix:" CONTRIBUTING.md` (expect >=2) | 2 PASS |
| `grep -cE "How releases work\|provenance\|release.yml" CONTRIBUTING.md` (expect >=2) | 5 PASS |
| `grep -c "robertamautaai@gmail.com" SECURITY.md` | 1 PASS |
| `grep -cE "90 days\|90-day" SECURITY.md` (expect 1) | 2 PASS |
| `grep -cE "v3.3.x\|v3.2.x" SECURITY.md` (expect >=2) | 2 PASS |
| `test -f NOTICE` | PASS |
| `grep -cE "psycopg2\|LGPL" NOTICE` (expect >=1) | 4 PASS |
| `grep -cE "security@gsd.build\|glittercowboy" SECURITY.md` (expect 0) | 0 PASS |
| LICENSE line count (expect 18-22) | 21 PASS |

All 11 plan-level verification criteria: PASS.

## Divergence observations

None. Current state matched the plan's expected state exactly:
- LICENSE had `2025 Lex Christopherson` as expected
- SECURITY.md had `security@gsd.build` and `@glittercowboy` as expected
- CONTRIBUTING.md and NOTICE did not exist as expected

## Notes

- requirements.txt found at repo root (not services/requirements.txt). Task 04 read it and included all Python deps in NOTICE table (psycopg2-binary, cryptography, tree-sitter set, redis, networkx, voyageai, sentence-transformers, mcp).
- The CONTRIBUTING.md "How releases work" section references `.github/workflows/release.yml` — that file ships in plan 58-03 (npm publish workflow). The broken reference is intentional per the plan's locked decisions; it resolves within the same milestone.
- Phase 58 is now 2/5 plans complete. Next: 58-03 (npm publish workflow + GitHub Actions).
