from __future__ import annotations
from pathlib import Path
import shutil, subprocess, os
from sevnt_engine.core.database import APP_DIR
from sevnt_engine.services.media import get_source


def _binary(name: str) -> str:
    # SEVNT: A (the Electron app) hands over its own bundled binaries; never ship a second FFmpeg.
    path = os.environ.get("SEVNT_" + name.upper()) or shutil.which(name)
    if not path:
        raise RuntimeError(f"{name} tidak ditemukan. Pasang FFmpeg dan pastikan folder bin masuk PATH.")
    return path


def _source(source_id: str):
    item = get_source(source_id)
    if not item:
        raise FileNotFoundError("Media source tidak ditemukan")
    path = Path(item.get("local_path") or "")
    if not path.exists() or not path.is_file():
        raise FileNotFoundError("File sumber tidak tersedia pada komputer yang menjalankan SEVNT Engine")
    return item, path


def _workspace(item: dict) -> Path:
    out = APP_DIR / "projects" / item["project_id"] / "media" / item["id"]
    out.mkdir(parents=True, exist_ok=True)
    return out


def _run(cmd: list[str], timeout: int = 900):
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"Proses FFmpeg melewati batas waktu {timeout} detik") from exc
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "FFmpeg gagal").strip()
        raise RuntimeError(message[-4000:])
    return result


def decode_test(source_id: str) -> dict:
    item, path = _source(source_id)
    ffmpeg = _binary("ffmpeg")
    cmd = [ffmpeg, "-hide_banner", "-v", "error", "-i", str(path), "-map", "0:v:0", "-f", "null", "-"]
    _run(cmd, timeout=max(180, int((item.get("duration_seconds") or 60) * 10)))
    return {"source_id": source_id, "decode_test": "passed", "video_codec": item.get("video_codec"),
            "duration_seconds": item.get("duration_seconds"), "message": "FFmpeg berhasil mendekode stream video."}


def extract_audio(source_id: str) -> dict:
    item, path = _source(source_id)
    ffmpeg = _binary("ffmpeg")
    out = _workspace(item) / "audio_16k_mono.wav"
    cmd = [ffmpeg, "-y", "-hide_banner", "-v", "error", "-i", str(path), "-map", "0:a:0",
           "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(out)]
    _run(cmd)
    if not out.exists() or out.stat().st_size < 44:
        raise RuntimeError("Audio WAV tidak terbentuk atau kosong")
    return {"source_id": source_id, "audio_path": str(out), "file_size_bytes": out.stat().st_size,
            "format": "wav", "sample_rate": 16000, "channels": 1, "status": "completed"}


def generate_thumbnails(source_id: str, count: int = 5) -> dict:
    item, path = _source(source_id)
    ffmpeg = _binary("ffmpeg")
    duration = float(item.get("duration_seconds") or 0)
    if duration <= 0:
        raise ValueError("Durasi video tidak valid")
    count = max(1, min(int(count), 20))
    out_dir = _workspace(item) / "thumbnails"
    out_dir.mkdir(parents=True, exist_ok=True)
    frames = []
    for idx in range(count):
        ts = min(max(0.05, duration * (idx + 0.5) / count), max(0.05, duration - 0.05))
        target = out_dir / f"thumb_{idx+1:02d}.jpg"
        _run([ffmpeg, "-y", "-hide_banner", "-v", "error", "-ss", f"{ts:.3f}", "-i", str(path),
              "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "3", str(target)], timeout=180)
        if not target.exists() or target.stat().st_size == 0:
            raise RuntimeError(f"Thumbnail {idx+1} gagal dibuat")
        frames.append({"index": idx + 1, "timestamp_seconds": round(ts, 3),
                       "file_path": str(target), "file_size_bytes": target.stat().st_size})
    return {"source_id": source_id, "status": "completed", "count": len(frames), "items": frames}


def extract_frame(source_id: str, timestamp_seconds: float) -> dict:
    item, path = _source(source_id)
    duration = float(item.get("duration_seconds") or 0)
    if timestamp_seconds < 0 or timestamp_seconds >= duration:
        raise ValueError(f"Timestamp harus berada pada rentang 0 sampai kurang dari {duration} detik")
    ffmpeg = _binary("ffmpeg")
    out_dir = _workspace(item) / "frames"
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / (f"frame_{timestamp_seconds:.3f}".replace(".", "_") + ".jpg")
    _run([ffmpeg, "-y", "-hide_banner", "-v", "error", "-ss", f"{timestamp_seconds:.3f}",
          "-i", str(path), "-frames:v", "1", "-q:v", "2", str(target)], timeout=180)
    if not target.exists() or target.stat().st_size == 0:
        raise RuntimeError("Frame tidak berhasil dibuat")
    return {"source_id": source_id, "timestamp_seconds": timestamp_seconds, "file_path": str(target),
            "file_size_bytes": target.stat().st_size, "status": "completed"}


def extract_clip_preview(source_id: str, start: float, end: float, clip_id: str) -> Path:
    """Fast-extract a clip segment using stream copy (no re-encode). Returns the cached file path."""
    item, path = _source(source_id)
    out_dir = _workspace(item) / "previews"
    out_dir.mkdir(parents=True, exist_ok=True)
    safe_id = clip_id.replace("/", "-").replace("\\", "-")
    target = out_dir / f"preview_{safe_id}.mp4"
    if target.exists() and target.stat().st_size > 0:
        return target
    ffmpeg = _binary("ffmpeg")
    duration = end - start
    cmd = [
        ffmpeg, "-y", "-hide_banner", "-v", "error",
        "-ss", f"{start:.3f}", "-i", str(path),
        "-t", f"{duration:.3f}",
        "-c", "copy", "-movflags", "+faststart",
        str(target),
    ]
    _run(cmd, timeout=120)
    if not target.exists() or target.stat().st_size == 0:
        raise RuntimeError("Clip preview gagal dibuat")
    return target


def processing_capabilities() -> dict:
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    whisper = shutil.which("whisper-cli") or shutil.which("whisper")
    return {"ffmpeg_available": bool(ffmpeg), "ffprobe_available": bool(ffprobe),
            "ffmpeg_path": ffmpeg, "ffprobe_path": ffprobe,
            "whisper_available": bool(whisper),
            "whisper_note": "Lihat /api/v1/system/whisper-capabilities untuk status adapter transkripsi lokal."}



def whisper_capabilities() -> dict:
    try:
        from importlib.metadata import version, PackageNotFoundError
        try:
            fw_version = version("faster-whisper")
            faster_whisper_installed = True
        except PackageNotFoundError:
            fw_version = None
            faster_whisper_installed = False
    except Exception:
        fw_version, faster_whisper_installed = None, False
    return {
        "faster_whisper_available": faster_whisper_installed,
        "faster_whisper_version": fw_version,
        "whisper_cli_available": bool(shutil.which("whisper-cli") or shutil.which("whisper")),
        "transcription_adapter": "faster-whisper-local" if faster_whisper_installed else None,
        "note": "Transkripsi berjalan lokal di komputer. Model diunduh saat pertama kali dipakai jika belum ada di cache."
    }


def transcribe_source(source_id: str, model_size: str = "base", language: str | None = None,
                     word_timestamps: bool = True) -> dict:
    """Transcribe source audio locally with faster-whisper and persist inspectable JSON."""
    from datetime import datetime, timezone
    import json
    allowed_models = {"tiny", "base", "small"}
    if model_size not in allowed_models:
        raise ValueError(f"Model harus salah satu dari: {', '.join(sorted(allowed_models))}")
    if language in {"", "auto"}:
        language = None
    if language is not None and (len(language) > 12 or not language.replace("-", "").isalpha()):
        raise ValueError("Kode bahasa tidak valid. Gunakan 'auto', 'id', 'en', atau kode bahasa ISO.")
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError("faster-whisper belum terpasang. Jalankan: python -m pip install -r requirements.txt") from exc
    item, source_path = _source(source_id)
    work_dir = _workspace(item)
    wav_path = work_dir / "audio_16k_mono.wav"
    if not wav_path.exists() or wav_path.stat().st_size <= 44:
        audio_result = extract_audio(source_id)
        wav_path = Path(audio_result["audio_path"])
    try:
        model = WhisperModel(model_size, device="cpu", compute_type="int8",
                             cpu_threads=max(2, min(4, os.cpu_count() or 2)), num_workers=1)
        segments_iter, info = model.transcribe(
            str(wav_path), language=language, beam_size=3, word_timestamps=word_timestamps,
            condition_on_previous_text=True, vad_filter=False)
        segments=[]; full_text_parts=[]
        for segment in segments_iter:
            text_value=(segment.text or "").strip(); full_text_parts.append(text_value)
            entry={"id":len(segments),"start":round(float(segment.start),3),
                   "end":round(float(segment.end),3),"text":text_value}
            if word_timestamps:
                entry["words"]=[{"start":round(float(w.start),3) if w.start is not None else None,
                    "end":round(float(w.end),3) if w.end is not None else None,
                    "word":(w.word or "").strip(),
                    "probability":round(float(w.probability),4) if w.probability is not None else None}
                    for w in (segment.words or [])]
            segments.append(entry)
    except Exception as exc:
        raise RuntimeError(f"Whisper transcription gagal: {str(exc)[:1200]}") from exc
    transcript={"source_id":source_id,"filename":item.get("filename"),"status":"completed",
        "engine":"faster-whisper","model":model_size,"device":"cpu","compute_type":"int8",
        "language":getattr(info,"language",None),
        "language_probability":round(float(getattr(info,"language_probability",0.0)),4),
        "duration_seconds":round(float(getattr(info,"duration",item.get("duration_seconds") or 0)),3),
        "word_timestamps":bool(word_timestamps),
        "text":" ".join(p for p in full_text_parts if p).strip(),
        "segment_count":len(segments),"segments":segments,
        "created_at":datetime.now(timezone.utc).isoformat()}
    transcript_dir=work_dir/"transcripts"; transcript_dir.mkdir(parents=True,exist_ok=True)
    transcript_path=transcript_dir/"transcript.json"
    transcript_path.write_text(json.dumps(transcript,ensure_ascii=False,indent=2),encoding="utf-8")
    transcript["transcript_path"]=str(transcript_path)
    transcript["file_size_bytes"]=transcript_path.stat().st_size
    return transcript


def create_browser_preview(source_id: str) -> dict:
    """Create a browser-compatible H.264 MP4 preview while preserving the original source."""
    item, source_path = _source(source_id)
    ffmpeg = _binary("ffmpeg")
    out_dir = _workspace(item) / "preview"
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / "browser_preview.mp4"
    if target.is_file() and target.stat().st_size > 1024 and target.stat().st_mtime >= source_path.stat().st_mtime:
        return {"source_id": source_id, "status": "ready", "preview_path": str(target),
                "file_size_bytes": target.stat().st_size, "format": "mp4", "video_codec": "h264", "cached": True}
    cmd = [ffmpeg, "-y", "-hide_banner", "-v", "error", "-i", str(source_path),
           "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale='min(1080,iw)':-2",
           "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
           "-pix_fmt", "yuv420p", "-profile:v", "main", "-movflags", "+faststart",
           "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "44100", str(target)]
    _run(cmd, timeout=max(300, int((item.get("duration_seconds") or 60) * 20)))
    if not target.is_file() or target.stat().st_size <= 1024:
        raise RuntimeError("Video preview MP4 tidak berhasil dibuat")
    return {"source_id": source_id, "status": "ready", "preview_path": str(target),
            "file_size_bytes": target.stat().st_size, "format": "mp4", "video_codec": "h264", "cached": False}
