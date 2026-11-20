"""Cross-platform memory probe used to keep ASR safe on 8 GB machines.

Windows is exercised by the test-suite on the development machine. The macOS and Linux branches are
implemented from the platform documentation and are NOT TESTED on those systems.
"""
from __future__ import annotations

import os
import subprocess
import sys


def _windows() -> tuple[int, int]:
    import ctypes

    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
            ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    st = MEMORYSTATUSEX()
    st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):  # type: ignore[attr-defined]
        raise OSError("GlobalMemoryStatusEx failed")
    return int(st.ullTotalPhys), int(st.ullAvailPhys)


def _linux() -> tuple[int, int]:
    total = avail = 0
    with open("/proc/meminfo", encoding="utf8") as fh:
        for line in fh:
            if line.startswith("MemTotal:"):
                total = int(line.split()[1]) * 1024
            elif line.startswith("MemAvailable:"):
                avail = int(line.split()[1]) * 1024
    return total, avail


def _macos() -> tuple[int, int]:
    total = int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True, timeout=5).strip())
    out = subprocess.check_output(["vm_stat"], text=True, timeout=5)
    page = 4096
    counts: dict[str, int] = {}
    for line in out.splitlines():
        if "page size of" in line:
            digits = "".join(ch for ch in line.split("page size of")[1] if ch.isdigit())
            if digits:
                page = int(digits)
        elif ":" in line:
            key, val = line.split(":", 1)
            digits = "".join(ch for ch in val if ch.isdigit())
            if digits:
                counts[key.strip()] = int(digits)
    # free + inactive + speculative pages are reclaimable without swapping
    avail = (counts.get("Pages free", 0) + counts.get("Pages inactive", 0) + counts.get("Pages speculative", 0)) * page
    return total, avail


def memory_bytes() -> tuple[int, int]:
    """Return (total_physical, available_physical) in bytes; (0, 0) when it cannot be read."""
    try:
        if sys.platform == "win32":
            return _windows()
        if sys.platform == "darwin":
            return _macos()
        return _linux()
    except Exception:  # noqa: BLE001 - a failed probe must never take the engine down
        return 0, 0


def cpu_count() -> int:
    return os.cpu_count() or 2
