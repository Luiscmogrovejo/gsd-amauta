# Contributing to GSD-Amauta

Thank you for contributing. GSD-Amauta is MIT-licensed; contributions are CLA-free.

## Getting started

```bash
git clone https://github.com/Luiscmogrovejo/gsd-amauta.git
cd gsd-amauta
npm install
docker compose -f docker/docker-compose.yml up -d   # Start PG + Valkey
npx gsd-amauta init                                  # Run setup
npm test                                             # Verify tests pass
```

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
feat(a2a): add circuit breaker per agent-pair
fix(init): correct --verbose flag not suppressing stack traces
docs(readme): rewrite for external developer audience
test(breaker): add 26-test mock suite for state machine
```

Breaking changes: append `!` after the type/scope (`feat!:`) and add a `BREAKING CHANGE:` footer.

## Test policy

- `npm test` — Node.js unit + integration tests. **Must pass on all PRs.**
- `pytest services/` — Python service tests. **Must pass on all PRs.**
- `npm run test:behavioral` — LLM behavioral tests (requires `GSD_LLM_INTEGRATION=true` + `ANTHROPIC_API_KEY`). Run locally before touching agent `.md` files or the divergence protocol.
- **New features must include tests.** Coverage ratchet runs in CI; PRs that drop coverage below the recorded baseline fail.
- Tests must be deterministic. Do not use real network calls in unit tests (mock PG, Valkey, and HTTP).

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
