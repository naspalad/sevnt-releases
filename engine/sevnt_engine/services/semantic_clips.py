from __future__ import annotations
import json, re
from pathlib import Path
from datetime import datetime, timezone
from sevnt_engine.core.database import APP_DIR
from sevnt_engine.services.media import get_source

HOOK = ("ini ceritaku", "pernah nggak", "pernah gak", "pernahkah", "ternyata", "rahasia", "cuma", "modal", "jangan", "stop", "kesalahan", "cara", "begini", "kenapa", "gimana", "bagaimana", "hasil", "akhirnya", "aku", "saya")
VALUE = ("cara", "langkah", "tips", "strategi", "panduan", "resep", "rumus", "hpp", "modal", "jual", "harga", "untung", "hasil", "belajar", "gunakan", "pilihan", "bikin", "membuat", "karena", "supaya", "agar")
EMOTION = ("takut", "senang", "sedih", "gagal", "berhasil", "kaget", "menyesal", "alhamdulillah", "akhirnya", "percaya", "viral", "rahasia", "masalah", "bingung", "mudah", "susah")
CTA = ("klik", "comment", "komen", "beli", "sekarang", "pesan", "ikuti", "follow", "daftar", "amankan", "promo", "diskon", "link", "keranjang")
FILLERS = {"eee", "ee", "em", "eh", "anu", "apa", "hmm"}


def _tokens(text: str) -> list[str]:
    return re.findall(r"[\w'-]+", (text or "").lower(), flags=re.UNICODE)


def _score_window(segments: list[dict], start: float, end: float) -> dict:
    text = " ".join((s.get("text") or "").strip() for s in segments).strip()
    tokens = _tokens(text)
    unique = set(tokens)
    if not tokens:
        return {"score": 0, "text": text, "category": "general", "reasons": []}
    joined = " ".join(tokens)
    hook_hits = sum(1 for p in HOOK if p in joined)
    value_hits = sum(1 for p in VALUE if p in joined)
    emotion_hits = sum(1 for p in EMOTION if p in joined)
    cta_hits = sum(1 for p in CTA if p in joined)
    question = "?" in text
    # Lexical/structural features are deliberately transparent and tunable; this is not a trained viral predictor.
    hook = min(100, 35 + hook_hits * 18 + (12 if question else 0))
    value = min(100, 28 + value_hits * 15 + min(20, len(unique) * 0.65))
    emotion = min(100, 25 + emotion_hits * 22)
    completeness = 70 if len(segments) >= 2 else 45
    if text.rstrip().endswith(('.', '?', '!')): completeness += 15
    if len(tokens) >= 24: completeness += 10
    completeness = min(100, completeness)
    duration = max(0.1, end - start)
    duration_score = 100 if 15 <= duration <= 42 else max(35, 100 - min(abs(duration-15), abs(duration-42))*2.2)
    filler_ratio = sum(1 for t in tokens if t in FILLERS) / max(1, len(tokens))
    confidence_values = [float(w['probability']) for s in segments for w in (s.get('words') or []) if w.get('probability') is not None]
    low_conf = sum(1 for p in confidence_values if p < .55) / max(1, len(confidence_values))
    alignment_penalty = sum(1 for s in segments if (s.get('alignment') or {}).get('status') == 'needs_review') * 5
    score = round(max(0, min(99, hook*.24 + value*.25 + emotion*.14 + completeness*.20 + duration_score*.12 + min(100, cta_hits*30)*.05 - filler_ratio*25 - low_conf*12 - alignment_penalty)))
    reasons=[]
    if hook_hits: reasons.append("Memiliki frasa pembuka yang menarik")
    if value_hits: reasons.append("Mengandung informasi atau manfaat praktis")
    if emotion_hits: reasons.append("Memiliki unsur cerita atau emosi")
    if cta_hits: reasons.append("Memuat ajakan atau konteks promosi")
    if completeness < 70: reasons.append("Perlu dicek agar konteks tidak terpotong")
    if not reasons: reasons.append("Dipilih berdasarkan kepadatan informasi dan struktur kalimat")
    category = "story" if emotion_hits >= max(value_hits, hook_hits) else ("education" if value_hits else ("promotion" if cta_hits else "hook"))
    return {"score":score,"text":text,"category":category,"reasons":reasons,
            "signals":{"hook":round(hook),"value":round(value),"emotion":round(emotion),"completeness":round(completeness),"duration":round(duration_score),"cta":cta_hits}}


def analyze_source(source_id: str, min_duration: float = 12, max_duration: float = 45, max_clips: int = 8) -> dict:
    source = get_source(source_id)
    if not source: raise FileNotFoundError("Media source tidak ditemukan")
    folder = APP_DIR / "projects" / source["project_id"] / "media" / source_id
    transcript_path = folder / "transcripts" / "transcript.json"
    if not transcript_path.is_file(): raise FileNotFoundError("Transkrip belum tersedia. Jalankan Whisper dan pastikan transkrip sudah disimpan.")
    data = json.loads(transcript_path.read_text(encoding="utf-8"))
    segments = data.get("segments") or []
    if len(segments) < 2: raise ValueError("Diperlukan minimal dua segmen transkrip untuk analisis klip.")
    candidates=[]
    n=len(segments)
    for i in range(n):
        for j in range(i+1, min(n, i+7)+1):
            group=segments[i:j]
            start=float(group[0].get("start",0) or 0)
            end=float(group[-1].get("end",start) or start)
            duration=end-start
            if duration < min_duration: continue
            if duration > max_duration: break
            scored=_score_window(group,start,end)
            if len(_tokens(scored["text"])) < 18: continue
            # Build short title from most scored text (first sentence or first 8 words)
            first_text = (group[0].get("text") or "").strip()
            words = first_text.split()
            short_title = " ".join(words[:8]) + ("…" if len(words) > 8 else "")
            candidates.append({"start":round(start,3),"end":round(end,3),"duration":round(duration,2),
                "segment_start":i,"segment_end":j-1,"score":scored["score"],"category":scored["category"],
                "hook": first_text, "title": short_title, "transcript":scored["text"],
                "reasons":scored["reasons"],"signals":scored["signals"],"status":"suggested"})
    candidates.sort(key=lambda x:(x["score"], -x["duration"]), reverse=True)
    selected=[]
    for item in candidates:
        overlap=False
        for kept in selected:
            inter=max(0,min(item["end"],kept["end"])-max(item["start"],kept["start"]))
            union=max(item["end"],kept["end"])-min(item["start"],kept["start"])
            if union and inter/union > .55:
                overlap=True; break
        if not overlap:
            start_ms = round(item["start"] * 1000)
            end_ms = round(item["end"] * 1000)
            item["clip_id"] = f"clip-{len(selected)+1}-{start_ms}-{end_ms}"
            selected.append(item)
        if len(selected)>=max_clips: break
    result={"source_id":source_id,"filename":source.get("filename"),"engine":"local-semantic-scoring-v1",
        "analysis_mode":"transcript-first heuristic scoring","created_at":datetime.now(timezone.utc).isoformat(),
        "candidate_count":len(selected),"clips":selected,
        "method_note":"Skor v1 memakai sinyal leksikal dan struktur transkrip (hook, nilai informasi, emosi, kelengkapan, durasi, CTA, confidence, dan alignment). Ini adalah ranking awal yang transparan, bukan prediksi viral terlatih. Tinjau konteks dan batas klip sebelum render."}
    out=folder/"analysis"; out.mkdir(parents=True,exist_ok=True)
    (out/"semantic-clips.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
    _persist_candidates_to_db(source_id, source["project_id"], selected)
    return result


def _db_status(status: str) -> str:
    """Map JSON/in-memory status values to DB CHECK-compatible values."""
    return {"suggested": "candidate", "reviewed": "candidate", "approved": "selected"}.get(status, status)


def _persist_candidates_to_db(source_id: str, project_id: str, candidates: list[dict]) -> None:
    from sevnt_engine.core.database import db_session
    now = datetime.now(timezone.utc).isoformat()
    with db_session() as conn:
        for c in candidates:
            conn.execute(
                """INSERT OR REPLACE INTO clip_candidates
                   (id, project_id, source_id, title, hook_text,
                    start_seconds, end_seconds, score, score_breakdown_json,
                    topic_key, detection_method, detection_version,
                    status, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    c["clip_id"], project_id, source_id,
                    c.get("title", ""), c.get("hook", ""),
                    float(c["start"]), float(c["end"]),
                    float(c.get("score", 0)),
                    json.dumps(c, ensure_ascii=False),
                    c.get("category"),
                    "local-semantic-scoring-v1", "1",
                    _db_status(c.get("status", "candidate")),
                    now, now,
                ),
            )


def _analysis_file(source_id: str) -> tuple[dict, Path, dict]:
    source = get_source(source_id)
    if not source:
        raise FileNotFoundError("Media source tidak ditemukan")
    folder = APP_DIR / "projects" / source["project_id"] / "media" / source_id
    path = folder / "analysis" / "semantic-clips.json"
    if not path.is_file():
        raise FileNotFoundError("Analisis klip belum tersedia")
    data = json.loads(path.read_text(encoding="utf-8"))
    return source, path, data

def _save_analysis(path: Path, data: dict) -> None:
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

def update_clip(source_id: str, clip_id: str, changes: dict) -> dict:
    source, path, data = _analysis_file(source_id)
    clips = data.get("clips") or []
    clip = next((c for c in clips if c.get("clip_id") == clip_id), None)
    if not clip:
        raise LookupError("Clip tidak ditemukan")
    start = float(changes.get("start", clip["start"]))
    end = float(changes.get("end", clip["end"]))
    duration = float(source.get("duration_seconds") or source.get("probe", {}).get("duration_seconds") or 0)
    if start < 0 or end <= start:
        raise ValueError("Waktu akhir harus lebih besar dari waktu awal dan keduanya tidak boleh negatif")
    if duration and end > duration + 0.05:
        raise ValueError(f"Waktu akhir melewati durasi video ({duration:.2f} detik)")
    if end - start < 0.5:
        raise ValueError("Durasi klip minimal 0,5 detik")
    clip["start"] = round(start, 3)
    clip["end"] = round(end, 3)
    clip["duration"] = round(end-start, 3)
    if "status" in changes:
        if changes["status"] not in {"suggested", "reviewed", "approved", "rendered"}:
            raise ValueError("Status clip tidak valid")
        clip["status"] = changes["status"]
    if "keep_ranges" in changes:
        clip["keep_ranges"] = changes["keep_ranges"]
    clip["edited_at"] = datetime.now(timezone.utc).isoformat()
    clip["edit_origin"] = "user"
    _save_analysis(path, data)
    # Sync to SQLite
    _now = datetime.now(timezone.utc).isoformat()
    try:
        from sevnt_engine.core.database import db_session
        with db_session() as conn:
            conn.execute(
                "UPDATE clip_candidates SET start_seconds=?, end_seconds=?, status=?, score_breakdown_json=?, updated_at=? WHERE id=?",
                (clip["start"], clip["end"], _db_status(clip.get("status", "candidate")), json.dumps(clip, ensure_ascii=False), _now, clip_id),
            )
    except Exception:
        pass
    return {"source_id": source_id, "clip": clip, "clips": clips}

def split_clip(source_id: str, clip_id: str, at_seconds: float) -> dict:
    source, path, data = _analysis_file(source_id)
    clips = data.get("clips") or []
    clip = next((c for c in clips if c.get("clip_id") == clip_id), None)
    if not clip:
        raise LookupError("Clip tidak ditemukan")
    point = float(at_seconds)
    if point <= float(clip["start"]) + 0.5 or point >= float(clip["end"]) - 0.5:
        raise ValueError("Titik split harus menyisakan minimal 0,5 detik di kedua sisi")
    left = dict(clip); right = dict(clip)
    left["clip_id"] = f"{clip_id}-A"; right["clip_id"] = f"{clip_id}-B"
    left["end"] = round(point, 3); left["duration"] = round(point-float(clip["start"]), 3)
    right["start"] = round(point, 3); right["duration"] = round(float(clip["end"])-point, 3)
    left["status"] = right["status"] = "suggested"
    left["edit_origin"] = right["edit_origin"] = "user_split"
    left["edited_at"] = right["edited_at"] = datetime.now(timezone.utc).isoformat()
    index = clips.index(clip)
    clips[index:index+1] = [left, right]
    for i, item in enumerate(clips, 1):
        item["clip_number"] = i
    data["candidate_count"] = len(clips)
    _save_analysis(path, data)
    # Sync to SQLite: replace original with two halves
    _now = datetime.now(timezone.utc).isoformat()
    try:
        source_obj = get_source(source_id)
        project_id = source_obj["project_id"] if source_obj else ""
        from sevnt_engine.core.database import db_session
        with db_session() as conn:
            conn.execute("DELETE FROM clip_candidates WHERE id=?", (clip_id,))
            for new_clip in [left, right]:
                conn.execute(
                    """INSERT OR REPLACE INTO clip_candidates
                       (id, project_id, source_id, title, hook_text,
                        start_seconds, end_seconds, score, score_breakdown_json,
                        topic_key, detection_method, detection_version,
                        status, created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        new_clip["clip_id"], project_id, source_id,
                        new_clip.get("title", ""), new_clip.get("hook", ""),
                        float(new_clip["start"]), float(new_clip["end"]),
                        float(new_clip.get("score", 0)),
                        json.dumps(new_clip, ensure_ascii=False),
                        new_clip.get("category"),
                        "local-semantic-scoring-v1", "1",
                        _db_status(new_clip.get("status", "candidate")),
                        _now, _now,
                    ),
                )
    except Exception:
        pass
    return {"source_id": source_id, "clips": clips, "split": [left, right]}

def delete_clip(source_id: str, clip_id: str) -> dict:
    _source, path, data = _analysis_file(source_id)
    clips = data.get("clips") or []
    remaining = [c for c in clips if c.get("clip_id") != clip_id]
    if len(remaining) == len(clips):
        raise LookupError("Clip tidak ditemukan")
    for i, item in enumerate(remaining, 1):
        item["clip_number"] = i
    data["clips"] = remaining
    data["candidate_count"] = len(remaining)
    _save_analysis(path, data)
    # Sync to SQLite
    try:
        from sevnt_engine.core.database import db_session
        with db_session() as conn:
            conn.execute("DELETE FROM clip_candidates WHERE id=?", (clip_id,))
    except Exception:
        pass
    return {"source_id": source_id, "clips": remaining, "deleted_clip_id": clip_id}


def render_clips(source_id: str, caption_preset: str = "clean", caption_font: str = "Arial", render_options: dict | None = None) -> dict:
    """Render clips atomically and publish only files that pass stream + decode validation."""
    import os
    import shutil
    import subprocess
    import uuid

    options = render_options or {}
    source, analysis_path, data = _analysis_file(source_id)
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg:
        raise RuntimeError("FFmpeg tidak ditemukan. Pastikan FFmpeg tersedia di PATH.")
    if not ffprobe:
        raise RuntimeError("FFprobe tidak ditemukan. Instal FFmpeg lengkap (termasuk ffprobe) dan pastikan masuk PATH.")

    source_path = Path(source.get("local_path") or source.get("original_uri") or "")
    if not source_path.is_file():
        raise FileNotFoundError("File video sumber tidak ditemukan di lokasi asal.")
    clips = data.get("clips") or []
    if not clips:
        raise RuntimeError("Belum ada kandidat klip untuk dirender.")

    output_dir = analysis_path.parent / "renders"
    output_dir.mkdir(parents=True, exist_ok=True)
    rendered = []
    allowed_presets = {"clean", "impact", "neon", "yellow", "editorial", "outline", "redbox", "pastel", "marker", "off"}
    allowed_fonts = {"Arial", "Impact", "Georgia", "Verdana", "Trebuchet MS", "Comic Sans MS", "Bangers", "DM Serif Text", "Inter SOCL Bold", "Noto Sans SOCL Medium", "Open Sauce Two Bold", "Sour Gummy SOCL Bold", "Staatliches"}
    if caption_preset not in allowed_presets: raise ValueError("Caption preset tidak dikenal.")
    if caption_font not in allowed_fonts: raise ValueError("Font caption tidak diizinkan.")
    def safe_color(value: str, fallback: str) -> str:
        value = str(value or fallback)
        return value if re.fullmatch(r"#[0-9a-fA-F]{6}", value) else fallback
    caption_color = safe_color(options.get("caption_color"), "#FFFFFF")
    caption_size = max(28, min(140, int(options.get("caption_size", 64))))
    caption_position = options.get("caption_position", "bottom")
    if caption_position not in {"top", "center", "bottom"}: caption_position = "bottom"
    caption_animation = options.get("caption_animation", "fade")
    if caption_animation not in {"none", "fade", "pop", "rise"}: caption_animation = "fade"
    caption_case = options.get("caption_case", "original")
    if caption_case not in {"original", "uppercase"}: caption_case = "original"
    watermark_text = str(options.get("watermark_text") or "").strip()[:80]
    watermark_enabled = bool(options.get("watermark_enabled")) and bool(watermark_text)
    watermark_color = safe_color(options.get("watermark_color"), "#FFFFFF")
    watermark_opacity = max(0.1, min(1.0, float(options.get("watermark_opacity", 0.72))))
    watermark_position = options.get("watermark_position", "bottom-right")
    hook_title_enabled = bool(options.get("hook_title_enabled"))
    hook_title_duration = max(0.5, min(8.0, float(options.get("hook_title_duration", 2.5))))
    if watermark_position not in {"top-left", "top-right", "bottom-left", "bottom-right"}: watermark_position = "bottom-right"
    transcript_path = analysis_path.parent.parent / "transcripts" / "transcript.json"
    transcript_segments = []
    if (caption_preset != "off" or watermark_enabled or hook_title_enabled) and transcript_path.is_file():
        try: transcript_segments = (json.loads(transcript_path.read_text(encoding="utf-8")).get("segments") or [])
        except Exception: transcript_segments = []

    def ass_time(seconds: float) -> str:
        seconds = max(0.0, seconds)
        h = int(seconds // 3600); m = int((seconds % 3600) // 60); sec = seconds % 60
        return f"{h}:{m:02d}:{sec:05.2f}"

    def make_ass(clip: dict, path: Path) -> bool:
        if (caption_preset == "off" or not transcript_segments) and not watermark_enabled and not hook_title_enabled: return False
        styles = {
            "clean": ("&H00FFFFFF", "&H00000000", 3, 2, 64, 1),
            "impact": ("&H0000FFFF", "&H00000000", 5, 3, 76, 1),
            "neon": ("&H00FFFFFF", "&H00FF66FF", 5, 2, 68, 1),
            "yellow": ("&H0000D7FF", "&H00000000", 4, 2, 70, 1),
            "editorial": ("&H00FFFFFF", "&H00101010", 2, 1, 62, 0),
            "outline": ("&H00FFFFFF", "&H00000000", 7, 1, 70, 1),
            "redbox": ("&H00FFFFFF", "&H000000FF", 1, 1, 66, 1),
            "pastel": ("&H00F2E6FF", "&H006B465A", 3, 1, 62, 1),
            "marker": ("&H00FFFFFF", "&H00000000", 3, 1, 68, 1),
        }
        if caption_preset == "off":
            primary, outline_color, outline, shadow, size, bold = ("&H00FFFFFF", "&H00000000", 0, 0, caption_size, 1)
        else:
            primary, outline_color, outline, shadow, size, bold = styles[caption_preset]
        def ass_color(hex_color: str) -> str:
            h = hex_color.lstrip("#")
            return "&H00" + h[4:6] + h[2:4] + h[0:2]
        primary = ass_color(caption_color)
        size = caption_size
        alignment = {"bottom": 2, "center": 5, "top": 8}[caption_position]
        family = "Georgia" if caption_preset == "editorial" and caption_font == "Arial" else caption_font
        header = "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        header += f"Style: Default,{family},{size},{primary},&H000000FF,{outline_color},&H96000000,{bold},0,0,0,100,100,0,0,1,{outline},{shadow},{alignment},70,70,150,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        events = []
        effect_tag = {"none": "", "fade": r"{\fad(120,120)}", "pop": r"{\fscx85\fscy85\t(0,120,\fscx100\fscy100)}", "rise": r"{\move(540,1740,540,1600,0,180)}"}[caption_animation]
        if caption_preset != "off":
            for seg in transcript_segments:
                a = max(float(seg.get("start", 0) or 0), float(clip["start"]))
                b = min(float(seg.get("end", 0) or 0), float(clip["end"]))
                text = str(seg.get("text") or "").strip()
                if b <= a or not text: continue
                if caption_case == "uppercase": text = text.upper()
                text = text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}").replace("\n", "\\N")
                events.append(f"Dialogue: 0,{ass_time(a-float(clip['start']))},{ass_time(b-float(clip['start']))},Default,,0,0,0,,{effect_tag}{text}")
        if hook_title_enabled and str(clip.get("hook") or "").strip():
            hook = str(clip.get("hook") or "").strip()[:110]
            hook = hook.upper().replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}").replace("\n", "\\N")
            hook_end = ass_time(min(hook_title_duration, float(clip["end"])-float(clip["start"])))
            events.append(f"Dialogue: 2,0:00:00.00,{hook_end},Default,,70,70,0,,{{\\an5\\fs78\\bord4\\shad2\\fad(120,220)}}{hook}")
        if watermark_enabled:
            wm_hex = watermark_color.lstrip("#")
            wm_ass = "&H" + f"{int((1-watermark_opacity)*255):02X}" + wm_hex[4:6] + wm_hex[2:4] + wm_hex[0:2]
            wm_align = {"bottom-left": 1, "bottom-right": 3, "top-left": 7, "top-right": 9}[watermark_position]
            wm_text = watermark_text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}").replace("\n", "\\N")
            events.append(f"Dialogue: 1,0:00:00.00,{ass_time(float(clip['end'])-float(clip['start']))},Default,,35,35,45,,{{\\an{wm_align}\\fs30\\1c{wm_ass}}}{wm_text}")
        if not events: return False
        path.write_text(header + "\n".join(events) + "\n", encoding="utf-8-sig")
        return True

    def ff_filter_path(path: Path) -> str:
        def escaped(value: Path) -> str:
            return value.resolve().as_posix().replace(":", r"\:").replace("'", r"\'").replace(",", r"\,")
        fonts_dir = Path(__file__).resolve().parents[2] / "assets" / "fonts"
        return f"subtitles='{escaped(path)}':fontsdir='{escaped(fonts_dir)}'"

    def run_checked(cmd: list[str], label: str, timeout: int) -> subprocess.CompletedProcess:
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"{label}: melewati batas waktu {timeout} detik") from exc
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "Proses gagal").strip()
            raise RuntimeError(f"{label}: {detail[-1800:]}")
        return result

    for index, clip in enumerate(clips, 1):
        start = float(clip["start"])
        end = float(clip["end"])
        duration = end - start
        if start < 0 or duration <= 0:
            raise RuntimeError(f"Rentang klip {clip.get('clip_id')} tidak valid.")

        safe_id = re.sub(r"[^a-zA-Z0-9_-]", "-", str(clip.get("clip_id") or f"clip-{index:02d}"))
        filename = f"{index:02d}_{safe_id}.mp4"
        target = output_dir / filename
        # Render to a unique temporary MP4. Never expose a partially-written final filename.
        temp_target = output_dir / f".{Path(filename).stem}.{uuid.uuid4().hex}.tmp.mp4"
        vf = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1"
        ass_path = output_dir / f"{Path(filename).stem}.ass"
        if make_ass(clip, ass_path): vf += "," + ff_filter_path(ass_path)
        cmd = [
            ffmpeg, "-y", "-nostdin", "-hide_banner", "-v", "error",
            "-ss", f"{start:.3f}", "-i", str(source_path), "-t", f"{duration:.3f}",
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", vf,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-pix_fmt", "yuv420p", "-profile:v", "main",
            "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "44100",
            "-movflags", "+faststart", str(temp_target)
        ]
        try:
            run_checked(cmd, f"Render {clip.get('clip_id')}", max(180, int(duration * 30)))
            if not temp_target.is_file() or temp_target.stat().st_size < 1024:
                raise RuntimeError(f"Render {clip.get('clip_id')}: file output kosong atau terlalu kecil.")

            probe = run_checked([
                ffprobe, "-v", "error", "-show_entries",
                "stream=codec_type,codec_name,width,height",
                "-show_entries", "format=duration", "-of", "json", str(temp_target)
            ], f"Validasi metadata {clip.get('clip_id')}", 60)
            try:
                probe_data = json.loads(probe.stdout or "{}")
            except json.JSONDecodeError as exc:
                raise RuntimeError("FFprobe menghasilkan metadata yang tidak valid.") from exc
            streams = probe_data.get("streams") or []
            video = next((item for item in streams if item.get("codec_type") == "video"), None)
            if not video or video.get("codec_name") != "h264":
                raise RuntimeError(f"Validasi {clip.get('clip_id')}: stream video H.264 tidak ditemukan.")
            if int(video.get("width") or 0) != 1080 or int(video.get("height") or 0) != 1920:
                raise RuntimeError(f"Validasi {clip.get('clip_id')}: resolusi output bukan 1080x1920.")
            actual_duration = float((probe_data.get("format") or {}).get("duration") or 0)
            if actual_duration <= 0 or actual_duration > duration + 2.0:
                raise RuntimeError(f"Validasi {clip.get('clip_id')}: durasi output tidak masuk akal ({actual_duration:.3f}s).")

            # Decode every frame and audio packet before publishing the file.
            run_checked([
                ffmpeg, "-nostdin", "-hide_banner", "-v", "error",
                "-i", str(temp_target), "-map", "0:v:0", "-f", "null", "-"
            ], f"Tes decode video {clip.get('clip_id')}", max(180, int(actual_duration * 20)))
            if any(item.get("codec_type") == "audio" for item in streams):
                run_checked([
                    ffmpeg, "-nostdin", "-hide_banner", "-v", "error",
                    "-i", str(temp_target), "-map", "0:a:0", "-f", "null", "-"
                ], f"Tes decode audio {clip.get('clip_id')}", max(120, int(actual_duration * 15)))

            # Atomic replace prevents the UI/API from seeing a half-written MP4.
            os.replace(temp_target, target)
        except Exception:
            try:
                temp_target.unlink(missing_ok=True)
            except Exception:
                pass
            raise

        thumbnail_name = f"{Path(filename).stem}.jpg"
        thumbnail_path = output_dir / thumbnail_name
        thumb_cmd = [
            ffmpeg, "-y", "-nostdin", "-hide_banner", "-v", "error",
            "-ss", "0.4", "-i", str(target), "-frames:v", "1",
            "-vf", "scale=360:-2", "-q:v", "4", str(thumbnail_path)
        ]
        thumb_result = subprocess.run(thumb_cmd, capture_output=True, text=True, timeout=60)
        thumbnail_url = None
        if thumb_result.returncode == 0 and thumbnail_path.is_file() and thumbnail_path.stat().st_size > 0:
            thumbnail_url = f"/api/v1/sources/{source_id}/renders/{thumbnail_name}"

        rendered_item = {
            "filename": filename,
            "path": str(target),
            "url": f"/api/v1/sources/{source_id}/renders/{filename}",
            "thumbnail_url": thumbnail_url,
            "file_size_bytes": target.stat().st_size,
            "format": "mp4",
            "video_codec": "h264",
            "width": 1080,
            "height": 1920,
            "duration_seconds": round(actual_duration, 3),
            "validation": {"ffprobe": "passed", "video_decode": "passed",
                           "audio_decode": "passed" if any(item.get("codec_type") == "audio" for item in streams) else "not_present"},
            "status": "rendered"
        }
        clip["render"] = rendered_item
        clip["status"] = "rendered"
        rendered.append({"clip_id": clip.get("clip_id"), **rendered_item})

    data["rendered_count"] = len(rendered)
    data["pipeline_status"] = "rendered"
    _save_analysis(analysis_path, data)
    return {
        "source_id": source_id, "status": "completed",
        "rendered_count": len(rendered), "clips": data.get("clips", []),
        "renders": rendered, "output_directory": str(output_dir),
        "caption_preset": caption_preset, "caption_font": caption_font, "render_options": options,
        "note": "Klip hanya dipublikasikan setelah stream H.264 dan decoding video/audio lolos validasi. Video sumber tidak diubah. Caption dibakar bila track transkrip tersedia dan FFmpeg mendukung libass."
    }


def get_render_file(source_id: str, filename: str) -> Path:
    _source, analysis_path, _data = _analysis_file(source_id)
    safe_name = Path(filename).name
    if safe_name != filename or not safe_name.lower().endswith((".mp4", ".jpg", ".jpeg", ".png")):
        raise FileNotFoundError("Nama file render tidak valid.")
    target = analysis_path.parent / "renders" / safe_name
    if not target.is_file():
        raise FileNotFoundError("File hasil render tidak ditemukan.")
    return target
