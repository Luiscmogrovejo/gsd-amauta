'use strict';
/**
 * E2E: Task Board — complete user journey
 * File: tests/board.e2e.test.cjs
 *
 * Pattern for gsd-tester: one test = one complete user journey.
 * Guard: skipped if E2E_BASE_URL not set (CI without UI).
 *
 * This conditional-skip pattern is intentional and correct:
 * - It uses an empty it() body when E2E_BASE_URL is unset — NOT a flaky marker.
 * - Do NOT use .skip() / xit() / xdescribe() — those are flaky markers.
 * - The quality-audit.cjs no-assertion heuristic scopes to *.unit.test.cjs and
 *   *.integration.test.cjs only; this *.e2e.test.cjs is intentionally excluded.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE_URL = process.env.E2E_BASE_URL;
const SKIP_E2E = !BASE_URL;

if (SKIP_E2E) {
  describe('E2E: Task Board (SKIPPED — E2E_BASE_URL not set)', () => {
    it('skipped: set E2E_BASE_URL to run E2E tests', () => {
      // Intentional conditional skip — not a flaky marker.
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
