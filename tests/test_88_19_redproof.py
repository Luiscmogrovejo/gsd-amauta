"""TEMPORARY — plan 88-19 red proof. This commit is REVERTED in the next one.

One deliberately UNLISTED skip, collected by the default pytest run, so every pytest
cell must turn red with session exit 6. Without this the only evidence that the Python
gate ENFORCES on ubuntu, macOS and Windows would be a local mutation on darwin plus an
inference.
"""
import pytest


def test_88_19_red_proof_passes():
    """A control, so the file is not only a skip."""
    assert True


def test_88_19_red_proof_unlisted_skip():
    """Skips with no entry in tests/skip-exceptions.json."""
    pytest.skip("88-19 red proof: no entry in tests/skip-exceptions.json; this commit is reverted")
