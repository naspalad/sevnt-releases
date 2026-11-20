from __future__ import annotations
import os
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
import hashlib, json, mimetypes, subprocess, shutil
from sevnt_engine.core.database import db_session
from sevnt_engine.services.projects import now

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe_media(path: Path) -> dict:
    ffprobe = os.environ.get("SEVNT_FFPROBE") or shutil.which("ffprobe")   # SEVNT: bundled binary first
    if not ffprobe:
        return {"probe_available": False, "note": "FFprobe belum terpasang/terdeteksi; metadata dasar tetap disimpan."}
    cmd = [ffprobe, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    if result.returncode != 0:
        raise ValueError(result.stderr.strip() or "FFprobe gagal membaca file")
    data = json.loads(result.stdout or "{}")
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    audio = next((s for s in streams if s.get("codec_type") == "audio"), {})
    fmt = data.get("format", {})
    rate = video.get("avg_frame_rate") or video.get("r_frame_rate")
    fps = None
    if rate and rate != "0/0":
        try:
            a,b = rate.split("/"); fps = float(a)/float(b) if float(b) else None
        except Exception: pass
    return {
        "probe_available": True,
        "duration_seconds": float(fmt["duration"]) if fmt.get("duration") else None,
        "file_size_bytes": int(fmt["size"]) if fmt.get("size") else path.stat().st_size,
        "width": video.get("width"), "height": video.get("height"), "frame_rate": fps,
        "video_codec": video.get("codec_name"), "audio_codec": audio.get("codec_name"),
        "streams": streams, "format": fmt,
    }


def import_local_file(project_id: str, file_path: str) -> dict:
    path = Path(file_path).expanduser().resolve()
    if not path.exists() or not path.is_file(): raise FileNotFoundError("File sumber tidak ditemukan")
    if path.suffix.lower() not in VIDEO_EXTS: raise ValueError(f"Format {path.suffix or '(tanpa ekstensi)'} belum didukung sebagai video")
    with db_session() as conn:
        project = conn.execute("SELECT id FROM projects WHERE id=? AND status='active'", (project_id,)).fetchone()
    if not project: raise LookupError("Project tidak ditemukan atau sudah diarsipkan")
    probe = probe_media(path)
    media_id = str(uuid4()); stamp = now(); size = path.stat().st_size
    checksum = sha256_file(path)
    with db_session() as conn:
        conn.execute("""INSERT INTO media_sources
        (id,project_id,source_kind,original_uri,local_path,filename,mime_type,file_size_bytes,duration_seconds,width,height,frame_rate,video_codec,audio_codec,probe_json,acquisition_status,checksum_sha256,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
            media_id, project_id, "local_file", str(path), str(path), path.name,
            mimetypes.guess_type(path.name)[0] or "application/octet-stream", size,
            probe.get("duration_seconds"), probe.get("width"), probe.get("height"), probe.get("frame_rate"),
            probe.get("video_codec"), probe.get("audio_codec"), json.dumps(probe), "ready", checksum, stamp, stamp))
        conn.execute("INSERT INTO activity_events(id,project_id,entity_type,entity_id,event_type,message,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
            (str(uuid4()), project_id, "media_source", media_id, "source.imported", f"Video {path.name} diimpor", json.dumps({"path":str(path),"size":size}), stamp))
    return get_source(media_id)


def get_source(source_id: str) -> dict | None:
    with db_session() as conn:
        row = conn.execute("SELECT * FROM media_sources WHERE id=?", (source_id,)).fetchone()
        if not row: return None
        item = dict(row); item["probe"] = json.loads(item.pop("probe_json")); return item


def list_sources(project_id: str) -> list[dict]:
    with db_session() as conn:
        rows = conn.execute("SELECT * FROM media_sources WHERE project_id=? ORDER BY created_at DESC", (project_id,)).fetchall()
        result=[]
        for row in rows:
            item=dict(row); item["probe"] = json.loads(item.pop("probe_json")); result.append(item)
        return result
