# Phase 32: Frontend Rebuild - Context

**Gathered:** 2026-04-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Rebuild gsd-executor-frontend with a progressive generation pipeline, mandatory stack enforcement (React 19 + TypeScript strict + Tailwind CSS 4 + shadcn/ui), post-generation validation with self-correction loop, and Playwright screenshot verification at 3 breakpoints. The agent already has the 10-section format (Phase 31) and engineering standards (Phase 40) — this phase adds frontend-specific behavioral intelligence.

</domain>

<decisions>
## Implementation Decisions

### Progressive Pipeline (FRONT-01)
- This is BEHAVIORAL RULES TEXT, not enforced code. The agent follows it because its prompt says to — same mechanism as anti-over-engineering.
- Mandatory 4-pass sequence encoded in behavioral rules:
  1. Layout skeleton with placeholder sections
  2. Individual section components
  3. Interactive behaviors and state management
  4. Polish — animations, loading states, error boundaries
- Explicit refusal rule: "Never generate an entire page or multi-component layout in a single commit. Always decompose into the 4-pass sequence."
- If a user says "build me a dashboard in one file," the agent responds with a plan proposing 3-4 commits instead.

### Stack Refusal Behavior (FRONT-02)
- The agent WARNS AND ADAPTS — NOT a divergence report, NOT a hard block.
- For vanilla CSS in existing code: "This project uses vanilla CSS. I recommend migrating to Tailwind CSS 4 for consistency. Proceeding with Tailwind for new components. Existing vanilla CSS files will not be modified."
- For untyped JavaScript: "Converting to TypeScript with strict mode for type safety."
- Mixed codebases: new code uses the mandatory stack, existing code is left alone. The agent never rewrites existing CSS or JS files unless explicitly asked.

### Component Structure (FRONT-03)
- Directory structure: `components/ui/` (shadcn primitives), `components/` (composed), `app/` (routes)
- No component exceeds 200 lines — decompose if approaching limit
- Component-per-file convention

### State Decision Tree (FRONT-04)
- Local state → `useState`
- Shared UI state → Zustand
- Server/async state → TanStack Query
- URL state → search params
- Encoded as a decision tree in the agent's domain knowledge section

### Accessibility Baseline (FRONT-05)
- WCAG 2.1 AA baseline: semantic HTML, ARIA, keyboard nav, focus management, contrast
- `eslint-plugin-jsx-a11y` must produce 0 errors
- Encoded in behavioral rules

### Validation Pipeline (FRONT-06)
- Self-correction loop runs INSIDE the agent's E-phase, not a separate step
- Flow: generate code → run `tsc --noEmit` + ESLint + a11y lint → if errors, read output → fix → rerun
- Iteration count tracked via TodoWrite pattern (simple counter in working notes)
- After 3 failed iterations: partial delivery with divergence report listing remaining errors
- The agent NEVER silently ignores type errors or lint failures
- Final commit message includes `VERIFICATION: {tsc: pass|fail, eslint: pass|fail, a11y: pass|fail, iterations: N}`

### Playwright Screenshots (FRONT-07)
- The agent runs Playwright ITSELF during T-phase
- Dev server: agent starts `npx vite preview` or `npx next start` on a random port, captures screenshots, then kills the server
- Screenshots STORED for future comparison — NOT diffed automatically (visual regression diffing is v3.1 scope)
- Screenshots serve as documentation and manual verification baseline
- Breakpoints: 375px (mobile), 768px (tablet), 1440px (desktop)
- Stored in `tests/screenshots/`
- If Playwright is not installed: skip screenshots with warning (graceful degradation, same pattern as security tools in Phase 34)

### shadcn/ui Component Registry
- Agent's domain knowledge includes the list of available shadcn/ui components (Button, Card, Dialog, Input, Select, Table, Tabs, Toast, etc.) so it doesn't hallucinate non-existent components
- Installation pattern: `npx shadcn@latest add [component]` — agent runs this to add components rather than writing from scratch

### React 19 Awareness
- Agent knows React 19 features: `use()` hook for promises, Server Components (but only generates client components unless project is confirmed Next.js), improved ref handling, no more `forwardRef` needed
- Agent does NOT use experimental or canary React APIs

### Tailwind CSS 4 Awareness
- Agent knows Tailwind 4 uses CSS-first configuration (no more `tailwind.config.js` in most cases)
- `@import "tailwindcss"` instead of `@tailwind` directives
- New color opacity syntax
- Agent generates Tailwind 4 code, not Tailwind 3

### Few-Shot Examples Strategy
- The 3-4 examples in the agent file should demonstrate:
  (a) Simple component: Button with variants (shadcn/ui usage + TypeScript props)
  (b) Data display: Table with sorting (TanStack Query + Zustand state)
  (c) Form: Multi-field form with validation (React Hook Form + Zod + accessibility)
  (d) Layout: Dashboard skeleton with sidebar + header (demonstrates progressive generation — shows 4-pass output)

### Claude's Discretion
- Exact wording of behavioral rules (meaning must be preserved)
- How the validation loop counter is implemented in TodoWrite
- Playwright dev server port selection strategy
- shadcn/ui component list completeness (can add more components beyond the core list)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Agent Format
- `agents/gsd-executor-frontend.md` — Current agent file to be rebuilt (10-section format from Phase 31, engineering standards from Phase 40)
- `agents/shared/security-rules.md` — Security rules that must remain intact after rebuild
- `agents/shared/engineering-standards.md` — Engineering standards that must remain intact after rebuild

### Prior Art (same pattern phases)
- `.planning/phases/31-format-standard/31-CONTEXT.md` — Phase 31 format decisions (10-section structure is locked)
- `.planning/phases/34-security-pipeline/34-CONTEXT.md` — Phase 34 pattern for agent behavioral embedding + test verification
- `.planning/phases/40-engineering-standards/40-CONTEXT.md` — Phase 40 pattern for shared rules + agent embedding + tests

### Requirements
- `.planning/REQUIREMENTS.md` — FRONT-01 through FRONT-07 definitions

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `agents/gsd-executor-frontend.md` — Already has 10-section format, engineering standards, security rules. Rebuild modifies domain knowledge, behavioral rules, and examples sections while preserving structure.
- `agents/shared/security-rules.md` — 12 rules, must remain verbatim in rebuilt agent
- `agents/shared/engineering-standards.md` — 17 rules across 5 categories, must remain verbatim

### Established Patterns
- Phase 31/34/40 pattern: shared source-of-truth file + verbatim copy in agents + diff-verification tests
- Phase 34 pattern: graceful degradation when tools unavailable (Playwright screenshot skip mirrors gitleaks/trivy skip)
- Test pattern: unit tests for rule presence + integration tests for behavioral verification + regression gate

### Integration Points
- The rebuilt agent is consumed by `execute-phase.md` workflow when it routes `.tsx/.jsx/.css` files to `gsd-executor-frontend`
- Engineering standards (Phase 40) and security rules (Phase 34) must survive the rebuild — tests from those phases serve as regression gates

</code_context>

<specifics>
## Specific Ideas

- The progressive pipeline is behavioral, not mechanical — same enforcement mechanism as "Do not add features beyond what was explicitly requested"
- Stack refusal is adaptive (warn + proceed with mandatory stack), not blocking (no divergence reports for stack mismatch)
- Validation loop is internal to E-phase, not a separate workflow step
- Playwright screenshots are stored-only in v3.0 — visual regression diffing is explicitly v3.1 scope
- Few-shot examples should demonstrate the full stack: shadcn/ui + TypeScript + Tailwind 4 + TanStack Query + Zustand + React Hook Form + Zod

</specifics>

<deferred>
## Deferred Ideas

- Visual regression diffing (Playwright screenshot comparison) — v3.1 scope
- Server Component generation (beyond client components) — requires confirmed Next.js project detection

</deferred>

---

*Phase: 32-frontend-rebuild*
*Context gathered: 2026-04-13*
