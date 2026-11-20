"""Measurement tool: runs the REAL engine ASR path (asr_service, chunked) in-process and reports peak working set + speed.
usage: python measure_engine_asr.py <model> <audio> [language]     (Windows only)"""
import ctypes, json, os, sys, time
from ctypes import wintypes
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
class PMC(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
_k, _p = ctypes.WinDLL("kernel32"), ctypes.WinDLL("psapi")
_k.GetCurrentProcess.restype = wintypes.HANDLE
_p.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
def peak():
    pmc = PMC(); pmc.cb = ctypes.sizeof(PMC); _p.GetProcessMemoryInfo(_k.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb); return pmc.PeakWorkingSetSize / 2**20
os.environ.setdefault("HF_HOME", os.path.join(os.path.expanduser("~"), ".cache", "huggingface"))
from sevnt_engine import asr_service as A
model, audio = sys.argv[1], sys.argv[2]
lang = sys.argv[3] if len(sys.argv) > 3 else "auto"
t0 = time.time()
job = A.submit(audio, model, lang, True, False)
while True:
    j = A.get(job["id"])
    if j["status"] in ("done", "error", "cancelled"): break
    time.sleep(1)
dt = time.time() - t0
print(json.dumps({"status": j["status"], "model_used": j["model_used"], "audio_s": j["duration"], "words": j["word_count"], "language": j["language"],
                  "wall_s": round(dt, 1), "x_realtime": round(j["duration"] / dt, 2) if j["duration"] else None, "peak_ws_mb": round(peak()), "error": j["error"]}))
