#!/usr/bin/env python3
"""tests/test_68_mobile_toolchain.py — Phase 68 MOBL-03

Unit tests for services/mobile_toolchain.py: mocked subprocess.run / env
vars so the suite is CI-safe -- no real Xcode/Android SDK required.
Covers the classification matrix: iOS full/degraded/absent, Android
full/degraded/absent, probe-timeout classification, and a frozen-
vocabulary property check (every outcome in {full,degraded,absent}, and
every non-full outcome carries a non-empty skip_reason).

Run: python3 -m pytest tests/test_68_mobile_toolchain.py -v
"""

import os
import subprocess
import sys

# ── sys.path: ensure repo root is importable from any cwd ────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import pytest

from services import mobile_toolchain


SIMCTL_JSON_ONE_AVAILABLE = """
{
  "devices": {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
      {"udid": "AAAA", "isAvailable": true, "name": "iPhone 16"}
    ]
  }
}
"""

SIMCTL_JSON_ZERO_AVAILABLE = """
{
  "devices": {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-2": []
  }
}
"""


def _completed(returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args=["fake"], returncode=returncode, stdout=stdout, stderr=stderr)


@pytest.fixture(autouse=True)
def _clean_android_env(monkeypatch):
    """Every test starts with no Android SDK env vars set unless it opts in."""
    monkeypatch.delenv("ANDROID_HOME", raising=False)
    monkeypatch.delenv("ANDROID_SDK_ROOT", raising=False)
    yield


# ── iOS matrix ────────────────────────────────────────────────────────────────

def test_ios_full_xcodebuild_ok_and_available_simulator(monkeypatch):
    """1. iOS full: xcodebuild ok + simctl JSON with >=1 available device."""
    monkeypatch.setattr(mobile_toolchain.sys, "platform", "darwin")

    def fake_run(cmd, **kwargs):
        if cmd[0] == "xcodebuild":
            return _completed(0, "Xcode 15.0\nBuild version 15A240d\n")
        if cmd[:2] == ["xcrun", "simctl"]:
            return _completed(0, SIMCTL_JSON_ONE_AVAILABLE)
        raise AssertionError(f"unexpected cmd: {cmd}")

    monkeypatch.setattr(mobile_toolchain.subprocess, "run", fake_run)

    result = mobile_toolchain.detect_ios()
    assert result["outcome"] == "full"
    assert not result["skip_reason"]


def test_ios_degraded_zero_available_simulators(monkeypatch):
    """2. iOS degraded: xcodebuild ok + simctl JSON with 0 available devices
    -- outcome degraded AND skip_reason mentions simulator."""
    monkeypatch.setattr(mobile_toolchain.sys, "platform", "darwin")

    def fake_run(cmd, **kwargs):
        if cmd[0] == "xcodebuild":
            return _completed(0, "Xcode 15.0\n")
        if cmd[:2] == ["xcrun", "simctl"]:
            return _completed(0, SIMCTL_JSON_ZERO_AVAILABLE)
        raise AssertionError(f"unexpected cmd: {cmd}")

    monkeypatch.setattr(mobile_toolchain.subprocess, "run", fake_run)

    result = mobile_toolchain.detect_ios()
    assert result["outcome"] == "degraded"
    assert result["skip_reason"]
    assert "simulator" in result["skip_reason"].lower()


def test_ios_absent_filenotfound_from_xcodebuild(monkeypatch):
    """3. iOS absent: FileNotFoundError from xcodebuild -- outcome absent,
    no exception escapes."""
    monkeypatch.setattr(mobile_toolchain.sys, "platform", "darwin")

    def fake_run(cmd, **kwargs):
        if cmd[0] == "xcodebuild":
            raise FileNotFoundError("no such file: xcodebuild")
        raise AssertionError(f"unexpected cmd: {cmd}")

    monkeypatch.setattr(mobile_toolchain.subprocess, "run", fake_run)

    result = mobile_toolchain.detect_ios()  # must not raise
    assert result["outcome"] == "absent"
    assert result["skip_reason"]


def test_ios_absent_on_non_darwin_platform(monkeypatch):
    """Non-Darwin platform classifies absent without probing at all."""
    monkeypatch.setattr(mobile_toolchain.sys, "platform", "linux")

    def fake_run(cmd, **kwargs):
        raise AssertionError("no subprocess call expected on non-Darwin platform")

    monkeypatch.setattr(mobile_toolchain.subprocess, "run", fake_run)

    result = mobile_toolchain.detect_ios()
    assert result["outcome"] == "absent"
    assert result["skip_reason"]


# ── Android matrix ────────────────────────────────────────────────────────────

def test_android_full_sdk_avd_and_acceleration(monkeypatch):
    """4. Android full: ANDROID_HOME set + >=1 AVD + acceleration present."""
    monkeypatch.setenv("ANDROID_HOME", "/fake/android/sdk")
    monkeypatch.setattr(mobile_toolchain.sys, "platform", "darwin")  # HVF assumed ok

    def fake_run(cmd, **kwargs):
        base = os.path.basename(cmd[0])
        if base == "avdmanager":
            return _completed(0, "Available Android Virtual Devices:\n    Name: Pixel_7_API_34\n")
        raise AssertionError(f"unexpected cmd: {cmd}")

    monkeypatch.setattr(mobile_toolchain.subprocess, "run", fake_run)

    result = mobile_toolchain.detect_android()
    assert result["outcome"] == "full"
    assert not result["skip_reason"]


def test_android_degraded_zero_avds(monkeypatch):
    """5. Android degraded: SDK set + zero AVDs -- skip_reason names AVD."""
    monkeypatch.setenv("ANDROID_HOME", "/fake/android/sdk")
    monkeypatch.setattr(mobile_toolchain.sys, "platform", "darwin")

    def fake_run(cmd, **kwargs):
        base = os.path.basename(cmd[0])
        if base == "avdmanager":
            return _completed(0, "Available Android Virtual Devices:\n")
        if base == "emulator":
            return _completed(0, "")
        raise AssertionError(f"unexpected cmd: {cmd}")

    monkeypatch.setattr(mobile_toolchain.subprocess, "run", fake_run)

    result = mobile_toolchain.detect_android()
    assert result["outcome"] == "degraded"
    assert result["skip_reason"]
    assert "avd" in result["skip_reason"].lower()


def test_android_absent_no_sdk_env(monkeypatch):
    """6. Android absent: no ANDROID_HOME/ANDROID_SDK_ROOT."""
    def fake_run(cmd, **kwargs):
        raise AssertionError("no subprocess call expected when SDK env is absent")

    monkeypatch.setattr(mobile_toolchain.subprocess, "run", fake_run)

    result = mobile_toolchain.detect_android()
    assert result["outcome"] == "absent"
    assert result["skip_reason"]


# ── Timeout classification ────────────────────────────────────────────────────

def test_probe_timeout_classifies_never_raises(monkeypatch):
    """7. Probe timeout (TimeoutExpired) classifies (degraded or absent with
    skip_reason), never raises."""
    monkeypatch.setattr(mobile_toolchain.sys, "platform", "darwin")

    def fake_run(cmd, **kwargs):
        if cmd[0] == "xcodebuild":
            return _completed(0, "Xcode 15.0\n")
        if cmd[:2] == ["xcrun", "simctl"]:
            raise subprocess.TimeoutExpired(cmd=cmd, timeout=10)
        raise AssertionError(f"unexpected cmd: {cmd}")

    monkeypatch.setattr(mobile_toolchain.subprocess, "run", fake_run)

    result = mobile_toolchain.detect_ios()  # must not raise
    assert result["outcome"] in ("degraded", "absent")
    assert result["skip_reason"]


def test_android_probe_timeout_classifies_never_raises(monkeypatch):
    """Android-side timeout mirrors the iOS timeout case -- avdmanager hangs,
    the emulator fallback also hangs, classification still completes."""
    monkeypatch.setenv("ANDROID_HOME", "/fake/android/sdk")
    monkeypatch.setattr(mobile_toolchain.sys, "platform", "darwin")

    def fake_run(cmd, **kwargs):
        base = os.path.basename(cmd[0])
        if base in ("avdmanager", "emulator"):
            raise subprocess.TimeoutExpired(cmd=cmd, timeout=10)
        raise AssertionError(f"unexpected cmd: {cmd}")

    monkeypatch.setattr(mobile_toolchain.subprocess, "run", fake_run)

    result = mobile_toolchain.detect_android()  # must not raise
    assert result["outcome"] in ("degraded", "absent")
    assert result["skip_reason"]


# ── Frozen vocabulary lock ────────────────────────────────────────────────────

def test_frozen_vocabulary_lock_across_matrix(monkeypatch):
    """8. Every returned outcome is a member of {"full","degraded","absent"}
    and non-full ALWAYS carries a non-empty skip_reason (property asserted
    across all matrix cases above, re-run here as a single property check)."""
    monkeypatch.setattr(mobile_toolchain.sys, "platform", "darwin")

    scenarios = []

    # iOS full
    def ios_full_run(cmd, **kwargs):
        if cmd[0] == "xcodebuild":
            return _completed(0, "Xcode 15.0\n")
        if cmd[:2] == ["xcrun", "simctl"]:
            return _completed(0, SIMCTL_JSON_ONE_AVAILABLE)
        raise AssertionError(cmd)

    monkeypatch.setattr(mobile_toolchain.subprocess, "run", ios_full_run)
    scenarios.append(mobile_toolchain.detect_ios())

    # iOS degraded
    def ios_degraded_run(cmd, **kwargs):
        if cmd[0] == "xcodebuild":
            return _completed(0, "Xcode 15.0\n")
        if cmd[:2] == ["xcrun", "simctl"]:
            return _completed(0, SIMCTL_JSON_ZERO_AVAILABLE)
        raise AssertionError(cmd)

    monkeypatch.setattr(mobile_toolchain.subprocess, "run", ios_degraded_run)
    scenarios.append(mobile_toolchain.detect_ios())

    # iOS absent
    def ios_absent_run(cmd, **kwargs):
        raise FileNotFoundError("no xcodebuild")

    monkeypatch.setattr(mobile_toolchain.subprocess, "run", ios_absent_run)
    scenarios.append(mobile_toolchain.detect_ios())

    # Android absent (no env)
    scenarios.append(mobile_toolchain.detect_android())

    # Android degraded (env set, zero AVDs)
    monkeypatch.setenv("ANDROID_HOME", "/fake/android/sdk")

    def android_degraded_run(cmd, **kwargs):
        base = os.path.basename(cmd[0])
        if base == "avdmanager":
            return _completed(0, "Available Android Virtual Devices:\n")
        if base == "emulator":
            return _completed(0, "")
        raise AssertionError(cmd)

    monkeypatch.setattr(mobile_toolchain.subprocess, "run", android_degraded_run)
    scenarios.append(mobile_toolchain.detect_android())

    # Android full
    def android_full_run(cmd, **kwargs):
        base = os.path.basename(cmd[0])
        if base == "avdmanager":
            return _completed(0, "Available Android Virtual Devices:\n    Name: Pixel_7_API_34\n")
        raise AssertionError(cmd)

    monkeypatch.setattr(mobile_toolchain.subprocess, "run", android_full_run)
    scenarios.append(mobile_toolchain.detect_android())

    assert len(scenarios) == 6
    for outcome_dict in scenarios:
        outcome = outcome_dict["outcome"]
        assert outcome in ("full", "degraded", "absent"), f"unfrozen outcome: {outcome!r}"
        if outcome == "full":
            assert not outcome_dict["skip_reason"]
        else:
            assert outcome_dict["skip_reason"], f"{outcome} outcome missing skip_reason"


def test_detect_all_shape_and_vocabulary(monkeypatch):
    """detect_all() returns ios/android/detected_at, and both platforms
    respect the frozen-vocabulary + skip_reason invariant."""
    monkeypatch.setattr(mobile_toolchain.sys, "platform", "darwin")

    def fake_run(cmd, **kwargs):
        if cmd[0] == "xcodebuild":
            return _completed(0, "Xcode 15.0\n")
        if cmd[:2] == ["xcrun", "simctl"]:
            return _completed(0, SIMCTL_JSON_ZERO_AVAILABLE)
        raise AssertionError(cmd)

    monkeypatch.setattr(mobile_toolchain.subprocess, "run", fake_run)

    result = mobile_toolchain.detect_all()
    assert set(result.keys()) == {"ios", "android", "detected_at"}
    for platform_dict in (result["ios"], result["android"]):
        assert platform_dict["outcome"] in ("full", "degraded", "absent")
        if platform_dict["outcome"] != "full":
            assert platform_dict["skip_reason"]
        assert "probes" in platform_dict
