"""THROWAWAY (plan 88-15 task 10, step 3). Proves the newly REQUIRED
pytest (windows-latest) cell can actually conclude `failure`."""
import sys


def test_red_proof_windows_only():
    assert not sys.platform.startswith("win"), (
        "deliberate failure: proving pytest (windows-latest, python 3.12) can go red"
    )
