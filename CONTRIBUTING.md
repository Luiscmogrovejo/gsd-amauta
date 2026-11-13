# Contributing to GSD-Amauta

Thank you for contributing. GSD-Amauta is MIT-licensed; contributions are CLA-free.

## Getting started

```bash
git clone https://github.com/Luiscmogrovejo/gsd-amauta.git
cd gsd-amauta
npm install
docker compose -f docker/docker-compose.yml up -d   # Start PG + Valkey
node bin/init.cjs                                    # Run setup
npm test                                             # Verify tests pass
```

### Agent-to-agent communication

If you are looking for the A2A protocol: **it was removed in v3.7 (Phase 89,
2026-11-12)** — the client, the per-agent-pair circuit breaker, the capability
registry, the `gsd-amauta a2a` / `gsd-tools a2a` verbs, the `GET /a2a/exchanges`
exchange log and the `a2a_messages` table. No production code path used it.

**The blackboard is the single agent-to-agent channel**, and it works on
PostgreSQL *and* on SQLite: `POST /api/findings`, `GET /api/findings/:task`,
`GET /api/findings?status=open`, `PATCH /api/findings/:id`, `POST /api/messages`,
`GET /api/messages/:agent[?status=…]`, `PATCH /api/messages/:id`. Add agent
communication there — `services/amauta-daemon.py` for the route,
`services/sqlite_store.py` for the SQLite half, and a both-backends test
(`tests/test_89_05_inbox_round_trip.py` is the pattern). A route that works on
only one backend is not finished.

## PR workflow

1. Fork the repo and create a branch from `master` (e.g. `feat/my-feature`).
2. Make your changes — keep commits atomic and conventional (see below).
3. Run `npm test` and `pytest services/` — both must pass before opening a PR.
4. Open a PR against `master`. The PR title must follow conventional commit format.
5. CI runs the full test suite (Node 18/20/22 × ubuntu/macos/windows) + behavioral tests.
6. The `gsd-reviewer` agent reviews your code and posts structured findings.
7. Address review comments. Once approved, a maintainer merges.

**Do not push directly to `master`.** All changes go through PRs.

## Commit conventions

GSD-Amauta uses [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | When to use |
|--------|-------------|
| `feat:` | New feature or capability |
| `fix:` | Bug fix |
| `docs:` | Documentation only |
| `chore:` | Maintenance (deps, config, CI) |
| `test:` | Test additions or fixes |
| `refactor:` | Code change that is neither a fix nor a feature |

Examples:
```
feat(blackboard): add a status filter to the agent inbox
fix(init): correct --verbose flag not suppressing stack traces
docs(readme): rewrite for external developer audience
test(migrations): add a two-shape auto_baseline suite
```

Breaking changes: append `!` after the type/scope (`feat!:`) and add a `BREAKING CHANGE:` footer.

## Test policy

- `npm test` — Node.js unit + integration tests. **Must pass on all PRs.**
- `pytest services/` — Python service tests. **Must pass on all PRs.**
- `npm run test:behavioral` — LLM behavioral tests (requires `GSD_LLM_INTEGRATION=true` + `ANTHROPIC_API_KEY`). Run locally before touching agent `.md` files or the divergence protocol.
- **New features must include tests.** Coverage ratchet runs in CI; PRs that drop coverage below the recorded baseline fail.
- Tests must be deterministic. Do not use real network calls in unit tests (mock PG, Valkey, and HTTP).

### Canary tests

Four frozen-base canaries assert that a list of protected paths (`agents/`, `services/module_schema.py`, `services/module_lifecycle.py`, `bin/init.cjs`, `scripts/agent-compiler.cjs`, and others named at the top of each file) is byte-identical to a base commit:

- `tests/party-canary.test.cjs`
- `tests/party-decisions-canary.test.cjs`
- `tests/phase-52-canary.test.cjs`
- `tests/phase-53-canary.test.cjs`

**A PR that changes a pinned path re-baselines that canary in the same PR and names the change in its description.** The canary exists to make such a change deliberate, not to forbid it. Move the base constant in each affected canary to the last commit of your PR that touches a pinned path, keep every assertion, and never skip, retire or weaken one to go green. Because the new base is a commit that exists only on your branch, such a PR is merged with a merge commit, never squashed or rebase-merged. PR #24 is the worked example of what happens otherwise: it changed `bin/init.cjs` without re-baselining and left master red on four cells.

To see whether a change touches a pinned path, run:

```
node scripts/run-tests.cjs tests/party-canary.test.cjs tests/party-decisions-canary.test.cjs tests/phase-52-canary.test.cjs tests/phase-53-canary.test.cjs
```

## Code review

The `gsd-reviewer` agent runs automatically on PRs that touch Python services or JavaScript in `bin/` or `get-shit-done/`. It posts structured findings as PR comments.

Reviewers check for:
- Acceptance criteria coverage
- Divergence protocol compliance
- Frozen surface violations (step names, schema fields, frozen constants)
- Missing error handling or graceful degradation

All findings are advisory — the human reviewer makes the final call.

## How releases work

**Releases are fully automated via `.github/workflows/release.yml`.**

To cut a release:
1. Update `"version"` in `package.json` to the new semver (e.g. `"3.3.1"`).
2. Commit: `chore(release): bump version to 3.3.1`
3. Push a git tag: `git tag v3.3.1 && git push origin v3.3.1`

The workflow triggers automatically:
- Runs the full test suite
- Publishes to npm with `--provenance` (requires `NPM_TOKEN` secret in repo settings)
- The published package includes a verified provenance attestation linking the npm artifact to this GitHub Actions run

**Do not run `npm publish` manually.** All publishes must go through the CI workflow to ensure provenance.

## Licensing

By contributing, you agree your changes are licensed under the [MIT License](LICENSE).
No CLA required. Copyright is retained by the contributor.
