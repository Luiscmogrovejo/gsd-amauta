version: "1.0.0"
reference_type: runtime-read
scope: gsd-validator (mobile-domain tasks)

# Mobile-UAT Checklist (MOBL-05)

**Purpose:** Define the validator's mobile-UAT ground truth. Accessibility-tree
snapshots are the deterministic, hard-gate-eligible artifact. Pixel/screenshot
comparisons are advisory only. This distinction exists to avoid pitfall 12
(flaky-UI-tests-as-gates) — pixel diffs break on font rendering, anti-aliasing,
and OS chrome changes that have nothing to do with correctness; accessibility
trees do not.

---

## 1. Ground truth rule (normative)

> **Accessibility-tree snapshots (structured element lists captured via
> `mobile-mcp-server`, pinned exactly `0.0.61`) are THE deterministic
> mobile-UAT artifact. They are diffable, assertable, and the ONLY artifact a
> validator may build a hard gate on.**
>
> **Pixel/screenshot comparisons are ADVISORY ONLY.** A screenshot diff may be
> attached as supporting evidence and may prompt a human look, but a
> screenshot diff alone can NEVER fail a task. This is a hard rule, not a
> suggestion — treating a screenshot mismatch as a gating failure by itself is
> an invalid verdict. Rationale: pixel comparisons are non-deterministic
> across simulator OS versions, font rendering, animation timing, and
> anti-aliasing — using them as a hard gate reproduces the named pitfall 12
> (flaky-UI-tests-as-gates), where a test's pass/fail signal decorrelates
> from the correctness question it claims to answer. Accessibility-tree
> element identity/hierarchy/labels/state do not have this problem: they are
> structural, not rendered, so a diff on them is a diff on behavior.

Consequence: a validator MUST NOT record a `--fail` verdict on the sole basis
of "screenshot diff failed" or "pixel comparison mismatch." Those findings are
recorded as advisory notes, not gate failures.

---

## 2. Capture procedure

Per platform, evidence is captured via `mobile-mcp-server` structured element
listings against a simulator/emulator — never against a live/physical device
by default (opt-in only, see `mobile-build-loops.md`).

- **Android / Wear OS:** `mobile-mcp-server` element listing against the
  emulator/AVD session under test.
- **iOS / watchOS:** `mobile-mcp-server` element listing against the
  Simulator session under test (complements, does not replace, the
  `xcodebuildmcp-server` build/test loop).

Storage and assertion rules:

- Store accessibility-tree snapshots as text/JSON files in task evidence —
  never as opaque binary blobs — so diffs are line-based and human-reviewable
  in a normal `git diff`/PR view.
- Assert on element **identity, hierarchy, labels, and state** (e.g., button
  `login_button` present, enabled, label `"Log In"`) — never on pixel
  coordinates or bounding boxes, which shift across screen sizes and OS
  versions without indicating a behavior change.
- Evidence passes through the MOBL-04 evidence scrub before it lands in task
  evidence/RPETD/memory. A validator that encounters a `[scrubbed:<name>]`
  marker inside a stored snapshot MUST treat it as expected, scrubbed content
  (a secret redaction), not as corruption or a missing-data failure.

---

## 3. Degraded-environment path

Capability detection (`python3 services/mobile_toolchain.py --json`) reports
one of the frozen outcomes: `full`, `degraded`, or `absent`. Mobile-UAT
evidence expectations key directly off this vocabulary:

- **`full`** — accessibility-tree snapshot capture is expected. Absence of a
  snapshot with no named skip reason is a real gap, not an accepted degraded
  state.
- **`degraded` / `absent`** — a live accessibility-tree snapshot is NOT
  required. Acceptable validation evidence instead is: (1) the environment's
  named `skip_reason` (e.g., "Xcode not installed", "no AVD configured"), and
  (2) compile + unit-test proof (the build and the JVM/XCTest unit-test
  loops still ran and passed). The UAT gate itself is recorded as
  **GT-pending**, never fabricated — GT-missing = GT-pending, not a
  fabricated pass and not a hard fail on the missing UI evidence.

A validator MUST NOT accept a fabricated or hand-waved "UI looks fine"
statement as a substitute for either a real snapshot or a named degraded
skip reason. If neither is present, that is a real gap in the task's
evidence, not a degraded-environment allowance.

---

## 4. Validator checklist

For any mobile task reaching validation, walk this list:

1. **Snapshot present?** Is there an accessibility-tree snapshot (text/JSON)
   in task evidence for the affected UI surface?
2. **Diff deterministic?** Is the snapshot diff based on element
   identity/hierarchy/labels/state — not pixel coordinates?
3. **Pixels only advisory?** If a screenshot/pixel comparison is present, is
   it recorded as advisory (never the sole basis for a `--fail`)?
4. **Degraded reason named?** If no snapshot exists, is there a named
   `skip_reason` from `full|degraded|absent` capability detection, plus
   compile+unit-test proof?
5. **Evidence scrubbed?** Does any `[scrubbed:<name>]` marker in the
   snapshot read as expected scrub output, not corruption?

If 1–3 hold, the UAT gate may pass. If 4 holds in place of 1–3, the UAT gate
is GT-pending, not failed. If none hold and no degraded reason is named,
that is a real gap — surface it, do not fabricate a pass.

---

*See also: [`mobile-build-loops.md`](mobile-build-loops.md) for the build/test
loops that produce the compile+unit-test proof referenced in Section 3.*
