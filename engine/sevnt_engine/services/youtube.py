from __future__ import annotations
import json, re, shutil, subprocess, sys, logging
from pathlib import Path
from urllib.parse import urlparse
from sevnt_engine.core.database import APP_DIR
from sevnt_engine.services.projects import get_project

ALLOWED_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com"}

def _validated_url(value: str) -> str:
    url = value.strip()
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or (parsed.hostname or "").lower() not in ALLOWED_HOSTS:
        raise ValueError("Masukkan URL YouTube yang valid (youtube.com atau youtu.be).")
    if parsed.username or parsed.password:
        raise ValueError("URL dengan kredensial tertanam tidak diizinkan.")
    if parsed.path.startswith("/shorts/") or parsed.path.startswith("/watch") or parsed.hostname == "youtu.be":
        return url
    raise ValueError("URL YouTube tidak dikenali. Gunakan link video biasa atau Shorts.")

def _run(args: list[str], timeout: int = 1800) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Proses download melewati batas waktu.") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "yt-dlp gagal memproses video").strip()
        detail = re.sub(r"https?://[^\s]+", "[URL]", detail)
        raise RuntimeError(detail[-1600:])
    return result


def _convert_json3_to_transcript(json3_path: Path) -> dict | None:
    """Convert yt-dlp json3 subtitle format to our transcript.json format."""
    try:
        data = json.loads(json3_path.read_text(encoding="utf-8"))
        events = data.get("events") or []
        segments = []
        for ev in events:
            start_ms = ev.get("tStartMs", 0)
            dur_ms = ev.get("dDurationMs", 0)
            segs = ev.get("segs") or []
            text = "".join((s.get("utf8") or "") for s in segs).strip()
            if not text or text == "\n":
                continue
            start = start_ms / 1000.0
            end = (start_ms + dur_ms) / 1000.0
            # Build word-level timing if available (segs with tOffsetMs)
            words = []
            t = start_ms
            for s in segs:
                w_text = (s.get("utf8") or "").strip()
                if not w_text:
                    continue
                w_start = (t + s.get("tOffsetMs", 0)) / 1000.0
                words.append({"word": w_text, "start": round(w_start, 3), "end": round(w_start + 0.3, 3), "probability": 0.95})
            segments.append({
                "start": round(start, 3),
                "end": round(end, 3),
                "text": text,
                "words": words,
            })
        if not segments:
            return None
        return {"segments": segments, "source": "youtube_subtitle", "language": "auto"}
    except Exception as exc:
        logging.warning(f"[YouTube] Gagal parse subtitle json3: {exc}")
        return None


def _convert_srv3_to_transcript(srv3_path: Path) -> dict | None:
    """Fallback: parse SRV3 (XML-based) subtitle format."""
    try:
        import xml.etree.ElementTree as ET
        tree = ET.parse(str(srv3_path))
        root = tree.getroot()
        segments = []
        for p in root.iter("p"):
            start_ms = int(p.get("t", 0))
            dur_ms = int(p.get("d", 0))
            text = "".join(p.itertext()).strip()
            if not text:
                continue
            start = start_ms / 1000.0
            end = (start_ms + dur_ms) / 1000.0
            segments.append({"start": round(start, 3), "end": round(end, 3), "text": text, "words": []})
        if not segments:
            return None
        return {"segments": segments, "source": "youtube_subtitle", "language": "auto"}
    except Exception as exc:
        logging.warning(f"[YouTube] Gagal parse subtitle srv3: {exc}")
        return None


def download_youtube_subtitles(url: str, folder: Path) -> dict | None:
    """Download auto-generated subtitles from YouTube and convert to transcript format."""
    sub_folder = folder / "_subtitles"
    sub_folder.mkdir(parents=True, exist_ok=True)
    template = str(sub_folder / "%(id)s")

    # Try Indonesian first, then English, then any
    for lang in ["id", "en", "en-orig"]:
        cmd = [
            sys.executable, "-m", "yt_dlp",
            "--no-warnings", "--no-playlist", "--skip-download",
            "--write-auto-sub", "--sub-lang", lang,
            "--sub-format", "json3",
            "-o", template, url
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60, encoding="utf-8", errors="replace")
            # Find downloaded json3 file
            json3_files = list(sub_folder.glob("*.json3"))
            if json3_files:
                transcript = _convert_json3_to_transcript(json3_files[0])
                if transcript:
                    logging.info(f"[YouTube] Subtitle {lang} berhasil: {len(transcript['segments'])} segmen")
                    return transcript
        except Exception as exc:
            logging.debug(f"[YouTube] Subtitle {lang} gagal: {exc}")
        # Clean up for next attempt
        for f in sub_folder.glob("*"):
            try: f.unlink()
            except: pass

    logging.info("[YouTube] Tidak ada subtitle otomatis tersedia")
    return None


def import_youtube_video(project_id: str, url: str, max_height: int = 1080) -> dict:
    clean_url = _validated_url(url)
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise FileNotFoundError("FFmpeg dan FFprobe harus terpasang dan tersedia di PATH.")
    if not get_project(project_id):
        raise ValueError("Project tidak ditemukan.")
    check = subprocess.run([sys.executable, "-m", "yt_dlp", "--version"], capture_output=True, text=True)
    if check.returncode != 0:
        raise FileNotFoundError("yt-dlp belum terpasang. Jalankan: python -m pip install yt-dlp")

    folder = APP_DIR / "projects" / project_id / "downloads"
    folder.mkdir(parents=True, exist_ok=True)
    template = str(folder / "%(title).100B_%(id)s.%(ext)s")

    # Download video
    command = [
        sys.executable, "-m", "yt_dlp", "--no-warnings", "--no-playlist", "--no-progress",
        "--socket-timeout", "20", "--retries", "3", "--fragment-retries", "5",
        "-f", f"bestvideo[height<={max_height}]+bestaudio/bestvideo+bestaudio/best",
        "--merge-output-format", "mp4",
        "--print", "after_move:filepath",
        "-o", template, clean_url
    ]
    result = _run(command, timeout=3600)
    candidates = [Path(line.strip()) for line in result.stdout.splitlines() if line.strip()]
    video_path = next((p for p in reversed(candidates) if p.is_file()), None)
    if not video_path:
        files = sorted(
            (p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in {".mp4", ".mkv", ".webm", ".mov"}),
            key=lambda p: p.stat().st_mtime, reverse=True
        )
        video_path = files[0] if files else None
    if not video_path:
        raise RuntimeError("Download selesai tetapi file video tidak ditemukan.")

    # Download subtitles
    subtitle_transcript = download_youtube_subtitles(clean_url, folder)

    return {
        "video_path": str(video_path),
        "subtitle_transcript": subtitle_transcript,
        "original_uri": clean_url,
    }
