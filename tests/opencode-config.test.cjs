/**
 * GSD Tools Tests - OpenCode adapter and install coverage
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  getOpencodeConfigPath,
  getOpencodeDefaultModel,
  getOpencodeSmallModel,
  configureOpencodeConfig,
  convertClaudeCommandToOpencodeCommand,
  convertClaudeAgentToOpencodeAgent,
  convertClaudeSkillToOpencodeSkill,
  install,
} = require('../bin/install.js');

describe('convertClaudeCommandToOpencodeCommand', () => {
  test('emits OpenCode-native command frontmatter and syntax', () => {
    const input = `---
name: amauta:new-project
description: Initialize a new project
argument-hint: "[--auto]"
allowed-tools:
  - Read
  - Bash
  - AskUserQuestion
---

Run /amauta:plan-phase 1 after reading @~/.claude/get-shit-done/workflows/new-project.md.
Exit the flow and invoke SlashCommand("/amauta:discuss-phase 1 --auto").`;

    const result = convertClaudeCommandToOpencodeCommand(input, 'amauta-new-project', './.opencode/', 'opencode');

    assert.ok(result.includes('description: "Initialize a new project"'), 'keeps description');
    assert.ok(result.includes('agent: gsd-operator'), 'defaults to operator');
    assert.ok(result.includes('subtask: true'), 'forces subtask execution');
    assert.ok(result.includes(`model: ${getOpencodeDefaultModel()}`), 'pins the OpenAI default model');
    assert.ok(!result.includes('allowed-tools:'), 'drops Claude-only command tool metadata');
    assert.ok(!result.includes('argument-hint:'), 'drops Claude-only argument hint');
    assert.ok(result.includes('/amauta-plan-phase 1'), 'rewrites slash command syntax');
    assert.ok(result.includes('run "/amauta-discuss-phase 1 --auto"'), 'rewrites SlashCommand calls to plain command text');
    assert.ok(result.includes('@./.opencode/get-shit-done/workflows/new-project.md'), 'rewrites Claude paths for local OpenCode installs');
  });
});

describe('convertClaudeAgentToOpencodeAgent', () => {
  test('emits subagent frontmatter with permission-based restrictions', () => {
    const input = `---
name: gsd-validator
description: Validates completed work
tools: Read, Bash, Grep, Glob
color: cyan
memory: user
skills:
  - gsd-validator-workflow
---

Read @~/.claude/get-shit-done/references/qa-checklist.md before validating.`;

    const result = convertClaudeAgentToOpencodeAgent(input, 'gsd-validator', './.opencode/', 'opencode', true);

    assert.ok(result.includes('description: "Validates completed work"'), 'keeps description');
    assert.ok(result.includes('mode: subagent'), 'marks GSD agents as subagents');
    assert.ok(result.includes(`model: ${getOpencodeDefaultModel()}`), 'pins the OpenAI default model');
    assert.ok(result.includes('color: "#00FFFF"'), 'converts color names to hex');
    assert.ok(result.includes('permission:'), 'uses OpenCode permission config');
    assert.ok(result.includes('  edit: deny'), 'denies edits for read-only agents');
    assert.ok(result.includes('  task: deny'), 'denies task tool when source agent lacks Task');
    assert.ok(result.includes('  webfetch: deny'), 'denies webfetch when source agent lacks WebFetch');
    assert.ok(result.includes('  skill: allow'), 'allows loading native skills');
    assert.ok(result.includes('Load the `gsd-validator-workflow` skill'), 'adds native skill hint');
    assert.ok(result.includes('@./.opencode/get-shit-done/references/qa-checklist.md'), 'rewrites Claude paths for OpenCode');
    assert.ok(!result.includes('memory: user'), 'drops Claude-only memory frontmatter');
    assert.ok(!result.includes('skills:'), 'drops Claude-only skills frontmatter');
  });
});

describe('convertClaudeSkillToOpencodeSkill', () => {
  test('adds required OpenCode skill frontmatter', () => {
    const input = `# Amauta Operator Workflow

Read ~/.claude/get-shit-done/bin/amauta.cjs before starting.`;

    const result = convertClaudeSkillToOpencodeSkill(input, 'gsd-operator-workflow', './.opencode/', 'opencode');

    assert.ok(result.startsWith('---\nname: gsd-operator-workflow'), 'adds skill name frontmatter');
    assert.ok(result.includes('description: "Reusable workflow for Amauta Operator Workflow."'), 'adds generated description');
    assert.ok(result.includes('compatibility: opencode'), 'marks skill as OpenCode-compatible');
    assert.ok(result.includes('./.opencode/get-shit-done/bin/amauta.cjs'), 'rewrites Claude paths in skill body');
  });
});

describe('OpenCode local install', () => {
  let tmpDir;
  let originalCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-opencode-test-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('installs commands, agents, skills, and root opencode.json', () => {
    install(false, 'opencode');
    configureOpencodeConfig(false);

    const commandPath = path.join(tmpDir, '.opencode', 'commands', 'amauta-new-project.md');
    const agentPath = path.join(tmpDir, '.opencode', 'agents', 'gsd-validator.md');
    const skillPath = path.join(tmpDir, '.opencode', 'skills', 'gsd-operator-workflow', 'SKILL.md');
    const cliPath = path.join(tmpDir, '.opencode', 'get-shit-done', 'bin', 'gsd-memory.cjs');
    const configPath = getOpencodeConfigPath(false);

    assert.ok(fs.existsSync(commandPath), 'writes OpenCode commands into .opencode/commands');
    assert.ok(fs.existsSync(agentPath), 'writes OpenCode agents into .opencode/agents');
    assert.ok(fs.existsSync(skillPath), 'writes OpenCode skills into .opencode/skills');
    assert.ok(fs.existsSync(cliPath), 'writes the installed CLI payload');
    assert.ok(fs.existsSync(configPath), 'writes project-level opencode.json');

    const commandContent = fs.readFileSync(commandPath, 'utf8');
    const agentContent = fs.readFileSync(agentPath, 'utf8');
    const skillContent = fs.readFileSync(skillPath, 'utf8');
    const cliContent = fs.readFileSync(cliPath, 'utf8');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    assert.ok(!commandContent.includes('allowed-tools:'), 'command output strips Claude-only tool metadata');
    assert.ok(!commandContent.includes('/amauta:new-project'), 'command output rewrites Claude slash syntax');
    assert.ok(!commandContent.includes('~/.claude'), 'command output has no leaked Claude paths');
    assert.ok(commandContent.includes(`model: ${getOpencodeDefaultModel()}`), 'commands pin the OpenAI default model');

    assert.ok(agentContent.includes('mode: subagent'), 'agents are emitted as OpenCode subagents');
    assert.ok(agentContent.includes('permission:'), 'agents use permission-based config');
    assert.ok(agentContent.includes('edit: deny'), 'validator stays read-only');
    assert.ok(!agentContent.includes('memory: user'), 'agent output drops Claude-only metadata');

    assert.ok(skillContent.startsWith('---\nname: gsd-operator-workflow'), 'skills include OpenCode frontmatter');
    assert.ok(!skillContent.includes('~/.claude'), 'skills have no leaked Claude paths');
    assert.ok(!cliContent.includes('~/.claude'), 'installed CLI payload has no leaked Claude paths');

    assert.deepStrictEqual(config.enabled_providers, ['openai'], 'OpenCode config is OpenAI-only');
    assert.strictEqual(config.model, getOpencodeDefaultModel(), 'OpenCode config sets the default model');
    assert.strictEqual(config.small_model, getOpencodeSmallModel(), 'OpenCode config sets the small model');
    assert.strictEqual(config.agent.build.model, getOpencodeDefaultModel(), 'build agent is pinned to the OpenAI default');
    assert.strictEqual(config.agent.plan.model, getOpencodeDefaultModel(), 'plan agent is pinned to the OpenAI default');
  });
});
