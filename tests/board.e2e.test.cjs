'use strict';
/**
 * E2E: Task Board — complete user journey
 * File: tests/board.e2e.test.cjs
 *
 * Pattern for gsd-tester: one test = one complete user journey.
 * Guard: skipped if E2E_BASE_URL not set (CI without UI).
 *
 * Phase 88 plan 88-16-02: the empty `it()` body this file used when
 * E2E_BASE_URL was unset reported a PASS without running anything, so the
 * journey's absence was invisible in every count. It is now a real
 * `{ skip: … }` with the reason it always had. `.skip()` / `xit()` /
 * `xdescribe()` remain forbidden — a declarative `{ skip: reason }` is counted
 * by the runner and by plan 88-19's gate, which is the whole point.
 * (The quality-audit.cjs no-assertion heuristic scopes to *.unit.test.cjs and
 * *.integration.test.cjs only; this *.e2e.test.cjs is outside it either way.)
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE_URL = process.env.E2E_BASE_URL;
const SKIP_E2E = !BASE_URL;
/** The named reason the counted skip carries when no board UI was published. */
const BOARD_SKIP =
  'E2E_BASE_URL is not set: this journey drives a real browser (Playwright) ' +
  'against a published Task Board UI, which the fixture daemon does not serve';

if (SKIP_E2E) {
  describe('E2E: Task Board', () => {
    it('create and complete task journey', { skip: BOARD_SKIP }, () => {
      // Run with: E2E_BASE_URL=http://localhost:3000 node --test tests/board.e2e.test.cjs
    });
  });
} else {
  // Only import playwright when E2E_BASE_URL is set
  const { chromium } = require('@playwright/test');
  const { TaskBoardPage } = require('./pages/TaskBoardPage.js');

  describe('E2E: Task Board — create and complete task journey', () => {
    let browser, page, boardPage;

    before(async () => {
      browser = await chromium.launch();
      page = await browser.newPage();
      boardPage = new TaskBoardPage(page);
    });

    after(async () => {
      if (browser) await browser.close();
    });

    it('complete journey: navigate → create task → verify → mark done → verify status', async () => {
      // Step 1: Navigate to board
      await boardPage.navigate(BASE_URL);

      // Step 2: Create a task with unique title
      const taskTitle = `E2E-TEST-${Date.now()}`;
      await boardPage.createTask(taskTitle);

      // Step 3: Verify task appears in the active list
      const titles = await boardPage.getTaskTitles();
      assert.ok(titles.includes(taskTitle), `Task "${taskTitle}" not in board after creation`);

      // Step 4: Mark the task done
      await boardPage.markTaskDone(taskTitle);

      // Step 5: Verify task is no longer in the active list
      const activeTitles = await boardPage.getTaskTitles();
      assert.ok(!activeTitles.includes(taskTitle), `Task "${taskTitle}" still in active list after marking done`);
    });
  });
}
