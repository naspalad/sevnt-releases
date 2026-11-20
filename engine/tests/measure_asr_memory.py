"""Measurement tool (not a unit test): peak working set + speed of faster-whisper on this machine.
usage: python measure_asr_memory.py <model> <audio.wav> [language]
Windows only (uses GetProcessMemoryInfo). Writes one JSON line."""
import ctypes, json, os, sys, time
from ctypes import wintypes

class PMC(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

_k, _p = ctypes.WinDLL('kernel32'), ctypes.WinDLL('psapi')
_k.GetCurrentProcess.restype = wintypes.HANDLE
_p.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
_p.GetProcessMemoryInfo.restype = wintypes.BOOL

def mem():
    pmc = PMC(); pmc.cb = ctypes.sizeof(PMC)
    if not _p.GetProcessMemoryInfo(_k.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
        raise OSError('GetProcessMemoryInfo failed')
    return pmc.WorkingSetSize / 2**20, pmc.PeakWorkingSetSize / 2**20

model, wav = sys.argv[1], sys.argv[2]
lang = sys.argv[3] if len(sys.argv) > 3 else None
base_ws, _ = mem()
from faster_whisper import WhisperModel
t0 = time.time()
m = WhisperModel(model, device="cpu", compute_type="int8", cpu_threads=4, num_workers=1,
                 download_root=os.path.join(os.environ.get("HF_HOME", ""), "hub"))
load_s = time.time() - t0
ws_loaded, _ = mem()
t1 = time.time()
segs, info = m.transcribe(wav, language=lang, word_timestamps=True, beam_size=1, vad_filter=True, condition_on_previous_text=False)
n = sum(len(s.words or []) for s in segs)
run_s = time.time() - t1
_, peak = mem()
print(json.dumps({"model": model, "audio_s": round(info.duration, 1), "words": n, "load_s": round(load_s, 1), "run_s": round(run_s, 1),
                  "rtf_x": round(info.duration / run_s, 1) if run_s else None, "base_ws_mb": round(base_ws), "after_load_ws_mb": round(ws_loaded),
                  "peak_ws_mb": round(peak)}))
