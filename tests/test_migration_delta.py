#!/usr/bin/env python3
"""
tests/test_migration_delta.py — Phase 49 MOD-03/MOD-04

Pure-function tests for services/module_lifecycle.compute_migration_delta.
No PG, no filesystem required.

Tests verify:
  - Expand/contract bucket routing by filename suffix
  - Plain .sql files treated as expand by default
  - Set-difference skipping of already-applied migrations
  - Declaration order preserved (no sort applied)
  - Return shape: exactly 3 keys
"""

import pytest

from services.module_lifecycle import compute_migration_delta


# ─── Tests ────────────────────────────────────────────────────────────────────


def test_empty_inputs_returns_empty_lists():
    """Both inputs empty → three empty lists returned."""
    result = compute_migration_delta([], [])
    assert result == {
        "expand_migrations": [],
        "contract_migrations": [],
        "already_applied_skipped": [],
    }


def test_expand_suffix_routed_to_expand_bucket():
    """Files ending in -expand.sql go to expand bucket only."""
    result = compute_migration_delta(["001-name-expand.sql"], [])
    assert result["expand_migrations"] == ["001-name-expand.sql"]
    assert result["contract_migrations"] == []


def test_contract_suffix_routed_to_contract_bucket():
    """Files ending in -contract.sql go to contract bucket only."""
    result = compute_migration_delta(["002-name-contract.sql"], [])
    assert result["contract_migrations"] == ["002-name-contract.sql"]
    assert result["expand_migrations"] == []


def test_plain_sql_treated_as_expand():
    """Plain .sql files (no expand/contract suffix) go to expand bucket."""
    result = compute_migration_delta(["003-name.sql"], [])
    assert result["expand_migrations"] == ["003-name.sql"]
    assert result["contract_migrations"] == []


def test_already_applied_skipped():
    """Migrations in applied_migrations are excluded from delta and appear in skipped."""
    result = compute_migration_delta(
        ["001-a-expand.sql", "002-b.sql"],
        ["001-a-expand.sql"],
    )
    assert result["expand_migrations"] == ["002-b.sql"]
    assert result["already_applied_skipped"] == ["001-a-expand.sql"]
    assert result["contract_migrations"] == []


def test_order_preserved():
    """Declaration order from new_migrations is preserved — no alphabetical sort."""
    result = compute_migration_delta(
        ["c-expand.sql", "a-expand.sql", "b-expand.sql"],
        [],
    )
    assert result["expand_migrations"] == ["c-expand.sql", "a-expand.sql", "b-expand.sql"]


def test_mixed_expand_contract_in_one_manifest():
    """Mixed expand and contract migrations are correctly partitioned."""
    result = compute_migration_delta(
        [
            "001-a-expand.sql",
            "002-b-contract.sql",
            "003-c-expand.sql",
            "004-d-contract.sql",
        ],
        [],
    )
    assert result["expand_migrations"] == ["001-a-expand.sql", "003-c-expand.sql"]
    assert result["contract_migrations"] == ["002-b-contract.sql", "004-d-contract.sql"]


def test_returns_dict_with_three_keys():
    """Return value has exactly the three canonical keys."""
    result = compute_migration_delta(["a.sql"], [])
    assert set(result.keys()) == {
        "expand_migrations",
        "contract_migrations",
        "already_applied_skipped",
    }


def test_already_applied_partial_overlap():
    """Partial overlap: only non-applied migrations appear in delta buckets."""
    result = compute_migration_delta(
        ["a-expand.sql", "b-expand.sql", "c-contract.sql"],
        ["b-expand.sql"],
    )
    assert result["expand_migrations"] == ["a-expand.sql"]
    assert result["contract_migrations"] == ["c-contract.sql"]
    assert result["already_applied_skipped"] == ["b-expand.sql"]
