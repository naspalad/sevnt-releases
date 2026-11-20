"""S1 — faster-whisper as an additional ASR backend for SEVNT Studio (A).

Contract with the app: A sends the path of an audio/video file it already owns; the engine returns word
timestamps. The engine never touches A's sessions, projects or the legacy sevnt.db.

Memory policy (8 GB machines): one job at a time, the model is loaded for the job and released right after
(no resident model while idle), int8 on CPU, at most 4 CPU threads, and a free-RAM check before loading.
The numbers in MODEL_MIN_FREE_BYTES are conservative estimates and are meant to be tuned from measurements
(see AUDIT/19_ENGINE_TEST_REPORT.md).
"""
from __future__ import annotations

import gc
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from sevnt_engine.memory import cpu_count, memory_bytes

GB = 1024 ** 3
ALLOWED_MODELS = ("tiny", "base", "small")
# Memory model, from MEASUREMENTS on the 6.9 GB Ryzen 5 3500U dev machine (engine/tests/measure_asr_memory.py, int8, 4 threads,
# beam 1, VAD on): peak working set of the engine process
#   tiny: 235 MB (7.5 s audio) -> 435 MB (301 s audio);   base: 332 MB (7.5 s) -> 470 MB (301 s)
#   tiny on 1129 s (19 min) of audio, ONE pass: 1220 MB  => memory grew ~0.7-0.95 MB per audio second (≈3.4 GB per hour).
# That is why audio is decoded and transcribed in CHUNK_SECONDS windows (bounded memory, see _decode_chunks).
# Chunked re-measurement (tiny, 19 min, 600 s windows): peak 781 MB — memory still grows ~0.75 MB per second of the WINDOW being
# decoded, so the window itself is kept short (300 s => ~0.45 GB peak for tiny) and the requirement is capped by the window.
# "small" was NOT measured (model not downloaded here): its numbers are ESTIMATES and are flagged as such in capabilities().
MODEL_BASE_PEAK_MB = {"tiny": 240, "base": 340, "small": 900}
PER_AUDIO_SECOND_MB = {"tiny": 0.8, "base": 0.8, "small": 1.0}
CHUNK_SECONDS = 300
CHUNK_MARGIN_SECONDS = 10
MEASURED = {"tiny": True, "base": True, "small": False}
HEADROOM_MB = 256


def required_free_bytes(model: str, audio_seconds: float | None) -> int:
    window = min(audio_seconds if audio_seconds is not None else CHUNK_SECONDS, CHUNK_SECONDS + CHUNK_MARGIN_SECONDS)
    mb = MODEL_BASE_PEAK_MB[model] + PER_AUDIO_SECOND_MB[model] * window + HEADROOM_MB
    return int(mb * 1024 * 1024)


def audio_duration_seconds(path: str) -> float | None:
    """Container duration without decoding (cheap). None when it cannot be read."""
    try:
        import av  # PyAV is a dependency of faster-whisper
        with av.open(path) as c:
            if c.duration:
                return float(c.duration) / 1_000_000
            for st in c.streams.audio:
                if st.duration and st.time_base:
                    return float(st.duration * st.time_base)
    except Exception:  # noqa: BLE001
        return None
    return None
JOB_TTL_SECONDS = 3600


class AsrError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def models_dir() -> Path:
    base = os.environ.get("HF_HOME") or str(Path(os.environ.get("SEVNT_DATA_DIR", Path.home() / ".sevnt-studio")) / "engine-models")
    return Path(base)


def _cache_folder(model: str) -> Path:
    return models_dir() / "hub" / f"models--Systran--faster-whisper-{model}"


def model_cached(model: str) -> bool:
    d = _cache_folder(model) / "snapshots"
    try:
        return d.exists() and any(d.iterdir())
    except OSError:
        return False


def capabilities() -> dict[str, Any]:
    total, avail = memory_bytes()
    # Cheap on purpose: do NOT import faster_whisper here (it loads ctranslate2/onnxruntime and can take seconds on a busy machine).
    try:
        from importlib.metadata import version
        from importlib.util import find_spec
        fw_version: str | None = version("faster-whisper") if find_spec("faster_whisper") else None
    except Exception:  # noqa: BLE001
        fw_version = None
    return {
        "faster_whisper_available": fw_version is not None,
        "faster_whisper_version": fw_version,
        "models": {m: {"cached": model_cached(m), "min_free_bytes_short_audio": required_free_bytes(m, 0), "measured": MEASURED[m]} for m in ALLOWED_MODELS},
        "memory": {"total_bytes": total, "available_bytes": avail},
        "cpu_count": cpu_count(),
        "device": "cpu",
        "compute_type": "int8",
        "models_dir": str(models_dir()),
    }


def plan_model(requested: str, available_bytes: int | None = None, audio_seconds: float | None = None) -> tuple[str, str | None]:
    """Pick the model to load. Returns (model, note). Downgrades when free RAM is short; raises when even tiny won't fit."""
    if requested not in ALLOWED_MODELS:
        raise AsrError("bad_model", f"Model harus salah satu dari: {', '.join(ALLOWED_MODELS)}")
    if available_bytes is None:
        _, available_bytes = memory_bytes()
    if available_bytes <= 0:          # probe unavailable: do not block, trust the caller
        return requested, None
    order = list(ALLOWED_MODELS)
    for m in order[: order.index(requested) + 1][::-1]:
        if available_bytes >= required_free_bytes(m, audio_seconds):
            note = None if m == requested else f"RAM bebas {available_bytes / GB:.1f} GB tidak cukup untuk '{requested}', memakai '{m}'"
            return m, note
    raise AsrError("insufficient_memory",
                   f"RAM bebas {available_bytes / GB:.1f} GB, perlu sekitar {required_free_bytes('tiny', audio_seconds) / GB:.1f} GB untuk model terkecil")


def _decode_chunks(path: str, chunk_s: int = CHUNK_SECONDS, margin_s: int = CHUNK_MARGIN_SECONDS):
    """Yield (start_seconds, float32 mono 16 kHz array) windows of about chunk_s seconds.

    Streams the file through PyAV so only ~chunk_s of audio is ever in memory. Each cut is moved to the quietest 50 ms
    inside the last margin_s seconds of the window, so words are not split in the middle.
    """
    import av
    import numpy as np

    rate = 16000
    resampler = av.AudioResampler(format="s16", layout="mono", rate=rate)
    parts: list[Any] = []
    have = 0
    emitted = 0

    def to_float(arrs):
        a = np.concatenate(arrs) if len(arrs) > 1 else arrs[0]
        return a.astype(np.float32) / 32768.0

    def cut_index(a) -> int:
        """Index (in samples) of the quietest 50 ms in the last margin_s seconds of the window a (int16)."""
        win = int(0.05 * rate)
        lo = max(0, len(a) - margin_s * rate)
        seg = a[lo:len(a) - win].astype(np.float32)
        if len(seg) < win:
            return len(a)
        n = len(seg) // win
        energy = (seg[: n * win].reshape(n, win) ** 2).mean(axis=1)
        return lo + int(energy.argmin()) * win + win // 2

    with av.open(path) as container:
        stream = next((st for st in container.streams if st.type == "audio"), None)
        if stream is None:
            return
        pending = None   # int16 samples carried over to the next window
        def frames():
            for packet in container.demux(stream):
                for frame in packet.decode():
                    for out in resampler.resample(frame):
                        yield out.to_ndarray().reshape(-1)
            for out in resampler.resample(None):
                yield out.to_ndarray().reshape(-1)

        buf: list[Any] = []
        size = 0
        for arr in frames():
            buf.append(arr)
            size += len(arr)
            if size >= (chunk_s + margin_s) * rate:
                a = np.concatenate(buf)
                k = cut_index(a[: (chunk_s + margin_s) * rate])
                yield emitted / rate, to_float([a[:k]])
                emitted += k
                rest = a[k:]
                buf, size = [rest], len(rest)
        if size:
            yield emitted / rate, to_float(buf)


class _Job:
    def __init__(self, audio_path: str, model: str, language: str | None, vad: bool, allow_download: bool):
        self.id = uuid.uuid4().hex
        self.audio_path, self.requested_model, self.language, self.vad, self.allow_download = audio_path, model, language, vad, allow_download
        self.status = "queued"            # queued | loading | running | done | error | cancelled
        self.progress = 0.0
        self.model_used: str | None = None
        self.note: str | None = None
        self.detected_language: str | None = None
        self.duration: float | None = None
        self.words: list[dict[str, Any]] = []
        self.error: dict[str, str] | None = None
        self.created = time.time()
        self.finished: float | None = None
        self.cancel = threading.Event()

    def public(self, with_words: bool = True) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id, "status": self.status, "progress": round(self.progress, 4),
            "model_requested": self.requested_model, "model_used": self.model_used, "note": self.note,
            "language": self.detected_language, "duration": self.duration, "error": self.error,
            "word_count": len(self.words),
        }
        if with_words and self.status == "done":
            out["words"] = self.words
        return out


_jobs: dict[str, _Job] = {}
_lock = threading.Lock()
_busy = threading.Lock()                   # one transcription at a time (8 GB machines)


def _purge() -> None:
    now = time.time()
    for jid in [j for j, job in _jobs.items() if job.finished and now - job.finished > JOB_TTL_SECONDS]:
        _jobs.pop(jid, None)


def submit(audio_path: str, model: str = "small", language: str | None = None, vad: bool = True, allow_download: bool = True) -> dict[str, Any]:
    p = Path(audio_path)
    if not p.is_absolute() or not p.is_file():
        raise AsrError("bad_path", "audio_path harus path absolut ke file yang ada")
    if model not in ALLOWED_MODELS:
        raise AsrError("bad_model", f"Model harus salah satu dari: {', '.join(ALLOWED_MODELS)}")
    lang = None if language in (None, "", "auto") else language
    if lang is not None and (len(lang) > 12 or not lang.replace("-", "").isalpha()):
        raise AsrError("bad_language", "Kode bahasa tidak valid")
    if _busy.locked():
        raise AsrError("busy", "Engine sedang memproses transkrip lain")
    with _lock:
        _purge()
        job = _Job(str(p), model, lang, vad, allow_download)
        _jobs[job.id] = job
    threading.Thread(target=_run, args=(job,), name=f"asr-{job.id[:6]}", daemon=True).start()
    return job.public(with_words=False)


def get(job_id: str) -> dict[str, Any] | None:
    job = _jobs.get(job_id)
    return job.public() if job else None


def cancel(job_id: str) -> dict[str, Any] | None:
    job = _jobs.get(job_id)
    if not job:
        return None
    job.cancel.set()
    return job.public(with_words=False)


def _run(job: _Job) -> None:
    if not _busy.acquire(blocking=False):
        job.status, job.error, job.finished = "error", {"code": "busy", "message": "Engine sedang memproses transkrip lain"}, time.time()
        return
    model_obj = None
    try:
        job.status = "loading"
        try:
            job.duration = audio_duration_seconds(job.audio_path)
            chosen, note = plan_model(job.requested_model, audio_seconds=job.duration)
        except AsrError as exc:
            job.status, job.error = "error", {"code": exc.code, "message": exc.message}
            return
        job.model_used, job.note = chosen, note
        if not job.allow_download and not model_cached(chosen):
            job.status, job.error = "error", {"code": "model_not_cached", "message": f"Model '{chosen}' belum diunduh"}
            return
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            job.status, job.error = "error", {"code": "not_installed", "message": "faster-whisper tidak terpasang di runtime engine"}
            return
        d = models_dir()
        d.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("HF_HOME", str(d))
        model_obj = WhisperModel(chosen, device="cpu", compute_type="int8",
                                 cpu_threads=max(2, min(4, cpu_count())), num_workers=1, download_root=str(d / "hub"))
        if job.cancel.is_set():
            job.status = "cancelled"
            return
        job.status = "running"
        words: list[dict[str, Any]] = []
        language = job.language
        done_s = 0.0
        for start_s, audio in _decode_chunks(job.audio_path):
            if job.cancel.is_set():
                job.status = "cancelled"
                return
            segments, info = model_obj.transcribe(
                audio, language=language, word_timestamps=True, beam_size=1,
                vad_filter=job.vad, vad_parameters={"min_silence_duration_ms": 500},
                condition_on_previous_text=False)
            if job.detected_language is None:
                job.detected_language = getattr(info, "language", None)
            if language is None:
                language = job.detected_language     # detect once, then keep the same language for the later windows
            chunk_s = len(audio) / 16000.0
            for seg in segments:
                if job.cancel.is_set():
                    job.status = "cancelled"
                    return
                for w in (seg.words or []):
                    text = (w.word or "").strip()
                    if text and w.end > w.start:
                        words.append({"text": text, "start": round(start_s + float(w.start), 3), "end": round(start_s + float(w.end), 3)})
                if job.duration:
                    job.progress = min(0.99, (start_s + float(seg.end)) / job.duration)
            done_s = start_s + chunk_s
            if job.duration:
                job.progress = min(0.99, done_s / job.duration)
            del audio
            gc.collect()
        job.words, job.progress, job.status = words, 1.0, "done"
    except AsrError as exc:
        job.status, job.error = "error", {"code": exc.code, "message": exc.message}
    except MemoryError:
        job.status, job.error = "error", {"code": "out_of_memory", "message": "Memori habis saat transkripsi"}
    except Exception as exc:  # noqa: BLE001 - report every failure to the caller, never crash the engine
        job.status, job.error = "error", {"code": "asr_failed", "message": f"{type(exc).__name__}: {exc}"[:400]}
    finally:
        model_obj = None
        gc.collect()
        job.finished = time.time()
        _busy.release()
