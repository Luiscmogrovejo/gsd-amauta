/**
 * Page Object Model: Task Board
 * Used by gsd-tester-generated E2E tests.
 * Pattern: one POM file per view/page.
 *
 * Selectors use data-testid attributes for stability — independent of
 * CSS class names or layout changes.
 */
'use strict';

class TaskBoardPage {
  constructor(page) {
    this.page = page;
    // Selectors — update when UI is implemented
    this.taskList = page.locator('[data-testid="task-list"]');
    this.createTaskButton = page.locator('[data-testid="create-task-btn"]');
    this.taskTitleInput = page.locator('[data-testid="task-title-input"]');
    this.submitButton = page.locator('[data-testid="submit-task-btn"]');
  }

  async navigate(baseUrl) {
    await this.page.goto(`${baseUrl}/board`);
    await this.page.waitForLoadState('networkidle');
  }

  async createTask(title) {
    await this.createTaskButton.click();
    await this.taskTitleInput.fill(title);
    await this.submitButton.click();
    await this.page.waitForResponse(resp => resp.url().includes('/api/') && resp.status() === 200);
  }

  async getTaskTitles() {
    return this.taskList.locator('[data-testid="task-title"]').allTextContents();
  }

  async markTaskDone(title) {
    const task = this.taskList.locator(`[data-testid="task-title"]:text("${title}")`).first();
    await task.locator('..').locator('[data-testid="mark-done-btn"]').click();
  }
}

module.exports = { TaskBoardPage };
