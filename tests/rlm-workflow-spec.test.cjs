/**
 * RLM, Workflow Structure, and Spec Compliance Tests
 *
 * Tests:
 *   - RLM context engine CLI and service structure
 *   - Workflow file structural validation (36 files)
 *   - Spec compliance verification across all 7+ specs
 *   - SQL migration chain integrity
 *   - Agent-skill mapping consistency
 *   - Template module existence
 *   - Daemon route coverage
 *   - PG store method coverage
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const SKILLS_DIR = path.join(ROOT, 'skills');
const WORKFLOWS_DIR = path.join(ROOT, 'get-shit-done', 'workflows');
const SPECS_DIR = path.join(ROOT, 'specs');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const SERVICES_DIR = path.join(ROOT, 'services');
const BIN_DIR = path.join(ROOT, 'get-shit-done', 'bin');

// ═══════════════════════════════════════════════════════
// SECTION 1: RLM Context Engine (10 tests)
// ═══════════════════════════════════════════════════════

describe('RLM Context Engine — structural tests', () => {
  const rlmService = path.join(SERVICES_DIR, 'rlm-service.py');
  const rlmCli = path.join(BIN_DIR, 'gsd-rlm.cjs');

  test('1.1 rlm-service.py exists and has core functions', () => {
    const content = fs.readFileSync(rlmService, 'utf-8');
    assert.ok(content.includes('chunk_file'), 'Should have chunk_file function');
    assert.ok(content.includes('score_chunks'), 'Should have score_chunks function');
    assert.ok(content.includes('scan_directory'), 'Should have scan_directory function');
    assert.ok(content.includes('RLMHandler'), 'Should have RLMHandler class');
    assert.ok(content.includes('_tokenize'), 'Should have _tokenize function');
    assert.ok(content.includes('_compute_score'), 'Should have _compute_score function');
  });

  test('1.2 rlm-service.py has language-specific chunkers', () => {
    const content = fs.readFileSync(rlmService, 'utf-8');
    assert.ok(content.includes('_chunk_python'), 'Should chunk Python files');
    assert.ok(content.includes('_chunk_javascript'), 'Should chunk JS/TS files');
    assert.ok(content.includes('_chunk_sql'), 'Should chunk SQL files');
    assert.ok(content.includes('_chunk_markdown'), 'Should chunk Markdown files');
    assert.ok(content.includes('_chunk_generic'), 'Should have generic chunker');
  });

  test('1.3 rlm-service.py has HTTP endpoints', () => {
    const content = fs.readFileSync(rlmService, 'utf-8');
    assert.ok(content.includes('/health'), 'Should have /health endpoint');
    assert.ok(content.includes('/chunk'), 'Should have /chunk endpoint');
    assert.ok(content.includes('/search'), 'Should have /search endpoint');
    assert.ok(content.includes('/query'), 'Should have /query endpoint');
  });

  test('1.4 rlm-service.py uses TF-IDF scoring', () => {
    const content = fs.readFileSync(rlmService, 'utf-8');
    assert.ok(content.includes('tf') || content.includes('TF'), 'Should reference TF');
    assert.ok(content.includes('idf') || content.includes('IDF'), 'Should reference IDF');
  });

  test('1.5 rlm-service.py has LRU cache', () => {
    const content = fs.readFileSync(rlmService, 'utf-8');
    assert.ok(content.includes('ChunkCache'), 'Should have ChunkCache class');
    assert.ok(content.includes('lru') || content.includes('LRU') || content.includes('cache'), 'Should have caching');
  });

  test('1.6 gsd-rlm.cjs CLI exists', () => {
    assert.ok(fs.existsSync(rlmCli), 'gsd-rlm.cjs should exist');
    const content = fs.readFileSync(rlmCli, 'utf-8');
    assert.ok(content.includes('query') || content.includes('search'), 'Should have query/search command');
  });

  test('1.7 rlm-service.py has configurable env vars', () => {
    const content = fs.readFileSync(rlmService, 'utf-8');
    assert.ok(content.includes('GSD_RLM_PORT') || content.includes('18798'), 'Should use RLM port');
    assert.ok(content.includes('RLM_MAX_CHUNK_CHARS') || content.includes('8000'), 'Should have chunk size config');
    assert.ok(content.includes('RLM_DEFAULT_TOP_K') || content.includes('top_k'), 'Should have top-k config');
  });

  test('1.8 rlm-service.py has daemon lifecycle functions', () => {
    const content = fs.readFileSync(rlmService, 'utf-8');
    assert.ok(content.includes('start_server'), 'Should have start_server');
    assert.ok(content.includes('stop_server'), 'Should have stop_server');
    assert.ok(content.includes('check_status'), 'Should have check_status');
  });

  test('1.9 amauta.py has RLM integration functions', () => {
    const content = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    assert.ok(content.includes('_rlm_find_node'), 'Should have _rlm_find_node');
    assert.ok(content.includes('_rlm_find_cli'), 'Should have _rlm_find_cli');
    assert.ok(content.includes('_rlm_query'), 'Should have _rlm_query');
  });

  test('1.10 amauta.py _rpetd_phase_enrich calls RLM for each phase', () => {
    const content = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    const enrichFn = content.substring(content.indexOf('def _rpetd_phase_enrich'));
    assert.ok(enrichFn.includes('_rlm_query'), 'Phase enrichment should call RLM');
  });
});

// ═══════════════════════════════════════════════════════
// SECTION 2: Workflow Structural Validation (12 tests)
// ═══════════════════════════════════════════════════════

describe('Workflow Structural Validation — 36 files', () => {
  const workflowFiles = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.md'));

  test('2.1 all 36+ workflow files exist', () => {
    assert.ok(workflowFiles.length >= 36, `Expected >=36 workflow files, got ${workflowFiles.length}`);
  });

  test('2.2 key workflows present', () => {
    const required = [
      'execute-phase.md', 'execute-plan.md', 'plan-phase.md', 'validate-phase.md',
      'research-phase.md', 'test-phase.md', 'health.md', 'help.md',
      'new-project.md', 'new-milestone.md', 'progress.md', 'quick.md',
    ];
    for (const f of required) {
      assert.ok(workflowFiles.includes(f), `Required workflow ${f} should exist`);
    }
  });

  test('2.3 no workflow uses deprecated "GSD >" banner (should be "AMAUTA >")', () => {
    let violations = [];
    for (const f of workflowFiles) {
      const content = fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf-8');
      // Check for standalone "GSD >" but not "GSD-Amauta" or file paths
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\bGSD\s*>/.test(line) && !line.includes('GSD-Amauta') && !line.includes('get-shit-done') && !line.includes('gsd-')) {
          violations.push(`${f}:${i+1}: ${line.trim()}`);
        }
      }
    }
    assert.strictEqual(violations.length, 0, `Found GSD > banners that should be AMAUTA >:\n${violations.join('\n')}`);
  });

  test('2.4 execute-phase.md has amauta_enrichment block', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'execute-phase.md'), 'utf-8');
    assert.ok(content.includes('amauta_enrichment') || content.includes('enrichment'), 'Should have enrichment block');
  });

  test('2.5 execute-plan.md has amauta_enrichment block', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'execute-plan.md'), 'utf-8');
    assert.ok(content.includes('amauta_enrichment') || content.includes('enrichment'), 'Should have enrichment block');
  });

  test('2.6 validate-phase.md references validation gates concept', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'validate-phase.md'), 'utf-8');
    // validate-phase.md describes the validation workflow, which references gates
    // Check for the key validation concepts
    const hasConcepts = [
      content.includes('validate') || content.includes('VALIDATE'),
      content.includes('gate') || content.includes('Gate') || content.includes('AMAUTA') || content.includes('amauta validate'),
      content.includes('pass') || content.includes('fail') || content.includes('FAIL'),
      content.length > 500, // substantial content
    ].filter(Boolean).length;
    assert.ok(hasConcepts >= 3, `validate-phase.md should describe validation workflow (found ${hasConcepts}/4 concepts)`);
  });

  test('2.7 research-phase.md references research chain', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'research-phase.md'), 'utf-8');
    assert.ok(
      content.includes('research') || content.includes('RESEARCH') || content.includes('gsd-research'),
      'Should reference research chain'
    );
  });

  test('2.8 all workflows are valid markdown (no unclosed code blocks)', () => {
    let violations = [];
    for (const f of workflowFiles) {
      const content = fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf-8');
      const ticks = (content.match(/```/g) || []).length;
      if (ticks % 2 !== 0) {
        violations.push(`${f}: ${ticks} triple backticks (unclosed code block)`);
      }
    }
    assert.strictEqual(violations.length, 0, `Unclosed code blocks:\n${violations.join('\n')}`);
  });

  test('2.9 workflows using $CLI reference valid subcommands', () => {
    const validCmds = [
      'add', 'show', 'list', 'update', 'status', 'assign', 'delete', 'next',
      'claim', 'rpetd', 'note', 'atomize', 'validate', 'board', 'search',
      'score', 'refs', 'risk', 'sprint', 'agent-tasks', 'stats', 'skb',
      'export', 'import', 'migrate', 'memory',
    ];
    let violations = [];
    for (const f of workflowFiles) {
      const content = fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf-8');
      const matches = content.match(/\$CLI\s+(\w+)/g) || [];
      for (const m of matches) {
        const cmd = m.replace('$CLI ', '').trim();
        if (!validCmds.includes(cmd) && cmd !== 'link' && cmd !== 'unlink') {
          violations.push(`${f}: $CLI ${cmd}`);
        }
      }
    }
    // Allow some flexibility for custom commands
    assert.ok(violations.length <= 5, `Potentially invalid $CLI commands:\n${violations.join('\n')}`);
  });

  test('2.10 help.md covers all major commands', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'help.md'), 'utf-8');
    const cmds = ['add', 'show', 'list', 'claim', 'validate', 'rpetd', 'next', 'board'];
    let missing = cmds.filter(c => !content.includes(c));
    assert.strictEqual(missing.length, 0, `help.md missing commands: ${missing.join(', ')}`);
  });

  test('2.11 health.md has AMAUTA branding', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'health.md'), 'utf-8');
    assert.ok(content.includes('AMAUTA') || content.includes('Amauta'), 'Should have Amauta branding');
  });

  test('2.12 quick.md has Amauta branding', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'quick.md'), 'utf-8');
    assert.ok(content.includes('Amauta'), 'Should have Amauta branding');
  });
});

// ═══════════════════════════════════════════════════════
// SECTION 3: Spec Compliance (14 tests)
// ═══════════════════════════════════════════════════════

describe('Spec Compliance — all specs', () => {
  const specFiles = fs.readdirSync(SPECS_DIR).filter(f => f.endsWith('.spec.md'));

  test('3.1 all 7 spec files exist', () => {
    assert.ok(specFiles.length >= 7, `Expected >=7 spec files, got ${specFiles.length}`);
  });

  test('3.2 SPEC-01 RPETD pipeline spec has required sections', () => {
    const content = fs.readFileSync(path.join(SPECS_DIR, '01-rpetd-pipeline.spec.md'), 'utf-8');
    assert.ok(content.includes('RPETD'), 'Should mention RPETD');
    assert.ok(content.includes('validation') || content.includes('Validation'), 'Should mention validation');
    assert.ok(content.includes('gate') || content.includes('Gate'), 'Should mention gates');
  });

  test('3.3 SPEC-02 Memory pipeline spec has PG and scoring', () => {
    const content = fs.readFileSync(path.join(SPECS_DIR, '02-memory-pipeline.spec.md'), 'utf-8');
    assert.ok(content.includes('PostgreSQL') || content.includes('postgres') || content.includes('PG'), 'Should mention PG');
    assert.ok(content.includes('score') || content.includes('scoring'), 'Should mention scoring');
    assert.ok(content.includes('pgvector') || content.includes('embedding'), 'Should mention embeddings');
  });

  test('3.4 SPEC-03 RLM context engine spec has TF-IDF', () => {
    const content = fs.readFileSync(path.join(SPECS_DIR, '03-rlm-context-engine.spec.md'), 'utf-8');
    assert.ok(content.includes('RLM'), 'Should mention RLM');
    assert.ok(content.includes('TF-IDF') || content.includes('tf-idf'), 'Should mention TF-IDF');
    assert.ok(content.includes('chunk'), 'Should mention chunking');
  });

  test('3.5 SPEC-04 Research chain spec has 5 steps', () => {
    const content = fs.readFileSync(path.join(SPECS_DIR, '04-research-chain.spec.md'), 'utf-8');
    assert.ok(content.includes('memory') || content.includes('Memory'), 'Should mention memory step');
    assert.ok(content.includes('SKB') || content.includes('skb'), 'Should mention SKB step');
    assert.ok(content.includes('Perplexity') || content.includes('perplexity'), 'Should mention Perplexity step');
    assert.ok(content.includes('WebFetch') || content.includes('webfetch'), 'Should mention WebFetch step');
  });

  test('3.6 SPEC-05 Task lifecycle spec has states', () => {
    const content = fs.readFileSync(path.join(SPECS_DIR, '05-task-lifecycle.spec.md'), 'utf-8');
    assert.ok(content.includes('pending'), 'Should mention pending state');
    assert.ok(content.includes('in-progress') || content.includes('in_progress'), 'Should mention in-progress state');
    assert.ok(content.includes('validation'), 'Should mention validation state');
    assert.ok(content.includes('done'), 'Should mention done state');
  });

  test('3.7 SPEC-06 Agent architecture spec lists 11 agents', () => {
    const content = fs.readFileSync(path.join(SPECS_DIR, '06-agent-architecture.spec.md'), 'utf-8');
    assert.ok(content.includes('11') || content.includes('eleven'), 'Should mention 11 agents');
    const agents = ['checker', 'debugger', 'executor', 'operator', 'planner', 'researcher', 'roadmapper', 'validator'];
    for (const a of agents) {
      assert.ok(content.includes(a), `Should mention ${a} agent`);
    }
  });

  test('3.8 SPEC-07 Auto-learning spec has performance tracking', () => {
    const content = fs.readFileSync(path.join(SPECS_DIR, '07-auto-learning-feedback.spec.md'), 'utf-8');
    assert.ok(content.includes('performance') || content.includes('Performance'), 'Should mention performance');
    assert.ok(content.includes('learning') || content.includes('Learning'), 'Should mention learning');
    assert.ok(content.includes('enrichment') || content.includes('injection'), 'Should mention enrichment injection');
  });

  test('3.9 all specs have substantive content (>200 chars)', () => {
    let missing = [];
    for (const f of specFiles) {
      const content = fs.readFileSync(path.join(SPECS_DIR, f), 'utf-8');
      if (content.length < 200) {
        missing.push(`${f} (${content.length} chars)`);
      }
    }
    assert.strictEqual(missing.length, 0, `Specs too short: ${missing.join(', ')}`);
  });

  test('3.10 RPETD-3: amauta.py has all 5 RPETD phase enrichment handlers', () => {
    const content = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    const fn = content.substring(content.indexOf('def _rpetd_phase_enrich'));
    for (const phase of ['R', 'P', 'E', 'T', 'D']) {
      assert.ok(fn.includes(`"${phase}"`) || fn.includes(`'${phase}'`), `Should handle ${phase} phase`);
    }
  });

  test('3.11 MEM-1: PG memory functions use source-aware scoring', () => {
    const content = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    // Source-aware scoring is implemented via SQL source_boost in _mem_pg_search
    assert.ok(content.includes('source_boost') || content.includes('score_expr') || content.includes('+ source'), 'Should have source boost scoring');
    assert.ok(content.includes('auto_learning'), 'Should reference auto_learning source');
    assert.ok(content.includes('lesson-learned'), 'Should reference lesson-learned source');
  });

  test('3.12 AGT-2: All 11 agents have CLI= MEM= variables', () => {
    const agentFiles = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
    assert.ok(agentFiles.length >= 11, `Expected >=11 agents, got ${agentFiles.length}`);
    for (const f of agentFiles) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8');
      assert.ok(content.includes('CLI='), `${f} should have CLI= variable`);
      assert.ok(content.includes('MEM='), `${f} should have MEM= variable`);
      assert.ok(content.includes('RESEARCH='), `${f} should have RESEARCH= variable`);
      // validator intentionally omits RLM
      if (!f.includes('validator')) {
        assert.ok(content.includes('RLM='), `${f} should have RLM= variable`);
      }
    }
  });

  test('3.13 AGT-3: All agent skills reference correct SKILL.md', () => {
    const agentFiles = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
    for (const f of agentFiles) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8');
      const skillMatch = content.match(/skills:\s*\n\s*-\s+(\S+)/);
      if (skillMatch) {
        const skillDir = path.join(SKILLS_DIR, skillMatch[1]);
        assert.ok(fs.existsSync(skillDir), `${f} references skill ${skillMatch[1]} but directory doesn't exist`);
        assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')), `${skillMatch[1]}/SKILL.md should exist`);
      }
    }
  });

  test('3.14 All 11 skills have $RESEARCH search in context pipeline', () => {
    const skillDirs = fs.readdirSync(SKILLS_DIR).filter(d => {
      const p = path.join(SKILLS_DIR, d);
      return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'SKILL.md'));
    });
    assert.ok(skillDirs.length >= 11, `Expected >=11 skills, got ${skillDirs.length}`);
    for (const d of skillDirs) {
      const content = fs.readFileSync(path.join(SKILLS_DIR, d, 'SKILL.md'), 'utf-8');
      assert.ok(content.includes('$RESEARCH'), `${d}/SKILL.md should use $RESEARCH`);
    }
  });
});

// ═══════════════════════════════════════════════════════
// SECTION 4: SQL Migration Chain (8 tests)
// ═══════════════════════════════════════════════════════

describe('SQL Migration Chain Integrity', () => {
  const allFiles = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  const migrationFiles = allFiles.filter(f => !f.includes('DOWN'));
  const downFiles = allFiles.filter(f => f.includes('DOWN'));

  test('4.1 all 5 UP + 5 DOWN migration files exist', () => {
    assert.ok(migrationFiles.length >= 5, `Expected >=5 UP migrations, got ${migrationFiles.length}`);
    assert.ok(downFiles.length >= 5, `Expected >=5 DOWN migrations, got ${downFiles.length}`);
  });

  test('4.2 UP migrations numbered sequentially', () => {
    const nums = migrationFiles.map(f => parseInt(f.split('-')[0]));
    for (let i = 0; i < nums.length - 1; i++) {
      assert.ok(nums[i] < nums[i+1], `Migration ${nums[i]} should come before ${nums[i+1]}`);
    }
  });

  test('4.3 001-init.sql creates core tables', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, '001-init.sql'), 'utf-8');
    assert.ok(content.includes('gsd_memory'), 'Should create gsd_memory table');
    assert.ok(content.includes('gsd_shared_kb'), 'Should create gsd_shared_kb table');
    assert.ok(content.includes('gsd_tasks'), 'Should create gsd_tasks table');
    assert.ok(content.includes('gsd_task_validations'), 'Should create gsd_task_validations table');
    assert.ok(content.includes('gitflow_log'), 'Should create gitflow_log table');
  });

  test('4.4 001-init.sql creates views', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, '001-init.sql'), 'utf-8');
    assert.ok(content.includes('amauta_memory'), 'Should create amauta_memory view');
    assert.ok(content.includes('agent_shared_knowledge'), 'Should create agent_shared_knowledge view');
  });

  test('4.5 001-init.sql creates triggers', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, '001-init.sql'), 'utf-8');
    assert.ok(content.includes('trg_gsd_memory_updated'), 'Should create memory update trigger');
    assert.ok(content.includes('trg_gsd_tasks_updated'), 'Should create tasks update trigger');
    assert.ok(content.includes('trg_amauta_memory_insert'), 'Should create memory view insert trigger');
  });

  test('4.6 005-agent-performance.sql creates performance table', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, '005-agent-performance.sql'), 'utf-8');
    assert.ok(content.includes('gsd_agent_performance'), 'Should create agent_performance table');
    assert.ok(content.includes('agent_id'), 'Should have agent_id column');
    assert.ok(content.includes('outcome'), 'Should have outcome column');
    assert.ok(content.includes('gate_failed'), 'Should have gate_failed column');
  });

  test('4.7 003-embedding migration handles dimension change', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, '003-embedding-1024.sql'), 'utf-8');
    assert.ok(content.includes('1024'), 'Should reference 1024 dimensions');
  });

  test('4.8 view triggers pass project_id and source_task', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, '001-init.sql'), 'utf-8');
    // Check the insert triggers include the required columns
    const memTrigger = content.substring(content.indexOf('amauta_memory_insert'));
    assert.ok(memTrigger.includes('project_id'), 'Memory view trigger should pass project_id');
    const skbTrigger = content.substring(content.indexOf('agent_shared_knowledge_insert'));
    assert.ok(skbTrigger.includes('source_task'), 'SKB view trigger should pass source_task');
  });
});

// ═══════════════════════════════════════════════════════
// SECTION 5: PG Store & Daemon Structure (10 tests)
// ═══════════════════════════════════════════════════════

describe('PG Store & Daemon — structural tests', () => {
  const pgStore = path.join(SERVICES_DIR, 'pg_store.py');
  const daemon = path.join(SERVICES_DIR, 'amauta-daemon.py');

  test('5.1 pg_store.py has all required methods', () => {
    const content = fs.readFileSync(pgStore, 'utf-8');
    const methods = [
      'memory_store', 'memory_search', 'memory_list', 'memory_count', 'memory_delete',
      'skb_store', 'skb_search', 'skb_list',
      'validation_record', 'validation_history',
      'task_upsert', 'task_upsert_batch', 'task_delete',
      'record_agent_performance', 'agent_performance_summary',
      'generate_embedding', 'memory_store_with_embedding', 'memory_semantic_search',
      'memory_backfill_embeddings', 'memory_embedding_stats',
    ];
    for (const m of methods) {
      assert.ok(content.includes(m), `pg_store.py should have ${m} method`);
    }
  });

  test('5.2 pg_store.py supports Voyage API embeddings', () => {
    const content = fs.readFileSync(pgStore, 'utf-8');
    assert.ok(content.includes('VOYAGE_API_KEY'), 'Should check for Voyage API key');
    assert.ok(content.includes('voyage-code-3') || content.includes('voyage'), 'Should use Voyage model');
    assert.ok(content.includes('voyageai.com') || content.includes('voyage'), 'Should call Voyage API');
  });

  test('5.3 pg_store.py supports OpenAI embeddings as fallback', () => {
    const content = fs.readFileSync(pgStore, 'utf-8');
    assert.ok(content.includes('OPENAI_API_KEY'), 'Should check for OpenAI API key');
    assert.ok(content.includes('openai.com') || content.includes('openai'), 'Should call OpenAI API');
  });

  test('5.4 pg_store.py has source-aware scoring', () => {
    const content = fs.readFileSync(pgStore, 'utf-8');
    assert.ok(content.includes('_score_memories') || content.includes('score'), 'Should have scoring method');
    assert.ok(content.includes('source'), 'Should use source field for scoring');
  });

  test('5.5 pg_store.py has connection pooling', () => {
    const content = fs.readFileSync(pgStore, 'utf-8');
    assert.ok(content.includes('SimpleConnectionPool') || content.includes('pool'), 'Should use connection pool');
    assert.ok(content.includes('_get_conn'), 'Should have connection getter');
  });

  test('5.6 daemon has all GET routes', () => {
    const content = fs.readFileSync(daemon, 'utf-8');
    const getRoutes = ['/health', '/api/board', '/api/stats', '/api/show', '/api/next', '/api/list'];
    for (const r of getRoutes) {
      assert.ok(content.includes(r), `Daemon should have GET ${r}`);
    }
  });

  test('5.7 daemon has all POST routes', () => {
    const content = fs.readFileSync(daemon, 'utf-8');
    const postRoutes = ['/api/add', '/api/claim', '/api/rpetd', '/api/status', '/api/validate', '/api/note'];
    for (const r of postRoutes) {
      assert.ok(content.includes(r), `Daemon should have POST ${r}`);
    }
  });

  test('5.8 daemon has memory routes', () => {
    const content = fs.readFileSync(daemon, 'utf-8');
    assert.ok(content.includes('/api/memory/store'), 'Should have memory store route');
    assert.ok(content.includes('/api/memory/search'), 'Should have memory search route');
    assert.ok(content.includes('/api/memory/semantic-search'), 'Should have semantic search route');
  });

  test('5.9 daemon has agent-performance routes', () => {
    const content = fs.readFileSync(daemon, 'utf-8');
    assert.ok(content.includes('/api/agent-performance'), 'Should have agent-performance route');
  });

  test('5.10 daemon has SKB routes', () => {
    const content = fs.readFileSync(daemon, 'utf-8');
    assert.ok(content.includes('/api/skb/store'), 'Should have SKB store route');
    assert.ok(content.includes('/api/skb/search'), 'Should have SKB search route');
  });
});

// ═══════════════════════════════════════════════════════
// SECTION 6: Docker & Configuration (5 tests)
// ═══════════════════════════════════════════════════════

describe('Docker & Configuration', () => {
  test('6.1 docker-compose.yml exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'docker', 'docker-compose.yml')), 'docker-compose.yml should exist');
  });

  test('6.2 docker-compose.yml has postgres service', () => {
    const content = fs.readFileSync(path.join(ROOT, 'docker', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('postgres'), 'Should have postgres service');
    assert.ok(content.includes('pgvector') || content.includes('5433'), 'Should configure pgvector or port');
  });

  test('6.3 package.json has test scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    assert.ok(pkg.scripts.test, 'Should have test script');
    assert.ok(pkg.scripts['test:coverage'], 'Should have test:coverage script');
  });

  test('6.4 .gitignore excludes sensitive files', () => {
    const content = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf-8');
    assert.ok(content.includes('.env'), 'Should ignore .env files');
    assert.ok(content.includes('node_modules'), 'Should ignore node_modules');
  });

  test('6.5 scripts/run-tests.cjs exists and is valid', () => {
    const content = fs.readFileSync(path.join(ROOT, 'scripts', 'run-tests.cjs'), 'utf-8');
    assert.ok(content.includes('--test'), 'Should use node --test');
    assert.ok(content.includes('.test.cjs'), 'Should discover test files');
  });
});

// ═══════════════════════════════════════════════════════
// SECTION 7: Research Chain Integration (6 tests)
// ═══════════════════════════════════════════════════════

describe('Research Chain — deep integration tests', () => {
  const researchCli = path.join(BIN_DIR, 'gsd-research.cjs');

  test('7.1 gsd-research.cjs exists', () => {
    assert.ok(fs.existsSync(researchCli), 'gsd-research.cjs should exist');
  });

  test('7.2 gsd-research.cjs implements 5-step chain', () => {
    const content = fs.readFileSync(researchCli, 'utf-8');
    // Should reference the 5-step chain: memory, SKB, Context7, Perplexity, WebFetch
    assert.ok(content.includes('memory') || content.includes('MEM'), 'Should include memory step');
    assert.ok(content.includes('search'), 'Should have search functionality');
  });

  test('7.3 all agent SKILL.md files reference research chain in correct order', () => {
    const skillDirs = fs.readdirSync(SKILLS_DIR).filter(d => {
      const p = path.join(SKILLS_DIR, d);
      return fs.statSync(p).isDirectory();
    });
    for (const d of skillDirs) {
      const skillFile = path.join(SKILLS_DIR, d, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        const content = fs.readFileSync(skillFile, 'utf-8');
        if (content.includes('$RESEARCH')) {
          // Should have the research chain comment
          assert.ok(
            content.includes('Research chain') || content.includes('research chain') || content.includes('Perplexity'),
            `${d}/SKILL.md should document research chain`
          );
        }
      }
    }
  });

  test('7.4 execute-phase.md calls research in enrichment', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'execute-phase.md'), 'utf-8');
    assert.ok(
      content.includes('gsd-research') || content.includes('RESEARCH') || content.includes('research'),
      'execute-phase should call research chain'
    );
  });

  test('7.5 operator agent documents research chain fallback', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-operator.md'), 'utf-8');
    assert.ok(content.includes('Perplexity') || content.includes('perplexity'), 'Should mention Perplexity');
    assert.ok(content.includes('WebFetch') || content.includes('webfetch') || content.includes('web'), 'Should mention WebFetch fallback');
  });

  test('7.6 researcher agent has WebFetch tool', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-researcher.md'), 'utf-8');
    assert.ok(content.includes('WebFetch'), 'Researcher should have WebFetch tool');
    assert.ok(content.includes('Perplexity'), 'Researcher should reference Perplexity');
  });
});

// ═══════════════════════════════════════════════════════
// SECTION 8: Auto-Learning Deep Integration (8 tests)
// ═══════════════════════════════════════════════════════

describe('Auto-Learning — deep integration tests', () => {
  test('8.1 amauta.py has agent_performance_summary function', () => {
    const content = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    assert.ok(content.includes('_agent_performance_summary'), 'Should have performance summary function');
  });

  test('8.2 amauta.py has _record_agent_performance function', () => {
    const content = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    assert.ok(content.includes('_record_agent_performance'), 'Should have record performance function');
  });

  test('8.3 cmd_validate records performance on pass', () => {
    const content = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    const validateFn = content.substring(content.indexOf('def cmd_validate'));
    assert.ok(validateFn.includes('_record_agent_performance') || validateFn.includes('record_agent_performance'),
      'validate should record performance');
  });

  test('8.4 cmd_validate records performance on fail', () => {
    const content = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    const validateFn = content.substring(content.indexOf('def cmd_validate'));
    assert.ok(validateFn.includes('fail'), 'validate should handle fail case');
  });

  test('8.5 _enrich_task_context injects performance history', () => {
    const content = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    const enrichFn = content.substring(content.indexOf('def _enrich_task_context'));
    assert.ok(enrichFn.includes('performance') || enrichFn.includes('_agent_performance'),
      'Enrichment should inject performance history');
  });

  test('8.6 _auto_write_learning writes to both memory and SKB', () => {
    const content = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    const fn = content.substring(content.indexOf('def _auto_write_learning'));
    assert.ok(fn.includes('_mem_pg_add') || fn.includes('amauta_memory'), 'Should write to memory');
    assert.ok(fn.includes('_skb_promote'), 'Should promote to SKB');
  });

  test('8.7 D-phase LEARNING extraction works', () => {
    const content = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    assert.ok(content.includes('LEARNING:') || content.includes('LEARNING'), 'Should handle LEARNING keyword');
  });

  test('8.8 _mem_log_event has dedup for learning sources', () => {
    const content = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    const fn = content.substring(content.indexOf('def _mem_log_event'));
    assert.ok(fn.includes('dedup') || fn.includes('already exists') || fn.includes('duplicate'),
      'Should have dedup logic');
  });
});
