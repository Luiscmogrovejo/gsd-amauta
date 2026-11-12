# Roadmap: Fixture agree

## Current State

Fixture roadmap: 4 phases, 4/4 v1 requirements mapped.

## Phases

- [x] **Phase 10: Alpha** — alpha work
- [x] **Phase 11: Beta** — beta work
- [x] **Phase 12: Gamma** — gamma work
- [ ] **Phase 13: Delta** — delta work

## Phase Details

### Phase 10: Alpha
**Goal:** Alpha works.
**Depends on:** Nothing
**Requirements**: FIX-01

### Phase 11: Beta
**Goal:** Beta works.
**Depends on:** Phase 10
**Requirements**: FIX-02

### Phase 12: Gamma
**Goal:** Gamma works.
**Depends on:** Phase 11
**Requirements**: FIX-03

### Phase 13: Delta
**Goal:** Delta works.
**Depends on:** Phase 12
**Requirements**: FIX-04

## Carried Test Obligations (the skip ledger)

Every entry in `tests/skip-exceptions.json` names an owning phase, and this table mirrors it.
The `Class id` column is the machine-readable key: it holds the `reason_class` label shared by
the entries a row covers, and `—` for a row that deliberately has no entries.

| Class id | Tests | Why they do not run yet | Owning phase |
|---|---|---|---|
| `fixture-pending` | Two tests in `tests/test_fixture.py` | The feature they need is built in phase 13 | Phase 13 |
| — | A test that runs both ways already | Nothing: it is listed so it is not forgotten | Phase 13 |

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 10. Alpha | 1/1 | Complete | 2026-01-01 |
| 11. Beta | 1/1 | Complete | 2026-01-01 |
| 12. Gamma | 1/1 | Complete | 2026-01-01 |
| 13. Delta | 0/TBD | Not started | - |
