#!/usr/bin/env python3
"""gsd-amauta mobile toolchain capability detection (MOBL-03).

Classifies THIS machine's iOS (Xcode + bootable simulator) and Android
(SDK + AVD + emulator acceleration) toolchains into a frozen three-outcome
vocabulary: "full" | "degraded" | "absent". A machine with no simulators
or no AVDs is NOT broken -- degraded is an acceptable, expected result
(68-CONTEXT.md "Environment reality"). Detection NEVER raises: every
subprocess probe is bounded (timeout=10s) and wrapped in try/except so a
missing binary or a slow/uncooperative tool degrades classification
instead of crashing the caller (doctor.py, in particular, must never see
an exception escape this module).

Run: python3 services/mobile_toolchain.py --json
     python3 services/mobile_toolchain.py          (human table)
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

PROBE_TIMEOUT = 10  # seconds -- bounded probes per plan 68-01 must_haves

# Frozen outcome vocabulary. 68-03's E2E task and 68-04's docs reference
# these exact strings by value -- do not rename.
OUTCOME_FULL = "full"
OUTCOME_DEGRADED = "degraded"
OUTCOME_ABSENT = "absent"


def _run(cmd, timeout=PROBE_TIMEOUT):
    """Run a subprocess probe, never raising.

    Returns a dict {"ok": bool, "returncode": int|None, "stdout": str,
    "stderr": str, "error": str|None}. FileNotFoundError (binary missing),
    subprocess.TimeoutExpired (probe hung), and OSError (any other
    platform-level failure) are all captured as classification input --
    none of them escape as an exception.
    """
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            text=True,
        )
        return {
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "stdout": proc.stdout or "",
            "stderr": proc.stderr or "",
            "error": None,
        }
    except FileNotFoundError as e:
        return {"ok": False, "returncode": None, "stdout": "", "stderr": "", "error": f"binary not found: {e}"}
    except subprocess.TimeoutExpired as e:
        return {"ok": False, "returncode": None, "stdout": "", "stderr": "", "error": f"probe timed out after {timeout}s: {e}"}
    except OSError as e:
        return {"ok": False, "returncode": None, "stdout": "", "stderr": "", "error": f"OS error: {e}"}


def _count_available_simulators(simctl_json_stdout):
    """Parse `xcrun simctl list devices available --json` stdout.

    Returns an int count of available devices, or None if the JSON could
    not be parsed (treated as classification input, not a raise).
    """
    try:
        data = json.loads(simctl_json_stdout)
    except (json.JSONDecodeError, TypeError):
        return None
    devices = data.get("devices", {})
    count = 0
    for _runtime, dev_list in devices.items():
        for dev in dev_list:
            if dev.get("isAvailable", True):
                count += 1
    return count


def detect_ios():
    """Classify the iOS toolchain: Xcode presence + bootable simulator.

    - Non-Darwin platform: absent (Xcode is Darwin-only).
    - No xcodebuild binary: absent.
    - xcodebuild present, simctl reports 0 available devices (or the
      simctl probe itself failed/timed out): degraded.
    - xcodebuild present + >=1 available simulator device: full.
    """
    probes = {}

    if sys.platform != "darwin":
        probes["platform"] = sys.platform
        return {
            "outcome": OUTCOME_ABSENT,
            "skip_reason": f"non-Darwin platform ({sys.platform}) -- Xcode/xcodebuild is macOS-only",
            "probes": probes,
        }

    xcodebuild = _run(["xcodebuild", "-version"])
    probes["xcodebuild_version"] = xcodebuild

    if not xcodebuild["ok"]:
        reason = xcodebuild["error"] or f"xcodebuild -version exited {xcodebuild['returncode']}"
        return {
            "outcome": OUTCOME_ABSENT,
            "skip_reason": f"Xcode not installed or xcodebuild unavailable -- {reason}",
            "probes": probes,
        }

    simctl = _run(["xcrun", "simctl", "list", "devices", "available", "--json"])
    probes["simctl_list_available"] = simctl

    if not simctl["ok"]:
        reason = simctl["error"] or f"simctl exited {simctl['returncode']}"
        return {
            "outcome": OUTCOME_DEGRADED,
            "skip_reason": (
                "Xcode present but `xcrun simctl list devices available --json` "
                f"failed -- {reason}; loop degrades to compile+unit-test only"
            ),
            "probes": probes,
        }

    available_count = _count_available_simulators(simctl["stdout"])
    probes["available_simulator_count"] = available_count

    if not available_count:
        return {
            "outcome": OUTCOME_DEGRADED,
            "skip_reason": (
                "no bootable iOS simulator -- xcrun simctl list returned 0 "
                "available devices; loop degrades to compile+unit-test only"
            ),
            "probes": probes,
        }

    return {"outcome": OUTCOME_FULL, "skip_reason": None, "probes": probes}


def _has_acceleration(sdk_present):
    """Best-effort emulator-acceleration check.

    Darwin: assume HVF is available when the SDK is present (Apple's
    Hypervisor.framework ships with the OS; there is no cheap CLI probe
    equivalent to /dev/kvm). Linux: check /dev/kvm exists. Any other
    platform: assume no acceleration.
    """
    if not sdk_present:
        return False
    if sys.platform == "darwin":
        return True
    if sys.platform.startswith("linux"):
        return os.path.exists("/dev/kvm")
    return False


def detect_android():
    """Classify the Android toolchain: SDK env + AVD + acceleration.

    - No ANDROID_HOME/ANDROID_SDK_ROOT: absent.
    - SDK present but zero AVDs (or no acceleration): degraded.
    - SDK present + >=1 AVD + acceleration: full.
    """
    probes = {}

    android_home = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    probes["ANDROID_HOME"] = os.environ.get("ANDROID_HOME")
    probes["ANDROID_SDK_ROOT"] = os.environ.get("ANDROID_SDK_ROOT")

    if not android_home:
        return {
            "outcome": OUTCOME_ABSENT,
            "skip_reason": "ANDROID_HOME/ANDROID_SDK_ROOT not set -- Android SDK not detected",
            "probes": probes,
        }

    avd_list_probe = _run([_avdmanager_bin(android_home), "list", "avd"])
    probes["avdmanager_list_avd"] = avd_list_probe

    avd_names = []
    if avd_list_probe["ok"]:
        avd_names = _parse_avd_names(avd_list_probe["stdout"])
    else:
        # Fallback: emulator -list-avds
        emulator_probe = _run([_emulator_bin(android_home), "-list-avds"])
        probes["emulator_list_avds"] = emulator_probe
        if emulator_probe["ok"]:
            avd_names = [line.strip() for line in emulator_probe["stdout"].splitlines() if line.strip()]

    probes["avd_count"] = len(avd_names)

    acceleration_ok = _has_acceleration(sdk_present=True)
    probes["acceleration_ok"] = acceleration_ok

    if not avd_names:
        return {
            "outcome": OUTCOME_DEGRADED,
            "skip_reason": (
                "Android SDK present but no AVD found (avdmanager/emulator "
                "reported zero devices) -- loop degrades to compile+unit-test only"
            ),
            "probes": probes,
        }

    if not acceleration_ok:
        return {
            "outcome": OUTCOME_DEGRADED,
            "skip_reason": (
                "Android SDK + AVD present but no emulator acceleration available "
                "(/dev/kvm missing) -- loop degrades to compile+unit-test only"
            ),
            "probes": probes,
        }

    return {"outcome": OUTCOME_FULL, "skip_reason": None, "probes": probes}


def _avdmanager_bin(android_home):
    candidate = os.path.join(android_home, "cmdline-tools", "latest", "bin", "avdmanager")
    if os.path.exists(candidate):
        return candidate
    return "avdmanager"  # fall back to PATH; _run() classifies FileNotFoundError


def _emulator_bin(android_home):
    candidate = os.path.join(android_home, "emulator", "emulator")
    if os.path.exists(candidate):
        return candidate
    return "emulator"  # fall back to PATH; _run() classifies FileNotFoundError


def _parse_avd_names(avdmanager_stdout):
    """Parse `avdmanager list avd` stdout for 'Name: <avd_name>' lines."""
    names = []
    for line in avdmanager_stdout.splitlines():
        line = line.strip()
        if line.startswith("Name:"):
            names.append(line.split("Name:", 1)[1].strip())
    return names


def detect_all():
    """Classify both platforms. Returns {"ios": ..., "android": ..., "detected_at": iso8601}."""
    return {
        "ios": detect_ios(),
        "android": detect_android(),
        "detected_at": datetime.now(timezone.utc).isoformat(),
    }


def _print_human_table(result):
    print()
    print("mobile toolchain capability".center(60))
    print("=" * 60)
    for platform_name in ("ios", "android"):
        info = result[platform_name]
        outcome = info["outcome"]
        skip = info.get("skip_reason") or "-"
        print(f"  {platform_name:<8} outcome={outcome:<9} skip_reason={skip}")
    print("-" * 60)
    print(f"  detected_at: {result['detected_at']}")
    print()


def main():
    result = detect_all()
    if "--json" in sys.argv:
        print(json.dumps(result, indent=2))
    else:
        _print_human_table(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
