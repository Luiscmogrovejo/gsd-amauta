version: "1.0.0"
reference_type: runtime-read
scope: gsd-executor-mobile-android, gsd-executor-mobile-ios, gsd-executor-mobile-cross, gsd-executor-wearables, operator

# Mobile & Wearable Build Loops (MOBL-01..04)

**Purpose:** Document the operational build/test/verify loops the mobile and
wearable specialist executors use, the exact pinned tool versions, the
allowlisted commands, the opt-in device-control flag, capability-detection
branching, and the secrets-scrub guarantee that protects evidence captured
from these loops.

---

## 1. Two native workstreams, no unified abstraction

iOS/watchOS and Android/Wear OS are handled as **two separate, native
workstreams** — there is deliberately NO shared/unified mobile-build
abstraction layer. This is a locked anti-feature, not an oversight: Xcode's
build/test/simulator model and Gradle's build/test/lint model do not share
enough surface to make a unifying abstraction worth its own maintenance cost
and failure modes. Each workstream below is independently pinned, independently
gated by capability detection, and independently documented so an executor
only needs to reason about the platform it is actually building for.

---

## 2. iOS/watchOS loop

- **MCP server:** `xcodebuildmcp@2.6.2` (exact pin), registered via
  `npx -y xcodebuildmcp@2.6.2 mcp` in the `mcpServers` block (same
  registration shape as gsd-amauta's own MCP server — see `bin/install.js`
  ~L2619). Registration is **gated on the mobile executors being installed**
  (a readdir check for `gsd-executor-mobile-ios`/`gsd-executor-wearables`) —
  it is config-only, NOT a `package.json` dependency.
  Catalog entry: `xcodebuildmcp-server`.
- **Fallback:** raw `xcodebuild` / `xcrun simctl` — the
  `xcodebuild-ios-cli` catalog entry — remains the simulator-only,
  no-signing fallback loop when the MCP server is unavailable or not yet
  registered. This is the loop `gsd-executor-mobile-ios` already documents
  under its "xcodebuild CLI Loop (Build + Unit Test Only, No Signing)"
  section: `xcodebuild -list`, `xcodebuild -scheme <Scheme> -destination
  'platform=iOS Simulator,name=<Device>' build`, and `xcodebuild test
  -scheme <Scheme> -destination 'platform=iOS Simulator,name=<Device>'
  -only-testing:<Target>`.
- **Wearables:** watchOS builds/tests use the same simulator-based loop
  (watchOS destinations via `xcrun simctl`), with no separate wearables-only
  tool — `gsd-executor-wearables` consumes this identical iOS/watchOS loop.

---

## 3. Android/Wear OS loop

Plain allowlisted Bash — no Gradle MCP server. This is a deliberate choice:
Gradle's CLI is already fully scriptable, none of the surveyed Gradle-specific
MCP servers are mature enough to recommend, and a `Bash`-tool-allowlist entry
is simpler and more portable than adding an MCP layer with no capability gain.

Exact allowlisted commands, run against the **target repo's own** `./gradlew`
wrapper (never a global Gradle install, respecting the target's pinned
`gradle-wrapper.properties`):

```bash
./gradlew assembleDebug        # compile + package debug APK — proves the build
./gradlew testDebugUnitTest    # JVM unit tests (JUnit, etc.)
./gradlew lint                 # Android Lint — manifest, resources, API-level issues
```

Catalog entry: `gradlew-android-loop` is the Phase 67 hook allowlist source
for these three exact commands — no other `gradlew` targets are allowlisted
by default.

**Wear OS** builds/tests via AVD profiles targeting Wear OS system images —
same three `gradlew` commands, no separate Wear-specific tooling.

---

## 4. Device/emulator control (opt-in, experimental)

`@mobilenext/mobile-mcp` — pinned **exactly `0.0.61`** (pre-1.0, never a
floating "latest" tag in committed config; bump deliberately with a
changelog check) —
provides cross-platform device/emulator control (Android via ADB, iOS via
`simctl`) plus the **accessibility-tree snapshots** that are the validator's
deterministic mobile-UAT ground truth (see `mobile-uat-checklist.md`).

This tool is **experimental and opt-in only**: enabled via the
`--enable-mobile-mcp` flag (or `GSD_MOBILE_MCP=on`). It is not registered or
consulted by default — the build/lint/unit-test loops above run without it.
Catalog entry: `mobile-mcp-server`.

---

## 5. Capability branching (full / degraded / absent)

Every loop above consults capability detection FIRST:

```bash
python3 services/mobile_toolchain.py --json
```

This reports one of three frozen outcomes per platform:

- **`full`** — the platform's toolchain (Xcode + bootable simulator for iOS;
  Android SDK + AVD + acceleration for Android) is fully present. The loop
  runs unrestricted, including UAT capture.
- **`degraded`** — the toolchain is partially present (e.g., Xcode installed
  but no bootable simulator; Android SDK present but zero AVDs/no
  acceleration). The loop degrades to **compile + unit-test only**
  (`assembleDebug`/`testDebugUnitTest`/`lint` or `xcodebuild build`/`test`
  against whatever IS reachable) with a **named, visible `skip_reason`**
  surfaced in task evidence.
- **`absent`** — the toolchain is not present at all (e.g., non-Darwin
  platform for the iOS loop, no `ANDROID_HOME` for the Android loop). The
  loop is skipped entirely with a named `skip_reason`.

The machine is **never treated as broken** for landing in `degraded` or
`absent` — those are expected, visible outcomes, not failures. A loop must
NEVER fail-as-broken because a simulator/AVD is missing; it must degrade or
skip with the reason named in evidence.

---

## 6. Secrets guarantee (build-log/evidence scrub)

Gradle and Xcode build/test output frequently contains secrets: signing
identities, provisioning profiles, keystore passwords, API tokens. All
evidence captured from these loops (build logs, RPETD content, task evidence,
memory) is scrubbed at ingestion (MOBL-04) before it lands anywhere durable.
Scrubbed values are replaced with `[scrubbed:<name>]` markers — a marker
appearing in build-loop evidence is expected, redacted content, not corruption
or a missing-data failure.

Catalog entries carrying secret-bearing output in scope: `xcodebuildmcp-server`
(signing identities, provisioning profiles), `gradlew-android-loop` (keystore
passwords, signing configs), and `mobile-mcp-server` (device-session tokens
where applicable).

---

## 7. Cross-link

For validator-facing ground truth on what counts as passing mobile-UAT
evidence (accessibility-tree diffs as the only hard gate; pixel/screenshot
checks as advisory-only; the degraded-path evidence contract), see
[`mobile-uat-checklist.md`](mobile-uat-checklist.md).
