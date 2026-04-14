'use strict';
/**
 * Phase 32 — Frontend Rebuild Unit Tests
 * File: tests/32-frontend-rebuild.unit.test.cjs
 *
 * Requirements covered:
 *   FRONT-01: Progressive generation pipeline
 *   FRONT-02: Mandatory stack enforcement
 *   FRONT-03: Component structure rules
 *   FRONT-04: State decision tree
 *   FRONT-05: Accessibility baseline
 *   FRONT-06: Post-generation validation loop
 *   FRONT-07: Playwright screenshot rules
 *
 * Also verifies regression for: FORMAT-01 (10 sections), FORMAT-03 (security rules),
 * FORMAT-04 (anti-over-engineering), FORMAT-05 (read-before-edit), ENG-01..05.
 *
 * Pure file-system reads only — no child processes, no network.
 * Uses node:test + node:assert/strict (no external test framework).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AGENT_FILE = path.join(ROOT, 'agents', 'gsd-executor-frontend.md');
const content = fs.readFileSync(AGENT_FILE, 'utf-8');

// ─── Group 1: Format preservation (FORMAT-01 regression — 6 assertions) ──────

describe('[FORMAT-01] gsd-executor-frontend.md: v3.0.0 10-section format', () => {
  it('[FORMAT] file exists', () => {
    assert.ok(
      fs.existsSync(AGENT_FILE),
      'agents/gsd-executor-frontend.md does not exist'
    );
  });

  it('[FORMAT] exactly 10 ## sections', () => {
    const count = (content.match(/^## /gm) || []).length;
    assert.strictEqual(count, 10, `Expected 10 ## sections, found ${count}`);
  });

  it('[FORMAT] version header: contains "## version: 3.0.0"', () => {
    assert.ok(content.includes('## version: 3.0.0'), 'Missing ## version: 3.0.0');
  });

  it('[FORMAT] CACHE_BREAKPOINT is the last non-empty line', () => {
    const lines = content.split('\n').filter(l => l.trim());
    assert.ok(
      lines[lines.length - 1].includes('CACHE_BREAKPOINT'),
      `Last non-empty line is not CACHE_BREAKPOINT: "${lines[lines.length - 1]}"`
    );
  });

  it('[FORMAT] frontmatter contains name: gsd-executor-frontend', () => {
    assert.ok(content.includes('name: gsd-executor-frontend'), 'Missing name: gsd-executor-frontend in frontmatter');
  });

  it('[FORMAT] all 9 required section headings present', () => {
    const requiredHeadings = [
      '## Role & identity',
      '## Domain knowledge',
      '## Behavioral rules',
      '## Tool access & guidance',
      '## Task management',
      '## Examples',
      '## Error handling',
      '## Security rules',
      '## Preconditions & constraints',
    ];
    for (const heading of requiredHeadings) {
      assert.ok(content.includes(heading), `Missing required section heading: "${heading}"`);
    }
  });
});

// ─── Group 2: FRONT-01 — Progressive Generation Pipeline (4 assertions) ───────

describe('[FRONT-01] Progressive Generation Pipeline', () => {
  it('[FRONT-01] contains "Progressive Generation Pipeline (FRONT-01)"', () => {
    assert.ok(
      content.includes('Progressive Generation Pipeline (FRONT-01)'),
      'Missing "Progressive Generation Pipeline (FRONT-01)"'
    );
  });

  it('[FRONT-01] contains "Never generate an entire page"', () => {
    assert.ok(
      content.includes('Never generate an entire page'),
      'Missing "Never generate an entire page"'
    );
  });

  it('[FRONT-01] contains "4-pass sequence" or "4-pass progressive generation"', () => {
    assert.ok(
      content.includes('4-pass sequence') || content.includes('4-pass progressive generation'),
      'Missing "4-pass sequence" or "4-pass progressive generation"'
    );
  });

  it('[FRONT-01] all 4 passes defined: Pass 1, Pass 2, Pass 3, Pass 4', () => {
    assert.ok(content.includes('Pass 1'), 'Missing "Pass 1"');
    assert.ok(content.includes('Pass 2'), 'Missing "Pass 2"');
    assert.ok(content.includes('Pass 3'), 'Missing "Pass 3"');
    assert.ok(content.includes('Pass 4'), 'Missing "Pass 4"');
  });
});

// ─── Group 3: FRONT-02 — Mandatory Stack Enforcement (6 assertions) ───────────

describe('[FRONT-02] Mandatory Stack Enforcement', () => {
  it('[FRONT-02] Domain knowledge subsection: "Mandatory Stack (FRONT-02)"', () => {
    assert.ok(
      content.includes('Mandatory Stack (FRONT-02)'),
      'Missing "Mandatory Stack (FRONT-02)" in Domain knowledge'
    );
  });

  it('[FRONT-02] Behavioral rules subsection: "Stack Enforcement (FRONT-02)"', () => {
    assert.ok(
      content.includes('Stack Enforcement (FRONT-02)'),
      'Missing "Stack Enforcement (FRONT-02)" in Behavioral rules'
    );
  });

  it('[FRONT-02] mandatory framework: "React 19"', () => {
    assert.ok(content.includes('React 19'), 'Missing "React 19"');
  });

  it('[FRONT-02] mandatory language: "TypeScript strict"', () => {
    assert.ok(
      content.includes('TypeScript strict') || content.includes('TypeScript strict mode'),
      'Missing "TypeScript strict" or "TypeScript strict mode"'
    );
  });

  it('[FRONT-02] mandatory styling: "Tailwind CSS 4"', () => {
    assert.ok(content.includes('Tailwind CSS 4'), 'Missing "Tailwind CSS 4"');
  });

  it('[FRONT-02] mandatory primitives: "shadcn/ui"', () => {
    assert.ok(content.includes('shadcn/ui'), 'Missing "shadcn/ui"');
  });
});

// ─── Group 4: FRONT-03 — Component Structure (4 assertions) ───────────────────

describe('[FRONT-03] Component Structure', () => {
  it('[FRONT-03] contains "Component Structure (FRONT-03)"', () => {
    assert.ok(
      content.includes('Component Structure (FRONT-03)'),
      'Missing "Component Structure (FRONT-03)"'
    );
  });

  it('[FRONT-03] shadcn primitives directory: "components/ui/"', () => {
    assert.ok(content.includes('components/ui/'), 'Missing "components/ui/"');
  });

  it('[FRONT-03] component size limit: "200 lines"', () => {
    assert.ok(content.includes('200 lines'), 'Missing "200 lines" component size limit');
  });

  it('[FRONT-03] installation pattern: "npx shadcn@latest add"', () => {
    assert.ok(content.includes('npx shadcn@latest add'), 'Missing "npx shadcn@latest add" installation pattern');
  });
});

// ─── Group 5: FRONT-04 — State Decision Tree (5 assertions) ───────────────────

describe('[FRONT-04] State Decision Tree', () => {
  it('[FRONT-04] contains "State Decision Tree (FRONT-04)"', () => {
    assert.ok(
      content.includes('State Decision Tree (FRONT-04)'),
      'Missing "State Decision Tree (FRONT-04)"'
    );
  });

  it('[FRONT-04] local state: "useState"', () => {
    assert.ok(content.includes('useState'), 'Missing "useState" for local state');
  });

  it('[FRONT-04] shared UI state: "Zustand"', () => {
    assert.ok(content.includes('Zustand'), 'Missing "Zustand" for shared UI state');
  });

  it('[FRONT-04] server/async state: "TanStack Query"', () => {
    assert.ok(content.includes('TanStack Query'), 'Missing "TanStack Query" for server/async state');
  });

  it('[FRONT-04] URL state: "useSearchParams" or "search params"', () => {
    assert.ok(
      content.includes('useSearchParams') || content.includes('search params'),
      'Missing "useSearchParams" or "search params" for URL state'
    );
  });
});

// ─── Group 6: FRONT-05 — Accessibility Baseline (5 assertions) ────────────────

describe('[FRONT-05] Accessibility Baseline', () => {
  it('[FRONT-05] contains "Accessibility Baseline (FRONT-05)"', () => {
    assert.ok(
      content.includes('Accessibility Baseline (FRONT-05)'),
      'Missing "Accessibility Baseline (FRONT-05)"'
    );
  });

  it('[FRONT-05] standard level: "WCAG 2.1 AA"', () => {
    assert.ok(content.includes('WCAG 2.1 AA'), 'Missing "WCAG 2.1 AA"');
  });

  it('[FRONT-05] semantic HTML: "Semantic HTML"', () => {
    assert.ok(
      content.includes('Semantic HTML'),
      'Missing "Semantic HTML" elements requirement'
    );
  });

  it('[FRONT-05] lint tool: "eslint-plugin-jsx-a11y"', () => {
    assert.ok(content.includes('eslint-plugin-jsx-a11y'), 'Missing "eslint-plugin-jsx-a11y"');
  });

  it('[FRONT-05] contrast ratio: "4.5:1"', () => {
    assert.ok(content.includes('4.5:1'), 'Missing "4.5:1" contrast ratio requirement');
  });
});

// ─── Group 7: FRONT-06 — Post-Generation Validation Loop (5 assertions) ────────

describe('[FRONT-06] Post-Generation Validation Loop', () => {
  it('[FRONT-06] contains "Post-Generation Validation Loop (FRONT-06)"', () => {
    assert.ok(
      content.includes('Post-Generation Validation Loop (FRONT-06)'),
      'Missing "Post-Generation Validation Loop (FRONT-06)"'
    );
  });

  it('[FRONT-06] TypeScript check: "tsc --noEmit"', () => {
    assert.ok(content.includes('tsc --noEmit'), 'Missing "tsc --noEmit"');
  });

  it('[FRONT-06] iteration cap: "Maximum 3 iterations"', () => {
    assert.ok(content.includes('Maximum 3 iterations'), 'Missing "Maximum 3 iterations" iteration cap');
  });

  it('[FRONT-06] commit message tag: "VERIFICATION:"', () => {
    assert.ok(content.includes('VERIFICATION:'), 'Missing "VERIFICATION:" commit message tag');
  });

  it('[FRONT-06] verification format: "tsc: pass" or "tsc: pass|fail"', () => {
    assert.ok(
      content.includes('tsc: pass|fail') || content.includes('tsc: pass'),
      'Missing "tsc: pass|fail" or "tsc: pass" verification format'
    );
  });
});

// ─── Group 8: FRONT-07 — Playwright Screenshots (5 assertions) ────────────────

describe('[FRONT-07] Playwright Screenshot Capture', () => {
  it('[FRONT-07] contains "Playwright Screenshot Capture (FRONT-07)"', () => {
    assert.ok(
      content.includes('Playwright Screenshot Capture (FRONT-07)'),
      'Missing "Playwright Screenshot Capture (FRONT-07)"'
    );
  });

  it('[FRONT-07] storage path: "tests/screenshots/"', () => {
    assert.ok(content.includes('tests/screenshots/'), 'Missing "tests/screenshots/" storage path');
  });

  it('[FRONT-07] mobile breakpoint: "375px"', () => {
    assert.ok(content.includes('375px'), 'Missing "375px" mobile breakpoint');
  });

  it('[FRONT-07] tablet breakpoint: "768px"', () => {
    assert.ok(content.includes('768px'), 'Missing "768px" tablet breakpoint');
  });

  it('[FRONT-07] desktop breakpoint: "1440px"', () => {
    assert.ok(content.includes('1440px'), 'Missing "1440px" desktop breakpoint');
  });
});

// ─── Group 9: Security rules preservation (4 assertions) ──────────────────────

describe('[FORMAT-03][SEC-04] Security rules preserved in gsd-executor-frontend.md', () => {
  it('[SEC-04] rule 1: "Parameterized SQL" present', () => {
    assert.ok(content.includes('Parameterized SQL'), 'Missing security rule: "Parameterized SQL"');
  });

  it('[SEC-04] rule 8: "npm ci" present (supply chain)', () => {
    assert.ok(content.includes('npm ci'), 'Missing supply chain rule: "npm ci"');
  });

  it('[SEC-04] rule 9: "Pin exact versions" present (supply chain)', () => {
    assert.ok(content.includes('Pin exact versions'), 'Missing supply chain rule: "Pin exact versions"');
  });

  it('[SEC-04] rule 12: "7 days ago" present (supply chain)', () => {
    assert.ok(content.includes('7 days ago'), 'Missing supply chain rule: "7 days ago"');
  });
});

// ─── Group 10: Engineering standards preservation (6 assertions) ───────────────

describe('[ENG-01..05] Engineering standards section preserved in gsd-executor-frontend.md', () => {
  it('[ENG] contains "### Engineering standards"', () => {
    assert.ok(content.includes('### Engineering standards'), 'Missing "### Engineering standards"');
  });

  it('[ENG-01] contains "#### Git workflow (ENG-01)"', () => {
    assert.ok(content.includes('#### Git workflow (ENG-01)'), 'Missing "#### Git workflow (ENG-01)"');
  });

  it('[ENG-02] contains "#### Error handling (ENG-02)"', () => {
    assert.ok(content.includes('#### Error handling (ENG-02)'), 'Missing "#### Error handling (ENG-02)"');
  });

  it('[ENG-03] contains "#### Documentation (ENG-03)"', () => {
    assert.ok(content.includes('#### Documentation (ENG-03)'), 'Missing "#### Documentation (ENG-03)"');
  });

  it('[ENG-04] contains "#### Configuration management (ENG-04)"', () => {
    assert.ok(
      content.includes('#### Configuration management (ENG-04)'),
      'Missing "#### Configuration management (ENG-04)"'
    );
  });

  it('[ENG-05] contains "#### Structured logging (ENG-05)"', () => {
    assert.ok(content.includes('#### Structured logging (ENG-05)'), 'Missing "#### Structured logging (ENG-05)"');
  });
});

// ─── Group 11: Preserved mandates (4 assertions) ──────────────────────────────

describe('[FORMAT-04][FORMAT-05][FORMAT-06] Preserved behavioral mandates', () => {
  it('[FORMAT-04] anti-over-engineering mandate verbatim', () => {
    assert.ok(
      content.includes(
        'Do not add features, refactor code, or make improvements beyond what was explicitly requested.'
      ),
      'Missing anti-over-engineering mandate'
    );
  });

  it('[FORMAT-05] read-before-edit mandate verbatim', () => {
    assert.ok(
      content.includes(
        'Always read a file completely before modifying it. Never edit a file based on assumptions about its contents.'
      ),
      'Missing read-before-edit mandate'
    );
  });

  it('[FORMAT-06] AGENTS.md constraint: "You CANNOT create or modify AGENTS.md files during execution."', () => {
    assert.ok(
      content.includes('You CANNOT create or modify AGENTS.md files during execution.'),
      'Missing AGENTS.md constraint'
    );
  });

  it('[FORMAT-06] divergence_report protocol referenced', () => {
    assert.ok(content.includes('divergence_report'), 'Missing divergence_report protocol reference');
  });
});

// ─── Group 12: Examples section (5 assertions) ────────────────────────────────

describe('[FORMAT-02] Examples: 4 examples, all component names present', () => {
  it('[FORMAT-02] file contains exactly 4 examples (bold "**Example" followed by number)', () => {
    // Count occurrences of "**Example" pattern that appears before component names
    const exampleMatches = content.match(/\*\*Example \d+:/g) || [];
    assert.strictEqual(exampleMatches.length, 4, `Expected 4 examples, found ${exampleMatches.length}`);
  });

  it('[FORMAT-02] Example 1: "StatusBadge" present', () => {
    assert.ok(content.includes('StatusBadge'), 'Missing StatusBadge (Example 1)');
  });

  it('[FORMAT-02] Example 2: "UserTable" present', () => {
    assert.ok(content.includes('UserTable'), 'Missing UserTable (Example 2)');
  });

  it('[FORMAT-02] Example 3: "ContactForm" present', () => {
    assert.ok(content.includes('ContactForm'), 'Missing ContactForm (Example 3)');
  });

  it('[FORMAT-02] Example 4: "DashboardLayout" present', () => {
    assert.ok(content.includes('DashboardLayout'), 'Missing DashboardLayout (Example 4)');
  });
});

// ─── Group 13: Domain knowledge enrichment (5 assertions) ─────────────────────

describe('[FRONT-02..04] Domain knowledge enrichment: registries + awareness sections', () => {
  it('[FRONT-02] "shadcn/ui Component Registry" subsection present', () => {
    assert.ok(
      content.includes('shadcn/ui Component Registry'),
      'Missing "shadcn/ui Component Registry" subsection'
    );
  });

  it('[FRONT-02] "React 19 Awareness" subsection present', () => {
    assert.ok(content.includes('React 19 Awareness'), 'Missing "React 19 Awareness" subsection');
  });

  it('[FRONT-02] "Tailwind CSS 4 Awareness" subsection present', () => {
    assert.ok(content.includes('Tailwind CSS 4 Awareness'), 'Missing "Tailwind CSS 4 Awareness" subsection');
  });

  it('[FRONT-02] Tailwind 4 CSS-first syntax: @import "tailwindcss"', () => {
    assert.ok(
      content.includes('@import "tailwindcss"') || content.includes("@import 'tailwindcss'"),
      'Missing Tailwind 4 CSS-first @import syntax'
    );
  });

  it('[FRONT-01] React 19 use() hook referenced', () => {
    assert.ok(
      content.includes('use()') || content.includes('use() hook'),
      'Missing React 19 "use()" hook reference'
    );
  });
});

// ─── Group 14: Role identity update (2 assertions) ────────────────────────────

describe('[FRONT-01][FRONT-02] Role & identity: updated for v3.0 rebuild', () => {
  it('[FRONT-01] Role & identity contains "progressive 4-pass pipeline"', () => {
    assert.ok(
      content.includes('progressive 4-pass pipeline'),
      'Role & identity missing "progressive 4-pass pipeline"'
    );
  });

  it('[FRONT-02] frontmatter description contains "React 19 + TypeScript strict + Tailwind CSS 4 + shadcn/ui"', () => {
    assert.ok(
      content.includes('React 19 + TypeScript strict + Tailwind CSS 4 + shadcn/ui'),
      'Frontmatter description missing "React 19 + TypeScript strict + Tailwind CSS 4 + shadcn/ui"'
    );
  });
});
