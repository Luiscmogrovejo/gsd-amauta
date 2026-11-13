"""Phase 89 plan 89-08 (RET-05) — the model catalogue and the harness config.

No database is needed by anything in this file, so nothing here is gated and
nothing here has a skip-ledger entry: it runs on every cell and on a developer
machine alike.

What is proven:

* the catalogue (``get-shit-done/config/embedding-models.json``) is complete —
  every ``current`` record names its source and the date it was verified, every
  record's default dimension is one it supports — and it SHIPS;
* the defaults resolve to ``voyage-code-4`` and ``rerank-3`` with no config at
  all, and migration 034 seeds the same two names;
* an invalid value is REJECTED, never replaced by the default: an unknown model
  (the message carries the catalogue's list) and a dimension mismatch (the
  message names the migration that would be needed);
* the enum of the model keys is DERIVED from the catalogue: a model added to a
  fixture catalogue is accepted with no code edit;
* a write is atomic, keeps the previous file and appends an audit line, and a
  malformed file is a typed error that is never overwritten;
* the ``doctor`` rows: stale catalogue, older model (with the exact
  ``config-set``), unknown model, and the ``embedding_state`` phase.
"""
import datetime
import json
import pathlib
import re
import shutil
import sys

import pytest

_REPO = pathlib.Path(__file__).resolve().parents[1]
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

from services import _89_08_reporting as reporting  # noqa: E402
from services import harness_config, report_hooks  # noqa: E402

CATALOGUE = _REPO / "get-shit-done" / "config" / "embedding-models.json"
MIGRATION = _REPO / "migrations" / "034-embedding-blue-green.sql"


def _catalogue():
    return json.loads(CATALOGUE.read_text(encoding="utf-8"))


@pytest.fixture
def harness(tmp_path):
    """A harness config path in a temp directory — never the operator's."""
    return tmp_path / ".amauta" / "config.json"


@pytest.fixture
def fixture_catalogue(tmp_path):
    """A copy of the catalogue a test may extend; returns ``(path, env)``."""
    path = tmp_path / "embedding-models.json"
    shutil.copyfile(CATALOGUE, path)
    return path, {harness_config.CATALOGUE_ENV: str(path)}


# ── the catalogue ────────────────────────────────────────────────────────────

REQUIRED_FIELDS = (
    "id", "provider", "kind", "dimensions", "default_dimension",
    "max_texts_per_request", "max_tokens_per_request", "tpm_tier1", "rpm_tier1",
    "price_per_mtok", "free_tokens", "status", "asymmetric", "verified_at",
    "verified_by", "source_url",
)


def test_every_record_carries_every_field():
    models = _catalogue()["models"]
    assert len(models) >= 8
    for record in models:
        missing = [f for f in REQUIRED_FIELDS if f not in record]
        assert not missing, (record.get("id"), missing)
        assert record["kind"] in ("embed", "rerank")
        assert record["status"] in ("current", "older")


def test_every_current_record_has_a_source_and_a_verification_date():
    current = [m for m in _catalogue()["models"] if m["status"] == "current"]
    assert current, "the catalogue lists no current model"
    for record in current:
        assert record["source_url"], record["id"]
        assert datetime.date.fromisoformat(record["verified_at"]), record["id"]
        assert record["verified_by"], record["id"]


def test_every_default_dimension_is_one_the_model_supports():
    for record in _catalogue()["models"]:
        assert record["default_dimension"] in record["dimensions"], record["id"]


def test_the_named_models_are_all_listed():
    ids = {m["id"] for m in _catalogue()["models"]}
    assert {"voyage-code-4", "voyage-4", "voyage-4-large", "voyage-code-3",
            "rerank-3", "rerank-3-lite", "rerank-2.5",
            "text-embedding-3-small", "qodo-embed-1-1.5b"} <= ids


def test_the_unmeasured_request_cap_says_so():
    """voyage-code-4's per-request cap is not listed by the vendor and was not
    measured: the catalogue carries the conservative 120K and says it is not
    verified, instead of presenting an assumption as a fact."""
    record = harness_config.model_record("voyage-code-4")
    assert record["max_tokens_per_request"] == 120000
    assert record["max_tokens_per_request_verified_at"] is None
    assert "assumed" in record["max_tokens_per_request_note"]


def test_the_catalogue_is_in_the_shipped_set():
    """`get-shit-done/` ships whole (package.json `files`), and nothing in the
    installer's exclusion rule names this file. The rule itself is EXECUTED, on
    the installer's own `isShippedPath`/`shippedFileMap`, in
    tests/89-08-config-scope.test.cjs — here it is read (bin/init.cjs is not
    edited by this plan)."""
    files = json.loads((_REPO / "package.json").read_text(encoding="utf-8"))["files"]
    assert {"get-shit-done", "services", "migrations"} <= set(files)
    init = (_REPO / "bin" / "init.cjs").read_text(encoding="utf-8")
    suffixes = re.search(r"SHIPPED_EXCLUDE_SUFFIXES = \[([^\]]*)\]", init).group(1)
    excluded = set(re.findall(r"'([^']+)'", suffixes))
    assert excluded and not excluded & {".json", ".py", ".sql"}, excluded
    assert CATALOGUE.is_file()


# ── defaults ─────────────────────────────────────────────────────────────────

def test_the_defaults_resolve_with_no_config_present(harness):
    assert not harness.exists()
    memory = harness_config.resolve("retrieval.embedding_model.memory", env={}, path=harness)
    code = harness_config.resolve("retrieval.embedding_model.code_index", env={}, path=harness)
    rerank = harness_config.resolve("retrieval.rerank_model", env={}, path=harness)
    assert (memory["value"], code["value"], rerank["value"]) == (
        "voyage-code-4", "voyage-code-4", "rerank-3")
    for row in (memory, code, rerank):
        assert row["source"] == "default" and row["scope"] == "harness"
        assert row["default"] == row["value"]
    assert harness_config.resolve("retrieval.embedding_provider", env={}, path=harness)["value"] == "voyage"
    assert harness_config.resolve("retrieval.embedding_dimensions", env={}, path=harness)["value"] == 1024
    assert harness_config.resolve("retrieval.rerank_enabled", env={}, path=harness)["value"] is True
    assert not harness.exists(), "resolving a default must not create the file"


def test_the_six_keys_are_exactly_the_planned_six():
    assert set(harness_config.HARNESS_KEYS) == {
        "retrieval.embedding_model.memory", "retrieval.embedding_model.code_index",
        "retrieval.rerank_model", "retrieval.embedding_provider",
        "retrieval.embedding_dimensions", "retrieval.rerank_enabled",
    }


def test_migration_034_seeds_the_catalogue_defaults():
    """The SQL cannot read the catalogue, so the two are held together here."""
    sql = MIGRATION.read_text(encoding="utf-8")
    seeded = dict(re.findall(r"\('(memory|code_index|rerank)',\s*'([^']+)'\)", sql))
    uses = _catalogue()["uses"]
    assert seeded == {use: spec["default"] for use, spec in uses.items()}


def test_the_product_modules_resolve_the_models_instead_of_naming_them():
    from services import pg_store, rlm_embeddings

    assert rlm_embeddings.VOYAGE_MODEL == "voyage-code-4"
    assert rlm_embeddings.VOYAGE_OUTPUT_DIMENSION == 1024
    providers = pg_store.PGStore.EMBEDDING_PROVIDERS
    assert providers["voyage"]["default_model"] == "voyage-code-4"
    assert providers["voyage"]["rerank_model"] == "rerank-3"
    assert providers["openai"]["default_model"] == "text-embedding-3-small"
    for name in ("rlm_embeddings.py", "pg_store.py"):
        code = "\n".join(
            line.split("#", 1)[0] for line in
            (_REPO / "services" / name).read_text(encoding="utf-8").splitlines())
        assert not re.search(r"""=\s*["']voyage-code-\d["']""", code), name
        assert not re.search(r""":\s*["'](voyage-code-\d|rerank-[\d.]+)["']""", code), name


# ── validation: rejected, never defaulted ────────────────────────────────────

def test_an_unknown_model_is_rejected_with_the_catalogue_list(harness):
    with pytest.raises(harness_config.HarnessConfigError) as caught:
        harness_config.set_value("retrieval.embedding_model.memory", "voyage-code-9",
                                 env={"GSD_FORCE_SQLITE": "1"}, path=harness)
    error = caught.value
    assert error.code == "unknown_model"
    for listed in ("voyage-code-4", "voyage-4", "voyage-code-3"):
        assert listed in error.message
    assert "rerank-3" not in error.details["valid"], "a rerank model is not an embedder"
    assert not harness.exists(), "a refused value must write nothing"


def test_a_rerank_model_is_not_accepted_as_an_embedding_model_or_the_reverse(harness):
    for key, wrong in (("retrieval.embedding_model.code_index", "rerank-3"),
                       ("retrieval.rerank_model", "voyage-code-4")):
        with pytest.raises(harness_config.HarnessConfigError) as caught:
            harness_config.validate(key, wrong, env={}, path=harness)
        assert caught.value.code == "unknown_model"


def test_a_dimension_mismatch_is_rejected_naming_the_migration(harness, fixture_catalogue):
    path, env = fixture_catalogue
    data = json.loads(path.read_text(encoding="utf-8"))
    wide = dict(data["models"][0], id="fixture-wide-2048", default_dimension=2048,
                dimensions=[2048])
    data["models"].append(wide)
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(harness_config.HarnessConfigError) as caught:
        harness_config.validate("retrieval.embedding_model.memory", "fixture-wide-2048",
                                env=env, path=harness)
    error = caught.value
    assert error.code == "dimension_mismatch"
    assert "034-embedding-blue-green.sql" in error.message
    assert "2048" in error.message and "1024" in error.message

    with pytest.raises(harness_config.HarnessConfigError) as caught:
        harness_config.validate("retrieval.embedding_dimensions", "512", env={}, path=harness)
    assert caught.value.code == "dimension_mismatch"
    assert "034-embedding-blue-green.sql" in caught.value.message


def test_an_invalid_stored_or_env_value_is_reported_not_defaulted(harness):
    harness.parent.mkdir(parents=True)
    harness.write_text(json.dumps(
        {"retrieval": {"embedding_model": {"memory": "not-a-model"}}}), encoding="utf-8")
    with pytest.raises(harness_config.HarnessConfigError) as caught:
        harness_config.resolve("retrieval.embedding_model.memory", env={}, path=harness)
    assert caught.value.code == "unknown_model"
    with pytest.raises(harness_config.HarnessConfigError):
        harness_config.resolve("retrieval.rerank_model",
                               env={"GSD_RERANK_MODEL": "rerank-0"}, path=harness)
    with pytest.raises(harness_config.HarnessConfigError):
        harness_config.validate("retrieval.embedding_provider", "bedrock", env={}, path=harness)
    with pytest.raises(harness_config.HarnessConfigError):
        harness_config.validate("retrieval.rerank_enabled", "maybe", env={}, path=harness)


def test_the_environment_overrides_the_file_and_says_so(harness):
    harness_config.write_value("retrieval.rerank_model", "rerank-3-lite", env={}, path=harness)
    stored = harness_config.resolve("retrieval.rerank_model", env={}, path=harness)
    assert (stored["value"], stored["source"]) == ("rerank-3-lite", "harness")
    overridden = harness_config.resolve(
        "retrieval.rerank_model", env={"GSD_RERANK_MODEL": "rerank-2.5"}, path=harness)
    assert (overridden["value"], overridden["source"]) == ("rerank-2.5", "env")
    assert overridden["default"] == "rerank-3"


def test_the_enum_is_derived_from_the_catalogue(harness, fixture_catalogue):
    """A model added to the catalogue is accepted with NO code edit."""
    path, env = fixture_catalogue
    with pytest.raises(harness_config.HarnessConfigError):
        harness_config.validate("retrieval.embedding_model.memory", "fixture-code-5",
                                env=env, path=harness)
    data = json.loads(path.read_text(encoding="utf-8"))
    data["models"].append(dict(data["models"][0], id="fixture-code-5"))
    path.write_text(json.dumps(data), encoding="utf-8")
    assert harness_config.validate("retrieval.embedding_model.memory", "fixture-code-5",
                                   env=env, path=harness) == "fixture-code-5"
    enum = harness_config.resolve("retrieval.embedding_model.memory", env=env, path=harness)["enum"]
    assert "fixture-code-5" in enum
    assert enum == harness_config.models_of_kind("embed", env=env)


# ── the harness file: atomic, backed up, audited ─────────────────────────────

def test_a_write_keeps_the_previous_file_and_appends_an_audit_entry(harness):
    first = harness_config.write_value("retrieval.rerank_model", "rerank-3-lite",
                                       actor="tester", env={}, path=harness)
    assert first["backup"] is None, "there was no previous file to keep"
    before = harness.read_bytes()

    second = harness_config.write_value("retrieval.embedding_model.memory", "voyage-4",
                                        actor="tester", env={}, path=harness)
    # THE PREVIOUS FILE IS KEPT, byte for byte.
    backup = pathlib.Path(second["backup"])
    assert backup.parent == harness.parent / "config-backups"
    assert backup.read_bytes() == before
    # ...and an audit entry was written for EACH change.
    audit = [json.loads(line) for line in
             (harness.parent / "config-audit.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [a["context"]["key"] for a in audit] == [
        "retrieval.rerank_model", "retrieval.embedding_model.memory"]
    assert audit[1]["context"] == {
        "key": "retrieval.embedding_model.memory", "previous": None, "value": "voyage-4",
        "actor": "tester", "backup": str(backup)}
    assert set(audit[1]) == {"timestamp", "level", "service", "message", "context"}
    # Both settings are in the file, and no temp file is left behind.
    stored = json.loads(harness.read_text(encoding="utf-8"))
    assert stored == {"retrieval": {"rerank_model": "rerank-3-lite",
                                    "embedding_model": {"memory": "voyage-4"}}}
    assert [p.name for p in harness.parent.iterdir() if ".tmp." in p.name] == []


def test_the_write_is_a_replace_of_a_complete_file():
    source = (_REPO / "services" / "harness_config.py").read_text(encoding="utf-8")
    assert "os.replace(tmp, target)" in source


def test_a_malformed_file_is_a_typed_error_and_is_never_overwritten(harness):
    harness.parent.mkdir(parents=True)
    harness.write_text("{ this is not json", encoding="utf-8")
    with pytest.raises(harness_config.HarnessConfigError) as caught:
        harness_config.resolve("retrieval.rerank_model", env={}, path=harness)
    assert caught.value.code == "harness_config_malformed"
    assert caught.value.to_dict()["error"] == "harness_config_malformed"
    with pytest.raises(harness_config.HarnessConfigError):
        harness_config.write_value("retrieval.rerank_model", "rerank-3", env={}, path=harness)
    assert harness.read_text(encoding="utf-8") == "{ this is not json"


def test_the_config_path_is_under_the_home_directory(monkeypatch, tmp_path):
    monkeypatch.setattr(pathlib.Path, "home", classmethod(lambda cls: tmp_path))
    assert harness_config.config_path() == tmp_path / ".amauta" / "config.json"
    source = (_REPO / "services" / "harness_config.py").read_text(encoding="utf-8")
    assert "pathlib.Path.home()" in source


def test_without_a_database_the_setting_is_saved_and_the_reembed_is_reported_unmarked(harness):
    result = harness_config.set_value(
        "retrieval.embedding_model.memory", "voyage-code-3",
        env={"GSD_FORCE_SQLITE": "1"}, path=harness)
    assert result["value"] == "voyage-code-3" and result["scope"] == "harness"
    assert result["reembed"] == {"marked": False, "reason": "no_database", "use": "memory"}
    rows = {r["key"]: r for r in
            harness_config.describe_all(env={"GSD_FORCE_SQLITE": "1"}, path=harness)}
    row = rows["retrieval.embedding_model.memory"]
    assert (row["value"], row["default"], row["source"]) == (
        "voyage-code-3", "voyage-code-4", "harness")
    assert row["pending_reembed"] is False and row["store"] == "no_database"


def test_pending_reembed_follows_the_state_not_the_file(harness):
    states = {"memory": {"active_model": "voyage-code-3", "phase": "steady"},
              "code_index": {"active_model": "voyage-code-4", "phase": "backfilling"},
              "rerank": {"active_model": "rerank-3", "phase": "steady"}}
    memory = harness_config.describe("retrieval.embedding_model.memory", env={},
                                     path=harness, states=states)
    code = harness_config.describe("retrieval.embedding_model.code_index", env={},
                                   path=harness, states=states)
    rerank = harness_config.describe("retrieval.rerank_model", env={}, path=harness,
                                     states=states)
    assert memory["pending_reembed"] is True, "configured voyage-code-4, live voyage-code-3"
    assert code["pending_reembed"] is True, "a backfill is running"
    assert rerank["pending_reembed"] is False


def test_the_token_estimate_over_counts_and_is_zero_for_nothing():
    assert harness_config.estimate_tokens("") == 0
    assert harness_config.estimate_tokens("a") == 1
    assert harness_config.estimate_tokens("abc") == 1
    assert harness_config.estimate_tokens("abcd") == 2
    assert harness_config.estimate_tokens("x" * 8192) == 2731


# ── doctor and /health ───────────────────────────────────────────────────────

PG_ENV = {"GSD_POSTGRES_URL": "postgresql://gsd:gsd@db.invalid:5432/none"}


@pytest.fixture
def no_state(monkeypatch):
    """No socket is opened: the state read is answered as 'unreachable'."""
    monkeypatch.setattr(harness_config, "read_states",
                        lambda env=None, dsn=None, connect_timeout=None:
                        (None, "database_unreachable"))


def test_the_reporter_is_silent_without_a_postgresql():
    assert reporting.doctor_rows({"GSD_FORCE_SQLITE": "1"}) == []
    assert reporting.doctor_rows({}) == []
    assert reporting.health_fragment({}) is None


def test_the_reporter_is_registered_under_a_health_key_without_a_plan_number(no_state):
    assert "_89_08_reporting" in report_hooks.PROVIDER_MODULES
    assert reporting.HEALTH_KEY == "embeddings"
    section = report_hooks.extra_health_rows(PG_ENV)
    assert "embeddings" in section and "_89_08_reporting" not in section
    assert report_hooks.DEGRADED_KEY not in section, section
    for path in ("services/doctor.py", "services/amauta-daemon.py"):
        assert "_89_08" not in (_REPO / path).read_text(encoding="utf-8"), path


def test_doctor_is_ok_on_the_defaults_and_warns_when_the_catalogue_is_stale(no_state):
    # The OLDEST verification among the three configured models decides.
    verified = min(datetime.date.fromisoformat(
        harness_config.model_record(m)["verified_at"])
        for m in ("voyage-code-4", "rerank-3"))
    fresh = reporting.doctor_rows(PG_ENV, today=verified + datetime.timedelta(days=90))
    assert [r[0] for r in fresh if r[1] == "embedding_catalogue"] == [report_hooks.STATUS_OK]

    stale = reporting.doctor_rows(PG_ENV, today=verified + datetime.timedelta(days=91))
    warned = [r for r in stale if r[0] == report_hooks.STATUS_WARN]
    assert warned, stale
    assert ("the embedding model catalogue has not been re-verified since %s"
            % verified.isoformat()) in warned[0][2]
    assert "docs/EMBEDDING-MODELS.md" in warned[0][2]


def test_doctor_warns_on_an_older_model_with_the_exact_command(no_state):
    env = dict(PG_ENV, GSD_EMBEDDING_MODEL_CODE_INDEX="voyage-code-3")
    rows = [r for r in reporting.doctor_rows(env) if r[0] == report_hooks.STATUS_WARN]
    assert len(rows) == 1, rows
    assert "voyage-code-3 is an older model, superseded by voyage-code-4" in rows[0][2]
    assert "`config-set retrieval.embedding_model.code_index voyage-code-4`" in rows[0][2]
    assert rows[0][3]["command"] == (
        "config-set retrieval.embedding_model.code_index voyage-code-4")


def test_doctor_fails_on_a_model_absent_from_the_catalogue(no_state):
    env = dict(PG_ENV, GSD_EMBEDDING_MODEL_MEMORY="voyage-code-9")
    failed = [r for r in reporting.doctor_rows(env) if r[0] == report_hooks.STATUS_FAIL]
    assert len(failed) == 1 and failed[0][1] == "embedding_catalogue"
    assert "retrieval.embedding_model.memory" in failed[0][2]
    assert "voyage-code-9" in failed[0][2]
    assert reporting.health_fragment(env)["degraded"] is True


def test_doctor_reports_the_embedding_state_phase_per_use(monkeypatch):
    states = {
        "memory": {"active_model": "voyage-code-3", "target_model": "voyage-code-4",
                   "phase": "backfilling", "rows_total": 100, "rows_done": 40,
                   "tokens_spent": 1234, "budget_tokens": 5000},
        "code_index": {"active_model": "voyage-code-4", "target_model": None,
                       "phase": "steady", "rows_total": 0, "rows_done": 0,
                       "tokens_spent": 0, "budget_tokens": None},
    }
    monkeypatch.setattr(harness_config, "read_states",
                        lambda env=None, dsn=None, connect_timeout=None: (states, None))
    rows = {r[2]: r for r in reporting.doctor_rows(PG_ENV) if r[1] == "embedding_state"}
    half = [d for d in rows if d.startswith("memory: phase backfilling")]
    assert half and rows[half[0]][0] == report_hooks.STATUS_WARN
    assert "40 of 100 rows re-embedded for voyage-code-4" in half[0]
    assert "queries still answer from voyage-code-3" in half[0]
    assert rows["code_index: phase steady on voyage-code-4"][0] == report_hooks.STATUS_OK
    fragment = reporting.health_fragment(PG_ENV)
    assert fragment["reembed_pending"] is True
    assert fragment["state"]["memory"]["phase"] == "backfilling"
