# Embedding and rerank models

The embedding model and the rerank model are **settings**, validated against a
pinned catalogue. Changing an embedding model starts a **re-embed**; it never
switches the model queries use, and no query ever compares vectors of two models.

## The settings

Six harness-level keys, stored in `~/.amauta/config.json` (not in a project's
`.planning/config.json`: one PostgreSQL store serves every project, so two
projects with different models would be a mixed store).

| Key | Default | Type | Takes effect |
|---|---|---|---|
| `retrieval.embedding_model.memory` | `voyage-code-4` | a catalogue embedding model | after a re-embed and cutover |
| `retrieval.embedding_model.code_index` | `voyage-code-4` | a catalogue embedding model | after a re-embed and cutover; restart the RLM service |
| `retrieval.rerank_model` | `rerank-3` | a catalogue rerank model | at once |
| `retrieval.embedding_provider` | `voyage` | `voyage`, `openai`, `local` | at once |
| `retrieval.embedding_dimensions` | `1024` | integer | only 1024 is accepted without a migration |
| `retrieval.rerank_enabled` | `true` | boolean | at once |

```
gsd-tools config-get retrieval.embedding_model.memory   # value, default, source, scope, pending re-embed
gsd-tools config-get --all                              # every key, harness and project
gsd-tools config-set retrieval.embedding_model.memory voyage-4
```

Each key can also be set by an environment variable, which wins over the file
and is reported as `source: env`: `GSD_EMBEDDING_MODEL_MEMORY`,
`GSD_EMBEDDING_MODEL_CODE_INDEX`, `GSD_RERANK_MODEL`, `GSD_EMBEDDING_PROVIDER`,
`GSD_EMBEDDING_DIMENSIONS`, `GSD_RERANK_ENABLED`.

An invalid value is **rejected, never replaced by the default**: an unknown model
is refused with the catalogue's list, and a model whose dimension does not fit
the `vector(1024)` columns is refused naming the migration that would be needed.
Every `config-set` keeps the previous file in `~/.amauta/config-backups/` and
appends a line to `~/.amauta/config-audit.jsonl`.

## The catalogue

`get-shit-done/config/embedding-models.json` lists every model that can be
configured. One record per model:

```
id, provider, kind ("embed" | "rerank"), dimensions, default_dimension,
max_texts_per_request, max_tokens_per_request, tpm_tier1, rpm_tier1,
price_per_mtok, free_tokens, status ("current" | "older"), asymmetric,
verified_at, verified_by, source_url
```

**Voyage publishes no model-list endpoint and no usage endpoint.** Its API
reference documents one route, `POST /v1/embeddings`. So the product cannot
discover a newer model or read the remaining allowance from the vendor, and it
does not pretend to: the catalogue file is the authority. What *is* automated is
the comparison of what you configured against the catalogue (`doctor`, below).

### Updating the catalogue

When the vendor ships or retires a model:

1. Edit `get-shit-done/config/embedding-models.json`: add or change the record,
   and set `source_url` to the vendor page each number was read from.
2. Run one tiny live call, which asserts the endpoint answers and the returned
   vector has `default_dimension` components, and writes `verified_at` and
   `verified_by` back:

   ```
   python services/embedding_backfill.py verify-catalogue --model <id> --write
   ```

   A rate-limit answer is reported (exit 4), not treated as a failure of the
   catalogue.
3. Open one pull request with the edit. `tests/test_89_08_model_catalogue.py`
   checks that every `current` record has a `source_url` and a `verified_at`.

A number that could not be measured is marked as such rather than guessed:
`voyage-code-4`'s per-request token cap is not listed by the vendor, so the
record carries the conservative 120,000 with
`max_tokens_per_request_verified_at: null`.

## Changing a model: blue/green

Each vector column has a twin (`<col>_next`) and each row records the model that
produced each of the two (`embedding_model`, `embedding_model_next`; migration
034). `embedding_state` has one row per use (`memory`, `code_index`, `rerank`)
with `active_model`, `target_model`, `phase`, `rows_total`, `rows_done`,
`tokens_spent`, `budget_tokens`.

1. `config-set retrieval.embedding_model.<use> <model>` records the target and
   sets `phase = backfilling`. `active_model` does not change; queries keep
   answering from the existing vectors.
2. Count first. Nothing is spent:

   ```
   python services/embedding_backfill.py backfill --use memory --count-only
   python services/embedding_backfill.py backfill --use code_index --count-only --path <tree> [--path <tree> ...]
   ```

3. Run it with a budget. The new vectors are written to `<col>_next`:

   ```
   python services/embedding_backfill.py backfill --use memory --budget-tokens <n>
   ```

4. Cut over. One transaction: every row that has a live vector must have its
   new one, the relevance comparison must not be worse, then the two columns are
   swapped, `active_model` becomes the target and an audit row is written:

   ```
   python services/embedding_backfill.py cutover --use memory
   python services/embedding_backfill.py cutover --use memory --rollback     # switch back
   python services/embedding_backfill.py drop-previous --use memory --confirm
   ```

   The previous vectors are kept until `drop-previous`, so switching back is a
   re-embed that finds nothing to do, followed by an instant cutover.

When the configured model **is** the active one, `backfill` runs in *fill* mode:
it embeds, in place, the rows that have no vector or a vector of another or
unknown model. That is how a freshly rebuilt database gets its vectors and how a
store that refuses with `embedding_model_mixed` is repaired; it needs no cutover.

`gsd-tools embeddings ...` forwards to the same script once that verb is wired.

### The budget rule

* A run prints the token total before it spends anything.
* It refuses to start without `--budget-tokens`, and refuses when the count is
  above the budget, naming both numbers.
* It refuses a budget above the model's free allowance unless `--allow-paid` is
  given. Spending beyond the allowance is the operator's decision.
* The count is an estimate, `ceil(characters / 3)` per text, which over-counts on
  purpose. The spend that is recorded is the provider's own usage figure when it
  reports one.

The code index is under the same control. Ingestion embeds inline, so it has its
own count and budget:

```
python services/rlm_ingestion.py ingest <tree>... --count-only
python services/rlm_ingestion.py ingest <tree>... --budget-tokens <n> [--force] [--prune]
```

`backfill --use code_index --count-only` and `rlm_ingestion.py ingest
--count-only` are one implementation and give the same number for the same
trees: the **ingestion corpus** counted from the source files (the same walk,
the same eligibility rule, the same `content[:8192]` truncation), not the rows of
`rlm_chunks`, which on a freshly rebuilt database is empty. Only files whose
extension the AST chunker handles are embedded and counted; Markdown, JSON, SQL
and the like are indexed for the lexical leg only and cost nothing.

The RLM service's per-query ingestion passes no budget. Set
`GSD_RLM_INGEST_BUDGET_TOKENS` in that process to hold it to one: above it the
call ingests nothing and says so.

### Pacing

The job assumes no rate. It reads the provider's answers: a 429 is honoured
through its `Retry-After` header when there is one and through exponential
backoff with jitter when there is not, a batch refused twice is halved, and the
pace is then held at what the provider accepted. After three requests it prints
the measured rate and the estimated duration at that rate;
`--max-duration-seconds <n>` stops it there when the estimate is longer. A run
that stops (rate limit, budget, duration, a crash) continues where it stopped
when run again; a second concurrent run exits with `backfill_already_running`.

Exit codes: `0` done, `1` internal error, `2` refused (budget, validation),
`3` already running, `4` incomplete but resumable, `5` cutover refused.

## A mixed store refuses to answer

A vector query against a table that holds a vector the active model did not
produce is **refused**, not answered with fewer rows:

```json
{"error": "embedding_model_mixed", "table": "gsd_memory", "column": "embedding",
 "use": "memory", "active_model": "voyage-code-4",
 "offending_models": ["voyage-code-3"], "offending_rows_by_model": {"voyage-code-3": 2},
 "rows": 2,
 "remedy": "services/embedding_backfill.py backfill --use memory --count-only ; then: services/embedding_backfill.py backfill --use memory --budget-tokens {tokens_total}",
 "remedy_steps": [...]}
```

A vector with no recorded model counts as another model. A query that has no
vector leg (no provider key) consults no vector and is answered lexically.

## doctor

On an install with a PostgreSQL configured, `doctor` reports:

* **FAIL** `embedding_catalogue` — a configured model is not in the catalogue;
* **WARN** `embedding_catalogue` — a configured model's record has not been
  re-verified for 90 days;
* **WARN** `embedding_catalogue` — an older model is configured while a current
  one of the same kind and dimension exists, with the exact `config-set`;
* `embedding_state` — the phase per use, WARN while a re-embed is in progress.

`/health` carries the same facts under `extra.embeddings`.
