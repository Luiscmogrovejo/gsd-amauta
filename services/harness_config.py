#!/usr/bin/env python3
"""services/harness_config.py — harness-level settings and the model catalogue.

Phase 89 plan 89-08 (RET-05, decisions 5 and D6).

WHY A SECOND CONFIG FILE
────────────────────────
``config-get`` / ``config-set`` used to know one file, ``<cwd>/.planning/config.json``,
which is per project and gitignored. The embedding model is not a per-project
fact: it governs ONE shared PostgreSQL store that every project's memories and
code chunks live in. Two projects with different
``retrieval.embedding_model.memory`` would be exactly the mixed-vector store that
criterion 6 forbids. So the six ``retrieval.*`` keys below are HARNESS-level and
live in ``~/.amauta/config.json``; every other key keeps its project file.

ONE MODULE, TWO CALLERS
───────────────────────
The Python services import this module; ``get-shit-done/bin/lib/config.cjs``
spawns it (``harness_config.py get|set|keys|path``). There is deliberately no
second implementation in JavaScript, so the two sides cannot disagree about where
the file is, what a key means, or which model ids are valid.

THE CATALOGUE IS THE VALIDATOR
──────────────────────────────
``get-shit-done/config/embedding-models.json`` lists every model that may be
configured. Voyage publishes no model-list endpoint and no usage endpoint, so
there is nothing to discover from: the file is the authority, and the enum for
the three model keys is DERIVED from it (never duplicated here or in
``config.cjs``). An unknown id, or a model whose dimension does not fit the
``vector(1024)`` columns, is REJECTED. There is no silent fallback to a default
on an invalid value — a wrong model name that quietly became the default would
embed a whole corpus with a model nobody chose.

A SETTING IS THE *DESIRED* MODEL, NOT THE LIVE ONE
──────────────────────────────────────────────────
Changing ``retrieval.embedding_model.*`` never switches the model queries use.
It records the target in ``embedding_state`` (``target_model``,
``phase='backfilling'``) and leaves ``active_model`` alone; the vectors are
rebuilt beside the old ones by ``services/embedding_backfill.py`` and the switch
is one recorded cutover. See docs/EMBEDDING-MODELS.md.

EVERY CHANGE IS BACKED UP AND AUDITED
─────────────────────────────────────
A write keeps the previous file under ``~/.amauta/config-backups/`` and appends
one line to ``~/.amauta/config-audit.jsonl`` before the new file replaces the
old one atomically (temp file + ``os.replace``).

Example:
    >>> resolve("retrieval.rerank_model", env={}, path="/nonexistent/config.json")["value"]
    'rerank-3'
"""
import argparse
import datetime
import json
import logging
import os
import pathlib
import sys

log = logging.getLogger("amauta.harness_config")

#: The dimension every vector column declares (migrations 003, 010, 013, 018,
#: 019, 029, 034). A model whose default dimension differs cannot be stored
#: without a migration that retypes those columns.
COLUMN_DIMENSION = 1024

#: The migration a different dimension would have to follow.
DIMENSION_MIGRATION = "migrations/034-embedding-blue-green.sql"

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_REFUSED = 2
EXIT_MALFORMED = 3

#: Environment variable naming an alternative catalogue file (tests, fixtures).
CATALOGUE_ENV = "GSD_EMBEDDING_CATALOGUE"

USE_MEMORY = "memory"
USE_CODE_INDEX = "code_index"
USE_RERANK = "rerank"

PROVIDERS = ("voyage", "openai", "local")

#: The six harness-level keys. ``kind`` selects the catalogue records that form
#: the enum of a model key; ``env`` is the environment override (source "env").
HARNESS_KEYS = {
    "retrieval.embedding_model.memory": {
        "type": "model", "kind": "embed", "use": USE_MEMORY,
        "env": "GSD_EMBEDDING_MODEL_MEMORY", "restart": "none",
    },
    "retrieval.embedding_model.code_index": {
        "type": "model", "kind": "embed", "use": USE_CODE_INDEX,
        "env": "GSD_EMBEDDING_MODEL_CODE_INDEX", "restart": "rlm-service",
    },
    "retrieval.rerank_model": {
        "type": "model", "kind": "rerank", "use": USE_RERANK,
        "env": "GSD_RERANK_MODEL", "restart": "none",
    },
    "retrieval.embedding_provider": {
        "type": "enum", "enum": PROVIDERS,
        "env": "GSD_EMBEDDING_PROVIDER", "restart": "none",
    },
    "retrieval.embedding_dimensions": {
        "type": "int", "env": "GSD_EMBEDDING_DIMENSIONS", "restart": "migration",
    },
    "retrieval.rerank_enabled": {
        "type": "bool", "env": "GSD_RERANK_ENABLED", "restart": "none",
    },
}

USE_TO_KEY = {spec["use"]: key for key, spec in HARNESS_KEYS.items() if "use" in spec}


class HarnessConfigError(Exception):
    """A typed refusal: ``{code, message, details}``, never a bare string.

    Args:
        code: machine-readable reason (``unknown_key``, ``unknown_model``,
            ``dimension_mismatch``, ``invalid_value``, ``harness_config_malformed``,
            ``catalogue_unreadable``).
        message: one sentence a person can act on.
        details: structured context.
    """

    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}

    def to_dict(self):
        """Returns: dict ``{"error": code, "message": ..., "details": {...}}``."""
        return {"error": self.code, "message": self.message, "details": self.details}


# ── the catalogue ────────────────────────────────────────────────────────────

def catalogue_path(env=None):
    """Where the catalogue is read from.

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        pathlib.Path: ``$GSD_EMBEDDING_CATALOGUE`` when set, else the shipped
        ``get-shit-done/config/embedding-models.json`` (repository layout first,
        then the installed layout).
    """
    env = os.environ if env is None else env
    explicit = (env.get(CATALOGUE_ENV) or "").strip()
    if explicit:
        return pathlib.Path(explicit)
    here = pathlib.Path(__file__).resolve().parent
    candidates = [
        here.parent / "get-shit-done" / "config" / "embedding-models.json",
        here.parent / "config" / "embedding-models.json",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return candidates[0]


_CATALOGUE_MEMO = {}


def load_catalogue(path=None, env=None):
    """Read and shape-check the catalogue.

    Args:
        path: explicit file; :func:`catalogue_path` when omitted.
        env: mapping consulted for the override variable.

    Returns:
        dict: the parsed file, with ``models`` a list of records.

    Raises:
        HarnessConfigError: ``catalogue_unreadable`` when the file is missing,
            is not JSON, or has no ``models`` list.
    """
    target = pathlib.Path(path) if path else catalogue_path(env)
    try:
        stat = target.stat()
        memo_key = (str(target), stat.st_mtime_ns, stat.st_size)
    except OSError as exc:
        raise HarnessConfigError(
            "catalogue_unreadable",
            "the embedding model catalogue cannot be read at %s" % target,
            {"path": str(target), "reason": type(exc).__name__})
    if memo_key in _CATALOGUE_MEMO:
        return _CATALOGUE_MEMO[memo_key]
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise HarnessConfigError(
            "catalogue_unreadable",
            "the embedding model catalogue at %s is not valid JSON" % target,
            {"path": str(target), "reason": str(exc)})
    if not isinstance(data, dict) or not isinstance(data.get("models"), list):
        raise HarnessConfigError(
            "catalogue_unreadable",
            "the embedding model catalogue at %s has no `models` list" % target,
            {"path": str(target)})
    _CATALOGUE_MEMO.clear()
    _CATALOGUE_MEMO[memo_key] = data
    return data


def model_record(model_id, catalogue=None, env=None):
    """The catalogue record for *model_id*, or None when it is not listed."""
    catalogue = catalogue or load_catalogue(env=env)
    for record in catalogue["models"]:
        if record.get("id") == model_id:
            return record
    return None


def models_of_kind(kind, catalogue=None, env=None):
    """Ids of every catalogue record of *kind* (``embed`` or ``rerank``), in file order."""
    catalogue = catalogue or load_catalogue(env=env)
    return [m["id"] for m in catalogue["models"] if m.get("kind") == kind]


def default_for(key, catalogue=None, env=None):
    """The default of a harness key, read from the catalogue's own header.

    Raises:
        HarnessConfigError: ``unknown_key``.
    """
    spec = _spec(key)
    catalogue = catalogue or load_catalogue(env=env)
    if spec["type"] == "model":
        return catalogue["uses"][spec["use"]]["default"]
    if key == "retrieval.embedding_provider":
        return catalogue.get("default_provider", "voyage")
    if key == "retrieval.embedding_dimensions":
        return int(catalogue.get("default_dimensions", COLUMN_DIMENSION))
    return True  # retrieval.rerank_enabled


def estimate_tokens(text, catalogue=None, env=None):
    """The pre-spend token estimate for one text: ``ceil(characters / 3)``.

    Deliberately an OVER-count (see the catalogue's ``token_estimate`` note): the
    number is what a budget is refused against, and under-counting is the
    dangerous direction.

    Returns:
        int: at least 1 for a non-empty text, 0 for an empty one.
    """
    if not text:
        return 0
    try:
        per = int((catalogue or load_catalogue(env=env))["token_estimate"]["chars_per_token"])
    except (HarnessConfigError, KeyError, TypeError, ValueError):
        per = 3
    per = max(1, per)
    return -(-len(text) // per)


# ── the harness file ─────────────────────────────────────────────────────────

def harness_dir():
    """``~/.amauta`` through ``pathlib.Path.home()`` — never ``$HOME`` (Windows)."""
    return pathlib.Path.home() / ".amauta"


def config_path():
    """The harness config file: ``~/.amauta/config.json``."""
    return harness_dir() / "config.json"


def _spec(key):
    spec = HARNESS_KEYS.get(key)
    if spec is None:
        raise HarnessConfigError(
            "unknown_key",
            "unknown harness config key %r; harness keys: %s"
            % (key, ", ".join(sorted(HARNESS_KEYS))),
            {"key": key, "harness_keys": sorted(HARNESS_KEYS)})
    return spec


def read_file(path=None):
    """The harness file as a dict; ``{}`` when it does not exist.

    Raises:
        HarnessConfigError: ``harness_config_malformed`` when the file exists and
            is not a JSON object. A malformed file is never treated as empty: that
            would silently replace every setting with its default.
    """
    target = pathlib.Path(path) if path else config_path()
    try:
        raw = target.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise HarnessConfigError(
            "harness_config_malformed",
            "the harness config at %s cannot be read" % target,
            {"path": str(target), "reason": type(exc).__name__})
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise HarnessConfigError(
            "harness_config_malformed",
            "the harness config at %s is not valid JSON; fix or remove it "
            "(previous versions are kept in %s)" % (target, target.parent / "config-backups"),
            {"path": str(target), "reason": str(exc)})
    if not isinstance(data, dict):
        raise HarnessConfigError(
            "harness_config_malformed",
            "the harness config at %s must be a JSON object" % target,
            {"path": str(target), "found": type(data).__name__})
    return data


def _dig(data, key):
    current = data
    for part in key.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _coerce(key, raw):
    """Parse a raw CLI/env/file value into the key's type (no catalogue checks)."""
    spec = _spec(key)
    kind = spec["type"]
    if kind == "bool":
        if isinstance(raw, bool):
            return raw
        text = str(raw).strip().lower()
        if text in ("true", "1", "yes", "on"):
            return True
        if text in ("false", "0", "no", "off"):
            return False
        raise HarnessConfigError(
            "invalid_value", "%s must be true or false, got %r" % (key, raw),
            {"key": key, "value": raw})
    if kind == "int":
        if isinstance(raw, bool):
            raise HarnessConfigError(
                "invalid_value", "%s must be an integer, got %r" % (key, raw),
                {"key": key, "value": raw})
        try:
            return int(str(raw).strip())
        except ValueError:
            raise HarnessConfigError(
                "invalid_value", "%s must be an integer, got %r" % (key, raw),
                {"key": key, "value": raw})
    return str(raw).strip()


def validate(key, raw, env=None, path=None, dimensions=None):
    """Validate *raw* for *key* against the catalogue. Never defaults.

    Args:
        key: a harness key.
        raw: the candidate value (string from a CLI, or a typed value).
        env: mapping consulted for the catalogue override and env sources.
        path: harness file to read the OTHER settings from.
        dimensions: the configured dimension to check a model against; resolved
            from the configuration when omitted.

    Returns:
        The coerced, valid value.

    Raises:
        HarnessConfigError: ``unknown_key``; ``unknown_model`` (message carries
            the catalogue's list); ``dimension_mismatch`` (message names the
            migration that would be needed); ``invalid_value``.
    """
    spec = _spec(key)
    value = _coerce(key, raw)
    catalogue = load_catalogue(env=env)
    if spec["type"] == "model":
        valid = models_of_kind(spec["kind"], catalogue)
        record = model_record(value, catalogue)
        if record is None or record.get("kind") != spec["kind"]:
            raise HarnessConfigError(
                "unknown_model",
                "%r is not %s model in the catalogue; valid values for %s: %s. "
                "A new model is added to get-shit-done/config/embedding-models.json "
                "(see docs/EMBEDDING-MODELS.md), never guessed."
                % (value, {"embed": "an embedding", "rerank": "a rerank"}[spec["kind"]],
                   key, ", ".join(valid)),
                {"key": key, "value": value, "valid": valid})
        if spec["kind"] == "embed":
            wanted = dimensions
            if wanted is None:
                wanted = resolve("retrieval.embedding_dimensions", env=env, path=path,
                                 _validate=False)["value"]
            if record.get("default_dimension") != wanted:
                raise HarnessConfigError(
                    "dimension_mismatch",
                    "%s produces %s-dimension vectors by default but "
                    "retrieval.embedding_dimensions is %s and every vector column is "
                    "vector(%d); storing it needs a migration that retypes the six "
                    "vector columns (the ones %s extends) and a full re-embed"
                    % (value, record.get("default_dimension"), wanted,
                       COLUMN_DIMENSION, DIMENSION_MIGRATION),
                    {"key": key, "value": value,
                     "model_dimension": record.get("default_dimension"),
                     "configured_dimension": wanted, "migration": DIMENSION_MIGRATION})
        return value
    if spec["type"] == "enum":
        if value not in spec["enum"]:
            raise HarnessConfigError(
                "invalid_value",
                "%s must be one of %s, got %r" % (key, ", ".join(spec["enum"]), value),
                {"key": key, "value": value, "valid": list(spec["enum"])})
        return value
    if key == "retrieval.embedding_dimensions":
        if value != COLUMN_DIMENSION:
            raise HarnessConfigError(
                "dimension_mismatch",
                "retrieval.embedding_dimensions is %s but every vector column is "
                "vector(%d); another dimension needs a migration that retypes the six "
                "vector columns (the ones %s extends) and a full re-embed"
                % (value, COLUMN_DIMENSION, DIMENSION_MIGRATION),
                {"key": key, "value": value, "column_dimension": COLUMN_DIMENSION,
                 "migration": DIMENSION_MIGRATION})
        return value
    return value


def resolve(key, env=None, path=None, _validate=True):
    """The effective value of a harness key, and where it came from.

    Precedence: environment variable, then the harness file, then the default.

    Args:
        key: a harness key.
        env: mapping to read; ``os.environ`` when omitted.
        path: harness file; ``~/.amauta/config.json`` when omitted.

    Returns:
        dict: ``{key, value, default, source ("env"|"harness"|"default"),
        scope: "harness", type, enum, restart_required, path}``.

    Raises:
        HarnessConfigError: when the configured value is invalid. An invalid
            value is reported, never replaced by the default.

    Example:
        >>> resolve("retrieval.embedding_model.memory", env={},
        ...         path="/nonexistent/config.json")["source"]
        'default'
    """
    spec = _spec(key)
    env = os.environ if env is None else env
    target = pathlib.Path(path) if path else config_path()
    default = default_for(key, env=env)
    source, raw = "default", default
    env_raw = (env.get(spec["env"]) or "").strip()
    if env_raw:
        source, raw = "env", env_raw
    else:
        stored = _dig(read_file(target), key)
        if stored is not None:
            source, raw = "harness", stored
    value = validate(key, raw, env=env, path=target) if _validate else _coerce(key, raw)
    enum = None
    if spec["type"] == "model":
        enum = models_of_kind(spec["kind"], env=env)
    elif spec["type"] == "enum":
        enum = list(spec["enum"])
    return {
        "key": key, "value": value, "default": default, "source": source,
        "scope": "harness", "type": spec["type"], "enum": enum,
        "restart_required": spec["restart"], "path": str(target),
    }


def configured_model(use, env=None, path=None):
    """The DESIRED model for *use* (``memory``, ``code_index`` or ``rerank``).

    Raises:
        HarnessConfigError: when the configured value is invalid.
    """
    return resolve(USE_TO_KEY[use], env=env, path=path)["value"]


def _utc_stamp():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def write_value(key, raw, actor=None, env=None, path=None):
    """Validate and persist one setting: backup, audit line, atomic replace.

    Args:
        key: a harness key.
        raw: the new value.
        actor: who made the change, for the audit line.
        env: mapping consulted for validation.
        path: harness file; ``~/.amauta/config.json`` when omitted.

    Returns:
        dict: ``{key, value, previous, path, backup, audit}`` — ``backup`` is the
        kept copy of the previous file (None when there was none).

    Raises:
        HarnessConfigError: validation refusal, or a malformed existing file
            (which is never overwritten).
    """
    target = pathlib.Path(path) if path else config_path()
    value = validate(key, raw, env=env, path=target)
    data = read_file(target)  # raises on a malformed file: never overwritten
    previous = _dig(data, key)
    target.parent.mkdir(parents=True, exist_ok=True)

    backup = None
    if target.is_file():
        backups = target.parent / "config-backups"
        backups.mkdir(parents=True, exist_ok=True)
        backup = backups / ("config-%s.json" % _utc_stamp())
        backup.write_bytes(target.read_bytes())

    node = data
    parts = key.split(".")
    for part in parts[:-1]:
        if not isinstance(node.get(part), dict):
            node[part] = {}
        node = node[part]
    node[parts[-1]] = value

    audit = target.parent / "config-audit.jsonl"
    entry = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "level": "info", "service": "harness_config", "message": "config_set",
        "context": {"key": key, "previous": previous, "value": value,
                    "actor": actor or os.environ.get("GSD_AGENT_NAME") or "operator",
                    "backup": str(backup) if backup else None},
    }
    with open(audit, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")

    tmp = target.with_name(target.name + ".tmp.%d" % os.getpid())
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, target)
    log.info("harness_config_set key=%s", key)
    return {"key": key, "value": value, "previous": previous, "path": str(target),
            "backup": str(backup) if backup else None, "audit": str(audit)}


# ── the link to embedding_state ──────────────────────────────────────────────

def _state_dsn(env=None, dsn=None):
    """The DSN to record a re-embed in, or None when there is no PostgreSQL."""
    if dsn:
        return dsn
    env = os.environ if env is None else env
    try:
        try:
            from services import infra_detect, pg_dsn
        except ImportError:  # pragma: no cover - script-launched from services/
            import infra_detect
            import pg_dsn
        if infra_detect.force_sqlite(env):
            return None
        return pg_dsn.resolve_dsn(env=env)
    except Exception as exc:  # noqa: BLE001 - "no database" is an answer, not a crash
        log.debug("harness_config_dsn_unresolved error=%s", exc)
        return None


def _backfill_module():
    try:
        from services import embedding_backfill
    except ImportError:  # pragma: no cover - script-launched from services/
        import embedding_backfill
    return embedding_backfill


def read_states(env=None, dsn=None, connect_timeout=None):
    """``embedding_state`` per use, or ``(None, reason)`` when it cannot be read.

    Returns:
        tuple: ``(states, reason)`` — ``states`` maps use to its row dict;
        ``reason`` is None on success, else ``no_database`` /
        ``database_unreachable`` / ``embedding_state_absent``.
    """
    target = _state_dsn(env, dsn)
    if not target:
        return None, "no_database"
    try:
        return _backfill_module().read_states_for_dsn(
            target, connect_timeout=connect_timeout), None
    except Exception as exc:  # noqa: BLE001 - reported as a reason, never raised
        name = type(exc).__name__
        reason = "embedding_state_absent" if name == "StateTableAbsent" else "database_unreachable"
        log.warning("harness_config_state_unreadable reason=%s error=%s", reason, name)
        return None, reason


def set_value(key, raw, actor=None, env=None, path=None, dsn=None):
    """``config-set`` for a harness key.

    For an embedding or rerank model key this ALSO records the re-embed: the new
    value becomes ``embedding_state.target_model`` with ``phase='backfilling'``,
    and ``active_model`` is NOT changed (queries keep answering from the vectors
    that exist). When no PostgreSQL is configured or reachable the setting is
    still saved and the result says the re-embed could not be recorded; the
    backfill verb reads the setting itself, so nothing is lost.

    Returns:
        dict: :func:`write_value`'s result plus ``scope`` and, for a model key,
        ``reembed: {marked, reason, use, active_model, target_model, phase}``.

    Raises:
        HarnessConfigError: validation refusal or malformed file.
    """
    result = write_value(key, raw, actor=actor, env=env, path=path)
    result["scope"] = "harness"
    spec = HARNESS_KEYS[key]
    if spec["type"] != "model":
        return result
    use = spec["use"]
    target = _state_dsn(env, dsn)
    if not target:
        result["reembed"] = {"marked": False, "reason": "no_database", "use": use}
        return result
    try:
        state = _backfill_module().mark_target_for_dsn(target, use, result["value"], actor=actor)
        result["reembed"] = dict(state, marked=True, reason=None, use=use)
    except Exception as exc:  # noqa: BLE001 - the setting IS saved; say what was not
        name = type(exc).__name__
        reason = "embedding_state_absent" if name == "StateTableAbsent" else "database_unreachable"
        log.warning("harness_config_reembed_not_marked reason=%s error=%s", reason, name)
        result["reembed"] = {"marked": False, "reason": reason, "use": use}
    return result


def describe(key, env=None, path=None, states=None, state_reason=None):
    """One key as ``config-get`` shows it: value, default, source, scope, pending re-embed."""
    row = resolve(key, env=env, path=path)
    spec = HARNESS_KEYS[key]
    row["pending_reembed"] = False
    if spec["type"] == "model":
        state = (states or {}).get(spec["use"])
        if state is not None:
            row["active_model"] = state.get("active_model")
            row["phase"] = state.get("phase")
            row["pending_reembed"] = bool(
                state.get("phase") not in (None, "steady")
                or (state.get("active_model") and state.get("active_model") != row["value"]))
        else:
            row["store"] = state_reason or "no_database"
    return row


def describe_all(env=None, path=None, dsn=None):
    """Every harness key, for ``config-get --all``."""
    states, reason = read_states(env=env, dsn=dsn)
    return [describe(key, env=env, path=path, states=states, state_reason=reason)
            for key in HARNESS_KEYS]


# ── CLI (spawned by get-shit-done/bin/lib/config.cjs) ────────────────────────

def _emit(payload):
    sys.stdout.write(json.dumps(payload, sort_keys=True, default=str) + "\n")


def main(argv=None):
    """CLI entry point.

    ``get <key>`` · ``get --all`` · ``set <key> <value>`` · ``keys`` · ``path``.
    Always prints one JSON document. Exit 0 on success, 2 on a validation
    refusal, 3 on a malformed harness file or unreadable catalogue, 1 otherwise.
    """
    parser = argparse.ArgumentParser(prog="harness_config", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="verb", required=True)
    p_get = sub.add_parser("get")
    p_get.add_argument("key", nargs="?")
    p_get.add_argument("--all", action="store_true")
    p_set = sub.add_parser("set")
    p_set.add_argument("key")
    p_set.add_argument("value")
    p_set.add_argument("--actor", default=None)
    sub.add_parser("keys")
    sub.add_parser("path")
    args = parser.parse_args(argv)
    try:
        if args.verb == "path":
            _emit({"path": str(config_path())})
        elif args.verb == "keys":
            _emit({"keys": [dict({"key": k, "default": default_for(k)},
                                 type=s["type"], restart_required=s["restart"],
                                 enum=(models_of_kind(s["kind"]) if s["type"] == "model"
                                       else list(s.get("enum") or []) or None))
                            for k, s in HARNESS_KEYS.items()]})
        elif args.verb == "get":
            if args.all or not args.key:
                _emit({"keys": describe_all()})
            else:
                states, reason = (None, None)
                if HARNESS_KEYS.get(args.key, {}).get("type") == "model":
                    states, reason = read_states()
                _emit(describe(args.key, states=states, state_reason=reason))
        else:
            _emit(set_value(args.key, args.value, actor=args.actor))
        return EXIT_OK
    except HarnessConfigError as exc:
        _emit(exc.to_dict())
        if exc.code in ("harness_config_malformed", "catalogue_unreadable"):
            return EXIT_MALFORMED
        return EXIT_REFUSED
    except Exception as exc:  # noqa: BLE001 - typed body, full trace to the log only
        log.exception("harness_config_failed")
        _emit({"error": "internal_error", "message": type(exc).__name__, "details": {}})
        return EXIT_ERROR


if __name__ == "__main__":
    # Phase 88-13: UTF-8 stdio when the console code page is not (Windows cp1252); a no-op otherwise.
    import os as _os, sys as _sys
    _sys.path.append(_os.path.dirname(_os.path.abspath(__file__)))
    try:
        from _platform import setup_stdio
    except ImportError:  # pragma: no cover - a tree without services/ on sys.path
        def setup_stdio():  # type: ignore[misc]
            return False
    setup_stdio()
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
    sys.exit(main())
