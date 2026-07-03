---
version: "1.0"
reference_type: contract
scope: telemetry
---

# Telemetry Event Taxonomy — Phase 62 (TEL-02)

> Runtime Read. This is the versioned contract for GSD's opt-in local
> telemetry framework. It is consumed by Phase 63 (POS-02 RPETD compliance
> scorecard) and Phase 71 (OBS-01..03 observability layer). Do not rename or
> remove any envelope key, event type, or payload field without bumping the
> major `version:` header and documenting a migration note (see
> "schema_version governance" below).

---

## 1. Envelope

Every emitted event is exactly this 6-key envelope — no more, no fewer keys
at the top level:

| Key | Type | Description |
|-----|------|-------------|
| `schema_version` | string | Currently `"1.0"`. Governs the shape of the envelope and per-type payloads. |
| `event_id` | string (uuid4) | Unique id for this event, generated via `crypto.randomUUID()`. |
| `event_type` | string | One of the 8 frozen `EVENT_TYPES` (section 2). |
| `ts` | string (ISO-8601 UTC) | Event creation time, `new Date().toISOString()`. |
| `project_hash` | string (16 hex chars) | `sha256(salt + repo_basename).slice(0,16)` — see below. NEVER the raw repo/project name. |
| `payload` | object | Per-type metadata-only body. See section 2. |

**`project_hash` definition:** first 16 hex characters of
`sha256(<telemetry.salt> + <repo basename>)`. The salt is a random 16-hex
value generated once at first consent and stored in
`.planning/config.json`'s `telemetry.salt` key. Without the salt, the raw
repo basename could be reversed by dictionary/rainbow-table attack against
the hash; the salt makes that infeasible while keeping the hash stable
per-project across runs (same salt + same repo = same hash every time).

---

## 2. Event types

All 8 members of the frozen `EVENT_TYPES` array
(`get-shit-done/bin/lib/telemetry.cjs`). Each type below lists its
`payload` shape — the envelope's other 5 keys are identical across all
types (section 1).

### `phase_start`

| Field | Type | Notes |
|-------|------|-------|
| `phase` | string | The phase number/id being started (e.g. `"62"`). |

### `phase_complete`

| Field | Type | Notes |
|-------|------|-------|
| `phase` | string | The phase number/id that completed. |

### `validator_verdict`

| Field | Type | Notes |
|-------|------|-------|
| `task_id` | string | The task id being validated. |
| `verdict` | string | One of `"pass"`, `"fail"`, `"gaps"`. |
| `gate_failures` | int | Count of failed validation gates (0 when not on the gate-failure path). |
| `gaps` | int | Count of gap findings (0 when not on the gaps-found path). |

### `divergence_filed`

| Field | Type | Notes |
|-------|------|-------|
| `divergence_type` | string | e.g. `"plan_amauta_drift"`, `"agent_assignment_conflict"`. |
| `diff_count` | int | COUNT of diffs/conflicts at the construction site. **NEVER the diffs array itself** — diffs may contain file paths, plan values, or agent names. |

### `divergence_resolved` — RESERVED

| Field | Type | Notes |
|-------|------|-------|
| `divergence_type` | string | Same enum as `divergence_filed`. |
| `resolution` | string | The orchestrator's chosen reconciliation (`re-route`, `re-plan`, `expand scope`, `halt phase`). |

**RESERVED:** this event type is part of the frozen `EVENT_TYPES` schema and
is documented here for forward compatibility, but it has NO current writer
surface. There is no wiring in `gsd-tools.cjs` or `gsd-amauta.cjs` today —
do not emit it ad hoc from an unrelated call site. It will be wired when a
genuine resolution surface exists (tracked for Phase 63/67, where the
orchestrator's `orchestrator_response` decision becomes a first-class,
consumable event).

### `escalation_fired`

| Field | Type | Notes |
|-------|------|-------|
| `task_id` | string | The task id being re-scored. |
| `workflow` | string \| null | The workflow name (e.g. `"execute-phase"`), or `null` when not supplied. |

### `party_session`

| Field | Type | Notes |
|-------|------|-------|
| `session_id` | string | The party-mode session identifier. |
| `participants_count` | int | Count of participating agents. |

### `error_class`

| Field | Type | Notes |
|-------|------|-------|
| `error_class` | string | The error's constructor name (e.g. `"TypeError"`), never the message. |
| `code` | string \| null | `err.code` when present (e.g. Node's `ENOENT`), else `null`. |
| `verb` | string \| null | The CLI verb being run (`process.argv[2]`) when the fatal fired. |

---

## 3. Emit-point map

Where each event is wired into the existing surfaces (verified at Phase 62
Wave 2 against `gsd-tools.cjs` / `gsd-amauta.cjs` HEAD).

| Event | File | Anchor symbol |
|-------|------|---------------|
| `phase_start` | `gsd-tools.cjs` | `case 'execute-phase':` inside the `init` dispatch |
| `phase_complete` | `gsd-tools.cjs` | `case 'phase'` → `subcommand === 'complete'` → `phase.cmdPhaseComplete` |
| `escalation_fired` | `gsd-tools.cjs` | `case 'complexity-escalate':` |
| `divergence_filed` | `gsd-tools.cjs` | the `divergence_type:` construction sites in `_diffPlanVsAmauta` and `planToTasks` (`plan_amauta_drift`, `agent_assignment_conflict`) |
| `validator_verdict` | `gsd-amauta.cjs` | `cmdValidate` — gaps path (returns 2), gate-failure path (returns 1), pass/fail outcome path (daemon + direct branches) |
| `error_class` | `gsd-amauta.cjs` | `main().catch` FATAL handler |
| `party_session` | `services/party_session.py` | `def create` — delivered by plan 62-03 |
| `divergence_resolved` | — | RESERVED — no current writer surface; wired when a resolution surface exists (Phase 63/67) |

---

## 4. Privacy policy (banned content)

Payloads NEVER contain any of the following. This is non-negotiable and
enforced at every emit call site:

- File contents.
- File paths (of any kind — plan paths, source paths, report paths).
- Prompts or prompt fragments.
- Memory text (agent-memory content, learnings text bodies).
- Secrets (tokens, keys, credentials).
- Error messages (`err.message`) — only the error CLASS/constructor name
  and `err.code` are ever sent.
- Gate text, evidence text, or validation notes — only counts and verdict
  enums.
- Diff bodies / diffs arrays — only diff COUNTS.
- Raw project or user names — only the salted `project_hash`.

Every payload field is metadata: an id, a type/enum, a count, a duration,
or an error class. If a field would require sending free text, it is
banned from the payload — never emit it "for debugging," even
conditionally.

---

## 5. `schema_version` governance

- **Additive, optional payload field:** stay on the current major (`1.x`)
  and document the new field in this file's per-type table. Consumers must
  treat unknown/missing optional fields gracefully.
- **Rename, removal, or semantic change** of any envelope key or payload
  field: bump the major version (e.g. `1.0` → `2.0`), update the `version:`
  frontmatter header of this file, and add a migration note here describing
  what changed and why.
- **Consumers pin on major version.** Phase 63's POS-02 scorecard and Phase
  71's OBS-01..03 read `schema_version` and MUST reject/skip events whose
  major version they were not built against, rather than guessing at a
  changed shape.

---

## 6. Consumers

- **Phase 63 (POS-02)** — RPETD compliance scorecard. Consumes
  `validator_verdict` and `phase_start`/`phase_complete` events to compute
  pass/fail/gaps rates per phase.
- **Phase 71 (OBS-01..03)** — observability layer (OTel GenAI spans,
  Langfuse sink, token/cost dashboards) built ON TOP of this framework; NOT
  part of Phase 62's scope.
- **Flush-sink body shape** — the wire format `telemetry flush` POSTs to
  `telemetry.sink_url`:

  ```json
  {
    "schema_version": "1.0",
    "events": [ /* array of envelope objects, section 1 */ ]
  }
  ```

  Consumers of the sink endpoint should validate `schema_version` on the
  outer body the same way per-event consumers validate it on each envelope.
