# Read shunt (token saving)

Most of what an agent spends on is I/O, not reasoning: reading whole files to
answer a question about one function, or writing a test file that follows the
pattern of the twenty next to it. The shunt keeps that work out of the
expensive model's context.

## Three layers

| Layer | File | Job |
|---|---|---|
| Gate | `hooks/gsd-shunt-gate.cjs` | PreToolUse on `Read|Bash`. Denies a whole read (or bare `cat`/`head`/`tail`/`less`/`more`) of a file over the threshold and names the cheaper routes. |
| Worker | `get-shit-done/bin/gsd-shunt.cjs` | `bulk-read` and `code-write`, run on Haiku. Callable from the main thread and from any subagent. |
| Routing | this file + the gate's message | When to delegate, and when not to. |

## Routing

Pick the cheapest route that answers the need:

1. **Known section** — `Read` with `offset`/`limit` (use `Grep` for line numbers). Always allowed.
2. **Locate code** — `gsd-rlm query "<what>" --paths <file>` returns line ranges locally, at no model cost.
3. **Understand a large file, or several** — `gsd-shunt bulk-read --question "<q>" --paths <file>...`. The worker returns bullets with `path:line`; verify the lines with a targeted read before editing.
4. **Pattern-following output** (tests, config, type stubs, fixtures) — `gsd-shunt code-write --spec "<spec>" --reference <file> --target <file>`. The code goes to disk; only the path comes back. Review the diff, then run the tests.

Do not delegate debugging, design decisions, security review or anything
safety-critical. The worker lists locations for those and says
"needs main-model review"; read the ranges yourself.

## Switches

| Setting | Values | Default |
|---|---|---|
| `GSD_SHUNT` | `on` (deny), `warn` (message only), `off` | config `shunt.enabled`, else `off` |
| `GSD_SHUNT_MIN_LINES` / config `shunt.min_lines` | lines | 400 |
| `GSD_SHUNT_MIN_BYTES` / config `shunt.min_bytes` | bytes | 40000 |
| `GSD_SHUNT_EXEMPT_AGENTS` | comma-separated agent types | worker agents only |
| `GSD_SHUNT_EXEMPT_RE` | path regex that is never blocked | `*PLAN.md` |
| `GSD_SHUNT_MODEL` | worker model alias or id | `haiku` |
| `GSD_SHUNT_BACKEND` | explicit opt-in: `cli` (headless host runtime) or `api` (direct Messages API) | `cli` — the host runtime; `api` only when asked for |

`GSD_SHUNT` is separate from `GSD_HOOKS_ENFORCE` on purpose: the enforcement
gates ship warn-first, and a shunt that only warns saves nothing.

Install with `node bin/install.js --claude --global --enable-shunt`; it
registers the gate and writes `env.GSD_SHUNT=on` to `settings.json`.

## Measuring

Every block and every worker call is appended to `~/.amauta/shunt/log.jsonl`.
`gsd-shunt stats` totals them: reads blocked, bytes kept out, worker cost. The
token figure is an upper bound, since a blocked read is often followed by a
targeted one.

## Limits

- The gate fails open: on any error the read goes through.
- A very large corpus is rejected (`GSD_SHUNT_MAX_INPUT_CHARS`, default 600000); split the paths.
- Each call is a model round-trip of several seconds, so the threshold matters: below it, delegation costs more than it saves.
