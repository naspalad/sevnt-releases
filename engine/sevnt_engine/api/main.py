from __future__ import annotations
from datetime import datetime, timezone
from pathlib import Path
import platform, shutil, uuid, threading, time
import json as _json
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sevnt_engine.core.database import initialize_database, DB_PATH
from sevnt_engine.services.projects import create_project, get_project, list_projects, rename_project, archive_project
from sevnt_engine.services.media import import_local_file, get_source, list_sources
from sevnt_engine.services.youtube import import_youtube_video
from sevnt_engine.services.processing import processing_capabilities, decode_test, extract_audio, generate_thumbnails, extract_frame, whisper_capabilities, transcribe_source, create_browser_preview, extract_clip_preview
from sevnt_engine.services.transcripts import transcript_quality, correct_word, correct_segment, transcript_revisions, get_transcript_audio, align_transcript
from sevnt_engine.services.semantic_clips import analyze_source, update_clip, split_clip, delete_clip, render_clips

app = FastAPI(title="SEVNT Studio Local Engine", version="0.9.0")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://127.0.0.1:5174", "http://localhost:5175", "http://127.0.0.1:5175", "file://", "null"], allow_credentials=False, allow_methods=["GET","POST","PATCH","DELETE"], allow_headers=["Content-Type"])

class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    workspace_path: str | None = None
class ProjectRename(BaseModel):
    name: str = Field(min_length=1, max_length=120)
class SourceImport(BaseModel):
    file_path: str = Field(min_length=1)

class YouTubeImport(BaseModel):
    url: str = Field(min_length=8, max_length=2048)
    project_id: str | None = None
    max_height: int = Field(default=1080, ge=360, le=2160)

class ThumbnailRequest(BaseModel):
    count: int = Field(default=5, ge=1, le=20)

class FrameRequest(BaseModel):
    timestamp_seconds: float = Field(ge=0)

class TranscriptionRequest(BaseModel):
    model: str = Field(default="base", pattern="^(tiny|base|small)$")
    language: str | None = Field(default="auto", max_length=12)
    word_timestamps: bool = True

class WordCorrection(BaseModel):
    segment_index: int = Field(ge=0)
    word_index: int = Field(ge=0)
    word: str = Field(min_length=1, max_length=120)

class SegmentCorrection(BaseModel):
    segment_index: int = Field(ge=0)
    text: str = Field(min_length=1, max_length=2000)

class SegmentAlignmentRequest(BaseModel):
    segment_index: int | None = Field(default=None, ge=0)

@app.on_event("startup")
def startup():
    initialize_database()
    from sevnt_engine.services.license import ensure_license_schema
    ensure_license_schema()

@app.get("/health")
def health():
    return {"status":"ready","service":"sevnt-local-engine","version":"0.9.0","platform":platform.system(),"database":"connected" if DB_PATH.exists() else "not_initialized","ffmpeg":bool(shutil.which("ffmpeg")),"ffprobe":bool(shutil.which("ffprobe")),"timestamp":datetime.now(timezone.utc).isoformat()}

@app.get("/api/v1/system/profile")
def system_profile():
    return {"profile":"adaptive","memory_target":"8-16GB","ai_mode":"local-first-light","cloud_ai":"opt-in","platform":platform.system(),"ffmpeg_available":bool(shutil.which("ffmpeg")),"ffprobe_available":bool(shutil.which("ffprobe")),"note":"Hardware profiling and benchmark adapter are not implemented yet."}

@app.post("/api/v1/projects", status_code=201)
def project_create(payload: ProjectCreate):
    try: return create_project(payload.name, payload.workspace_path)
    except Exception as exc: raise HTTPException(400, str(exc))

@app.get("/api/v1/projects")
def projects_list(): return {"items":list_projects()}

@app.get("/api/v1/projects/{project_id}")
def project_detail(project_id: str):
    item=get_project(project_id)
    if not item: raise HTTPException(404,"Project tidak ditemukan")
    return item

@app.patch("/api/v1/projects/{project_id}")
def project_rename(project_id: str, payload: ProjectRename):
    item=rename_project(project_id,payload.name)
    if not item: raise HTTPException(404,"Project tidak ditemukan")
    return item

@app.post("/api/v1/projects/{project_id}/archive")
def project_archive(project_id: str):
    if not archive_project(project_id): raise HTTPException(404,"Project tidak ditemukan atau sudah diarsipkan")
    return {"archived":True,"project_id":project_id}

@app.post("/api/v1/projects/{project_id}/sources/local", status_code=201)
def source_import(project_id: str, payload: SourceImport):
    try: return import_local_file(project_id,payload.file_path)
    except FileNotFoundError as exc: raise HTTPException(404,str(exc))
    except LookupError as exc: raise HTTPException(404,str(exc))
    except ValueError as exc: raise HTTPException(422,str(exc))
    except Exception as exc: raise HTTPException(500,str(exc))


@app.post("/api/v1/sources/youtube/import", status_code=201)
def source_youtube_import(payload: YouTubeImport):
    """Queue a YouTube download asynchronously — returns immediately with status='downloading'."""
    try:
        project_id = payload.project_id
        if not project_id:
            active = list_projects()
            project = active[0] if active else create_project("SEVNT Workspace")
            project_id = project["id"]
        if not get_project(project_id):
            raise HTTPException(404, "Project tidak ditemukan")

        # Create a placeholder source entry immediately
        from sevnt_engine.core.database import db_session
        src_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        with db_session() as conn:
            conn.execute(
                "INSERT INTO media_sources (id, project_id, source_kind, original_uri, acquisition_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
                (src_id, project_id, "remote_url", payload.url, "downloading", now, now),
            )
        placeholder = {"id": src_id, "project_id": project_id, "source_kind": "remote_url",
                       "original_uri": payload.url, "acquisition_status": "downloading", "created_at": now}

        def _download():
            import traceback, logging, shutil as _shutil, subprocess as _sp
            from sevnt_engine.services.media import probe_media
            from sevnt_engine.services.semantic_clips import analyze_source
            from sevnt_engine.core.database import APP_DIR
            try:
                # ── 1. Download video + subtitle
                result = import_youtube_video(project_id, payload.url, payload.max_height)
                video_path = Path(result["video_path"])
                subtitle_transcript = result.get("subtitle_transcript")

                # ── 2. Probe video for metadata
                try:
                    probe = probe_media(video_path)
                except Exception:
                    probe = {}

                filename = video_path.name
                ts2 = datetime.now(timezone.utc).isoformat()
                with db_session() as conn:
                    conn.execute(
                        "UPDATE media_sources SET acquisition_status=?, filename=?, local_path=?, "
                        "duration_seconds=?, width=?, height=?, updated_at=? WHERE id=?",
                        ("ready", filename, str(video_path),
                         probe.get("duration_seconds"), probe.get("width"), probe.get("height"), ts2, src_id),
                    )
                logging.info(f"[YouTube] download sukses: {src_id} — {filename}")

                # ── 3. Save transcript (subtitle) so analyze works without Whisper
                if subtitle_transcript and subtitle_transcript.get("segments"):
                    transcript_dir = APP_DIR / "projects" / project_id / "media" / src_id / "transcripts"
                    transcript_dir.mkdir(parents=True, exist_ok=True)
                    transcript_path = transcript_dir / "transcript.json"
                    transcript_path.write_text(
                        __import__("json").dumps(subtitle_transcript, ensure_ascii=False, indent=2),
                        encoding="utf-8"
                    )
                    logging.info(f"[YouTube] Transkrip disimpan: {len(subtitle_transcript['segments'])} segmen")

                    # ── 4. Auto-analyze clips
                    try:
                        analysis = analyze_source(src_id)
                        clip_count = len(analysis.get("clips") or [])
                        ts3 = datetime.now(timezone.utc).isoformat()
                        with db_session() as conn:
                            conn.execute("UPDATE media_sources SET acquisition_status=?, updated_at=? WHERE id=?",
                                         ("ready", ts3, src_id))
                        logging.info(f"[YouTube] Auto-analyze selesai: {clip_count} klip ditemukan")
                    except Exception as exc_a:
                        logging.warning(f"[YouTube] Auto-analyze gagal (akan coba manual): {exc_a}")
                else:
                    logging.info("[YouTube] Tidak ada subtitle — analisis perlu transkrip manual (Whisper)")

            except Exception as exc:
                logging.error(f"[YouTube] download gagal [{src_id}]: {exc}\n{traceback.format_exc()}")
                ts2 = datetime.now(timezone.utc).isoformat()
                with db_session() as conn:
                    conn.execute("UPDATE media_sources SET acquisition_status=?, updated_at=? WHERE id=?", ("failed", ts2, src_id))

        threading.Thread(target=_download, daemon=True).start()
        return placeholder
    except HTTPException:
        raise
    except FileNotFoundError as exc:
        raise HTTPException(503, str(exc))
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    except RuntimeError as exc:
        raise HTTPException(422, str(exc))
    except Exception as exc:
        raise HTTPException(500, f"Akuisisi YouTube gagal: {exc}")

@app.get("/api/v1/projects/{project_id}/sources")
def sources_list(project_id: str):
    if not get_project(project_id): raise HTTPException(404,"Project tidak ditemukan")
    return {"items":list_sources(project_id)}

@app.get("/api/v1/sources/{source_id}")
def source_detail(source_id: str):
    item=get_source(source_id)
    if not item: raise HTTPException(404,"Media source tidak ditemukan")
    return item

# ── In-memory render job queue ──
_jobs: dict = {}  # job_id → {status, progress, message, output_path?, error?}

@app.get("/api/v1/jobs")
def list_jobs():
    return {"items": list(_jobs.values())}

@app.post("/api/v1/sources/{source_id}/clips/{clip_id}/render")
def clip_render(source_id: str, clip_id: str, payload: PipelineRenderRequest | None = None):
    item = get_source(source_id)
    if not item:
        raise HTTPException(404, "Media source tidak ditemukan")
    settings = payload or PipelineRenderRequest()
    job_id = str(uuid.uuid4())
    _jobs[job_id] = {"job_id": job_id, "status": "pending", "progress": 0, "message": "Mengantre render…"}

    def _run():
        _jobs[job_id].update({"status": "running", "progress": 5, "message": "Memulai render klip…"})
        try:
            result = render_clips(
                source_id,
                settings.caption_preset,
                settings.caption_font,
                settings.render_options(),
            )
            output_path: str | None = None
            for clip in result.get("clips", []):
                if clip.get("id") == clip_id:
                    output_path = clip.get("output_path") or clip.get("path")
                    break
            if not output_path:
                renders = result.get("renders", [])
                for r in renders:
                    if r.get("clip_id") == clip_id or r.get("id") == clip_id:
                        output_path = r.get("output_path") or r.get("path")
                        break
            _jobs[job_id].update({
                "status": "completed", "progress": 100,
                "message": "Render selesai", "output_path": output_path,
            })
        except Exception as exc:
            _jobs[job_id].update({"status": "failed", "progress": 0, "error": str(exc), "message": str(exc)})

    threading.Thread(target=_run, daemon=True).start()
    return {"job_id": job_id}

@app.get("/api/v1/jobs/{job_id}/progress")
def job_progress_sse(job_id: str):
    def generate():
        for _ in range(300):  # max 5 min at 1s interval
            job = _jobs.get(job_id, {"job_id": job_id, "status": "not_found", "progress": 0, "message": "Job tidak ditemukan"})
            yield f"data: {_json.dumps(job)}\n\n"
            status = job.get("status", "")
            if status in ("completed", "failed", "cancelled", "not_found"):
                break
            time.sleep(1)
    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.get("/api/v1/system/processing-capabilities")
def processing_capabilities_route():
    return processing_capabilities()

@app.post("/api/v1/sources/{source_id}/decode-test")
def source_decode_test(source_id: str):
    try: return decode_test(source_id)
    except FileNotFoundError as exc: raise HTTPException(404, str(exc))
    except RuntimeError as exc: raise HTTPException(422, str(exc))

@app.post("/api/v1/sources/{source_id}/audio-extract")
def source_audio_extract(source_id: str):
    try: return extract_audio(source_id)
    except FileNotFoundError as exc: raise HTTPException(404, str(exc))
    except RuntimeError as exc: raise HTTPException(422, str(exc))

@app.post("/api/v1/sources/{source_id}/thumbnails")
def source_thumbnails(source_id: str, payload: ThumbnailRequest):
    try: return generate_thumbnails(source_id, payload.count)
    except FileNotFoundError as exc: raise HTTPException(404, str(exc))
    except ValueError as exc: raise HTTPException(422, str(exc))
    except RuntimeError as exc: raise HTTPException(422, str(exc))

@app.post("/api/v1/sources/{source_id}/frame")
def source_frame(source_id: str, payload: FrameRequest):
    try: return extract_frame(source_id, payload.timestamp_seconds)
    except FileNotFoundError as exc: raise HTTPException(404, str(exc))
    except ValueError as exc: raise HTTPException(422, str(exc))
    except RuntimeError as exc: raise HTTPException(422, str(exc))

@app.get("/api/v1/sources/{source_id}/artifacts/{kind}/{filename}")
def source_artifact(source_id: str, kind: str, filename: str):
    from pathlib import Path
    from sevnt_engine.core.database import APP_DIR
    item = get_source(source_id)
    if not item: raise HTTPException(404, "Media source tidak ditemukan")
    if kind not in {"thumbnails", "frames", "media", "transcripts"}: raise HTTPException(400, "Jenis artifact tidak valid")
    safe_name = Path(filename).name
    target = APP_DIR / "projects" / item["project_id"] / "media" / item["id"] / kind / safe_name
    if kind == "media": target = APP_DIR / "projects" / item["project_id"] / "media" / item["id"] / safe_name
    if not target.is_file(): raise HTTPException(404, "Artifact tidak ditemukan")
    return FileResponse(target)


@app.get("/api/v1/system/whisper-capabilities")
def whisper_capabilities_route():
    return whisper_capabilities()

@app.post("/api/v1/sources/{source_id}/transcribe")
def source_transcribe(source_id: str, payload: TranscriptionRequest):
    try:
        return transcribe_source(source_id, payload.model, payload.language, payload.word_timestamps)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    except RuntimeError as exc:
        raise HTTPException(422, str(exc))

@app.get("/api/v1/sources/{source_id}/transcription-status")
def source_transcription_status(source_id: str):
    from sevnt_engine.core.database import APP_DIR
    item = get_source(source_id)
    if not item:
        raise HTTPException(404, "Media source tidak ditemukan")
    path = APP_DIR / "projects" / item["project_id"] / "media" / item["id"] / "transcripts" / "transcript.json"
    if path.is_file():
        import json
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            n_segs = len(data.get("segments", []))
            return {"status": "done", "segments": n_segs}
        except Exception:
            return {"status": "done", "segments": 0}
    return {"status": "pending"}

@app.get("/api/v1/sources/{source_id}/transcript")
def source_transcript(source_id: str):
    import json
    from sevnt_engine.core.database import APP_DIR
    item = get_source(source_id)
    if not item:
        raise HTTPException(404, "Media source tidak ditemukan")
    path = APP_DIR / "projects" / item["project_id"] / "media" / item["id"] / "transcripts" / "transcript.json"
    if not path.is_file():
        raise HTTPException(404, "Transkrip belum tersedia. Jalankan endpoint transcribe terlebih dahulu.")
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/api/v1/sources/{source_id}/transcript/quality")
def source_transcript_quality(source_id: str):
    try: return transcript_quality(source_id)
    except FileNotFoundError as exc: raise HTTPException(404, str(exc))
    except ValueError as exc: raise HTTPException(422, str(exc))

@app.patch("/api/v1/sources/{source_id}/transcript/word")
def source_transcript_correct_word(source_id: str, payload: WordCorrection):
    try: return correct_word(source_id, payload.segment_index, payload.word_index, payload.word)
    except FileNotFoundError as exc: raise HTTPException(404, str(exc))
    except IndexError as exc: raise HTTPException(422, str(exc))
    except ValueError as exc: raise HTTPException(422, str(exc))

@app.patch("/api/v1/sources/{source_id}/transcript/segment")
def source_transcript_correct_segment(source_id: str, payload: SegmentCorrection):
    try: return correct_segment(source_id, payload.segment_index, payload.text)
    except FileNotFoundError as exc: raise HTTPException(404, str(exc))
    except IndexError as exc: raise HTTPException(422, str(exc))
    except ValueError as exc: raise HTTPException(422, str(exc))

@app.get("/api/v1/sources/{source_id}/transcript/revisions")
def source_transcript_revisions(source_id: str):
    try: return transcript_revisions(source_id)
    except FileNotFoundError as exc: raise HTTPException(404, str(exc))


@app.get("/api/v1/sources/{source_id}/video")
def source_video_preview(source_id: str):
    """Serve a browser-compatible H.264 preview; the original media remains untouched."""
    try:
        result = create_browser_preview(source_id)
        return FileResponse(result["preview_path"], media_type="video/mp4", filename="sevnt_preview.mp4",
                            headers={"Cache-Control": "no-store", "Accept-Ranges": "bytes"})
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    except RuntimeError as exc:
        raise HTTPException(422, str(exc))

@app.get("/api/v1/sources/{source_id}/clips/{clip_id}/preview")
def clip_preview(source_id: str, clip_id: str, start: float = 0, end: float = 60):
    """Fast-extract a short clip segment (stream copy) and serve it. Cached on disk."""
    try:
        path = extract_clip_preview(source_id, start, end, clip_id)
        return FileResponse(str(path), media_type="video/mp4",
                            headers={"Cache-Control": "public, max-age=3600", "Accept-Ranges": "bytes"})
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    except RuntimeError as exc:
        raise HTTPException(422, str(exc))


@app.get("/api/v1/sources/{source_id}/audio")
def source_audio_preview(source_id: str):
    try:
        audio_path = get_transcript_audio(source_id)
        return FileResponse(audio_path, media_type="audio/wav", filename="audio_16k_mono.wav")
    except FileNotFoundError as exc: raise HTTPException(404, str(exc))


@app.post("/api/v1/sources/{source_id}/transcript/align")
def source_transcript_align(source_id: str, payload: SegmentAlignmentRequest | None = None):
    try:
        return align_transcript(source_id, payload.segment_index if payload else None)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    except IndexError as exc:
        raise HTTPException(422, str(exc))
    except ValueError as exc:
        raise HTTPException(422, str(exc))


class ClipEditRequest(BaseModel):
    start: float | None = Field(default=None, ge=0)
    end: float | None = Field(default=None, gt=0)
    status: str | None = None
    keep_ranges: list | None = None

class ClipSplitRequest(BaseModel):
    at_seconds: float = Field(ge=0)

class SemanticAnalysisRequest(BaseModel):
    min_duration: float = Field(default=12, ge=5, le=90)
    max_duration: float = Field(default=45, ge=10, le=180)
    max_clips: int = Field(default=8, ge=1, le=20)

class PipelineRenderRequest(BaseModel):
    caption_preset: str = Field(default="clean", pattern="^(clean|impact|neon|yellow|editorial|outline|redbox|pastel|marker|off)$")
    caption_font: str = Field(default="Arial", pattern="^(Arial|Impact|Georgia|Verdana|Trebuchet MS|Comic Sans MS|Bangers|DM Serif Text|Inter SOCL Bold|Noto Sans SOCL Medium|Open Sauce Two Bold|Sour Gummy SOCL Bold|Staatliches)$")
    caption_color: str = Field(default="#FFFFFF", pattern="^#[0-9a-fA-F]{6}$")
    caption_size: int = Field(default=64, ge=28, le=140)
    caption_position: str = Field(default="bottom", pattern="^(top|center|bottom)$")
    caption_animation: str = Field(default="fade", pattern="^(none|fade|pop|rise)$")
    caption_case: str = Field(default="original", pattern="^(original|uppercase)$")
    watermark_enabled: bool = False
    watermark_text: str = Field(default="", max_length=80)
    watermark_color: str = Field(default="#FFFFFF", pattern="^#[0-9a-fA-F]{6}$")
    watermark_opacity: float = Field(default=0.72, ge=0.1, le=1.0)
    watermark_position: str = Field(default="bottom-right", pattern="^(top-left|top-right|bottom-left|bottom-right)$")
    hook_title_enabled: bool = False
    hook_title_duration: float = Field(default=2.5, ge=0.5, le=8.0)

    def render_options(self):
        return self.model_dump(exclude={"caption_preset", "caption_font"})

@app.post("/api/v1/sources/{source_id}/clips/analyze")
@app.post("/api/v1/sources/{source_id}/analyze")
def source_semantic_clip_analysis(source_id: str, payload: SemanticAnalysisRequest | None = None):
    req = payload or SemanticAnalysisRequest()
    if req.max_duration <= req.min_duration:
        raise HTTPException(422, "max_duration harus lebih besar dari min_duration")
    try:
        return analyze_source(source_id, req.min_duration, req.max_duration, req.max_clips)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    except ValueError as exc:
        raise HTTPException(422, str(exc))

@app.patch("/api/v1/sources/{source_id}/clips/{clip_id}")
def source_clip_update(source_id: str, clip_id: str, payload: ClipEditRequest):
    try:
        changes = payload.model_dump(exclude_unset=True)
        return update_clip(source_id, clip_id, changes)
    except FileNotFoundError as exc: raise HTTPException(404, str(exc))
    except LookupError as exc: raise HTTPException(404, str(exc))
    except ValueError as exc: raise HTTPException(422, str(exc))

@app.post("/api/v1/sources/{source_id}/clips/{clip_id}/split")
def source_clip_split(source_id: str, clip_id: str, payload: ClipSplitRequest):
    try: return split_clip(source_id, clip_id, payload.at_seconds)
    except FileNotFoundError as exc: raise HTTPException(404, str(exc))
    except LookupError as exc: raise HTTPException(404, str(exc))
    except ValueError as exc: raise HTTPException(422, str(exc))

@app.delete("/api/v1/sources/{source_id}/clips/{clip_id}")
def source_clip_delete(source_id: str, clip_id: str):
    try: return delete_clip(source_id, clip_id)
    except FileNotFoundError as exc: raise HTTPException(404, str(exc))
    except LookupError as exc: raise HTTPException(404, str(exc))

@app.get("/api/v1/sources/{source_id}/clips")
def source_semantic_clips(source_id: str):
    import json as _json_local
    from sevnt_engine.core.database import APP_DIR, db_session
    item = get_source(source_id)
    if not item:
        raise HTTPException(404, "Media source tidak ditemukan")

    # Read from SQLite clip_candidates (primary store)
    with db_session() as conn:
        rows = conn.execute(
            "SELECT id, score_breakdown_json, status, updated_at FROM clip_candidates WHERE source_id=? ORDER BY score DESC",
            (source_id,),
        ).fetchall()

    if rows:
        clips = []
        for row in rows:
            try:
                clip_data = _json_local.loads(row["score_breakdown_json"])
            except Exception:
                clip_data = {}
            clip_data["clip_id"] = row["id"]
            clip_data["status"] = row["status"]
            clips.append(clip_data)
        return {"source_id": source_id, "clips": clips, "candidate_count": len(clips)}

    # Fallback: JSON file (sources analyzed before this version)
    path = APP_DIR / "projects" / item["project_id"] / "media" / item["id"] / "analysis" / "semantic-clips.json"
    if not path.is_file():
        raise HTTPException(404, "Analisis klip belum tersedia. Jalankan AI Semantic Clip Detection terlebih dahulu.")
    return _json_local.loads(path.read_text(encoding="utf-8"))


@app.post("/api/v1/sources/{source_id}/clips/pipeline")
def source_full_pipeline(source_id: str, payload: PipelineRenderRequest | None = None):
    settings = payload or PipelineRenderRequest()
    try:
        analysis = analyze_source(source_id, min_duration=12, max_duration=45, max_clips=8)
        rendered = render_clips(source_id, settings.caption_preset, settings.caption_font, settings.render_options())
        return {"source_id": source_id, "status": "completed", "analysis": analysis,
                "rendered_count": rendered["rendered_count"], "clips": rendered["clips"],
                "renders": rendered["renders"], "output_directory": rendered["output_directory"]}
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(422, str(exc))
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.post("/api/v1/sources/{source_id}/clips/render")
def source_render_clips(source_id: str, payload: PipelineRenderRequest | None = None):
    settings = payload or PipelineRenderRequest()
    try:
        return render_clips(source_id, settings.caption_preset, settings.caption_font, settings.render_options())
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    except RuntimeError as exc:
        raise HTTPException(422, str(exc))
    except Exception as exc:
        raise HTTPException(500, str(exc))

# ── Caption config (persisted to SQLite app_settings) ────────────────────────

class CaptionConfig(BaseModel):
    caption_style: str | None = None
    anim: str | None = None
    words_per_caption: str | None = None
    dim_bg: float | None = None
    kinetic_on: bool | None = None
    kinetic_type: str | None = None
    kinetic_bg: str | None = None
    font: str | None = None
    font_color: str | None = None
    font_size: int | None = None
    caption_pos: int | None = None
    watermark: dict | None = None

@app.post("/api/v1/caption/config")
def set_caption_config(payload: CaptionConfig):
    from sevnt_engine.core.database import db_session
    from datetime import datetime, timezone
    config = payload.model_dump(exclude_none=True)
    now = datetime.now(timezone.utc).isoformat()
    with db_session() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
            ("caption_config", _json.dumps(config), now),
        )
    return {"status": "ok", "config": config}

@app.get("/api/v1/caption/config")
def get_caption_config():
    from sevnt_engine.core.database import db_session
    with db_session() as conn:
        row = conn.execute(
            "SELECT value_json FROM app_settings WHERE key = ?", ("caption_config",)
        ).fetchone()
    if not row:
        return {}
    try:
        return _json.loads(row["value_json"])
    except Exception:
        return {}

# ── Source probe endpoint (GAP-03) ────────────────────────────────────────────

@app.get("/api/v1/sources/{source_id}/probe")
def source_probe(source_id: str):
    from sevnt_engine.services.media import get_source
    item = get_source(source_id)
    if not item:
        raise HTTPException(404, "Media source tidak ditemukan")
    return item

# ── License endpoints ─────────────────────────────────────────────────────────

class LicenseActivateRequest(BaseModel):
    key: str = Field(min_length=10, max_length=60)

class LicenseDeactivateRequest(BaseModel):
    key: str | None = None

@app.get("/api/v1/license/status")
def license_status():
    # License authority is the Electron License Manager, not the Python engine.
    # Read from the license_status.json file written by Electron instead of
    # calling the Python license service directly.
    import os
    data_dir = os.environ.get("SEVNT_DATA_DIR", "")
    if data_dir:
        status_path = Path(data_dir) / "license_status.json"
        if status_path.exists():
            try:
                with open(status_path, "r", encoding="utf-8") as f:
                    return _json.load(f)
            except Exception:
                pass
    return {"status": "inactive", "message": "License status unavailable"}

@app.post("/api/v1/license/activate")
def license_activate(payload: LicenseActivateRequest):
    # Activation must be done through SEVNT Studio Settings UI (Electron IPC).
    raise HTTPException(403, "License activation must be done through SEVNT Studio Settings.")

@app.post("/api/v1/license/deactivate")
def license_deactivate(payload: LicenseDeactivateRequest | None = None):
    # Deactivation must be done through SEVNT Studio Settings UI (Electron IPC).
    raise HTTPException(403, "License deactivation must be done through SEVNT Studio Settings.")

@app.get("/api/v1/sources/{source_id}/renders/{filename}")
def source_render_file(source_id: str, filename: str):
    from sevnt_engine.services.semantic_clips import get_render_file
    try:
        target = get_render_file(source_id, filename)
        media_type = "image/jpeg" if target.suffix.lower() in {".jpg", ".jpeg"} else "image/png" if target.suffix.lower() == ".png" else "video/mp4"
        return FileResponse(target, media_type=media_type, filename=Path(filename).name)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
