from __future__ import annotations
from pathlib import Path
from datetime import datetime, timezone
import json
import re
from difflib import SequenceMatcher
from sevnt_engine.core.database import APP_DIR
from sevnt_engine.services.media import get_source

CONFIDENCE_REVIEW_THRESHOLD = 0.65


def _paths(source_id: str):
    item = get_source(source_id)
    if not item:
        raise FileNotFoundError("Media source tidak ditemukan")
    root = APP_DIR / "projects" / item["project_id"] / "media" / item["id"]
    transcript_dir = root / "transcripts"
    transcript_path = transcript_dir / "transcript.json"
    if not transcript_path.is_file():
        raise FileNotFoundError("Transkrip belum tersedia. Jalankan endpoint transcribe terlebih dahulu.")
    return item, root, transcript_dir, transcript_path


def _load(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"File transkrip tidak valid: {exc}") from exc
    if not isinstance(data.get("segments"), list):
        raise ValueError("Struktur transkrip tidak memiliki daftar segments yang valid")
    return data


def _rebuild_text(data: dict):
    data["text"] = " ".join((s.get("text") or "").strip() for s in data["segments"] if (s.get("text") or "").strip()).strip()


def _tokens(text: str) -> list[str]:
    return re.findall(r"\S+", (text or "").strip())


def _norm(token: str) -> str:
    return re.sub(r"^[^\w]+|[^\w]+$", "", token.casefold(), flags=re.UNICODE)


def _align_segment_words(segment: dict) -> dict:
    """Align corrected display tokens to original word intervals.

    Exact token matches retain their original timing. Replacements receive a
    proportional interval over the replaced source span and are explicitly
    marked estimated. Insertions receive a zero-duration anchor and require review.
    Original word objects are retained in source_words for audit/re-alignment.
    """
    current_words = segment.get("words") or []
    if "source_words" not in segment:
        segment["source_words"] = [dict(w) for w in current_words]
    source_words = segment.get("source_words") or []
    target_tokens = _tokens(segment.get("text", ""))
    source_tokens = [str(w.get("word", "")).strip() for w in source_words]
    matcher = SequenceMatcher(a=[_norm(x) for x in source_tokens], b=[_norm(x) for x in target_tokens], autojunk=False)
    aligned = []
    review_count = 0
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        old = source_words[i1:i2]
        new = target_tokens[j1:j2]
        if tag == "equal":
            for offset, token in enumerate(new):
                item = dict(old[offset])
                item["word"] = token
                item["alignment_status"] = "exact"
                item["source_word_indices"] = [i1 + offset]
                aligned.append(item)
        elif tag == "replace" and new:
            if old:
                start = min(float(w.get("start", segment.get("start", 0))) for w in old)
                end = max(float(w.get("end", start)) for w in old)
                # A many-to-one replacement that swallows a long phrase is not
                # safe to time as one long word (e.g. "quant ... sekarang" -> "cuan").
                if len(old) > max(2, len(new) * 2):
                    for token in new:
                        first = old[0]
                        item = {"start": float(first.get("start", start)), "end": float(first.get("end", start)), "word": token,
                                "probability": min((float(w.get("probability", 1.0)) for w in old), default=0.0),
                                "alignment_status": "needs_review", "source_word_indices": list(range(i1, i2)),
                                "source_span": {"start": round(start, 3), "end": round(end, 3)}}
                        aligned.append(item)
                else:
                    weights = [max(1, len(re.sub(r"\W", "", t))) for t in new]
                    total = sum(weights)
                    cursor = start
                    for idx, (token, weight) in enumerate(zip(new, weights)):
                        next_cursor = end if idx == len(new) - 1 else cursor + (end - start) * weight / total
                        item = {"start": round(cursor, 3), "end": round(next_cursor, 3), "word": token,
                                "probability": min((float(w.get("probability", 1.0)) for w in old), default=0.0),
                                "alignment_status": "estimated", "source_word_indices": list(range(i1, i2))}
                        aligned.append(item); cursor = next_cursor
            else:
                anchor = float(source_words[i1 - 1].get("end", segment.get("start", 0))) if i1 else float(segment.get("start", 0))
                for token in new:
                    aligned.append({"start": anchor, "end": anchor, "word": token, "probability": None,
                                    "alignment_status": "needs_review", "source_word_indices": []})
                    review_count += 1
        elif tag == "insert":
            anchor = float(source_words[i1 - 1].get("end", segment.get("start", 0))) if i1 else float(segment.get("start", 0))
            for token in new:
                aligned.append({"start": anchor, "end": anchor, "word": token, "probability": None,
                                "alignment_status": "needs_review", "source_word_indices": []})
                review_count += 1
        # delete: source tokens are intentionally omitted from corrected words.
    segment["words"] = aligned
    exact_count = sum(w.get("alignment_status") == "exact" for w in aligned)
    estimated_count = sum(w.get("alignment_status") == "estimated" for w in aligned)
    needs_review_count = sum(w.get("alignment_status") == "needs_review" for w in aligned)
    # Keep the segment-level state consistent with its word-level records.
    # Estimated means a timestamp exists but was inferred; needs_review means
    # at least one word has no safe precise timestamp.
    if needs_review_count:
        segment_status = "needs_review"
    elif estimated_count:
        segment_status = "estimated"
    else:
        segment_status = "exact"
    segment["alignment"] = {
        "status": segment_status,
        "method": "token-sequence-alignment",
        "exact_word_count": exact_count,
        "estimated_word_count": estimated_count,
        "needs_review_word_count": needs_review_count,
        "source_word_count": len(source_words),
        "corrected_word_count": len(aligned),
    }
    return segment["alignment"]


def align_transcript(source_id: str, segment_index: int | None = None) -> dict:
    item, root, folder, path = _paths(source_id)
    data = _load(path)
    if not (folder / "transcript.original.json").exists():
        (folder / "transcript.original.json").write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    indices = range(len(data["segments"])) if segment_index is None else [segment_index]
    results = []
    for idx in indices:
        try:
            segment = data["segments"][idx]
        except IndexError:
            raise IndexError("Index segmen tidak ditemukan")
        results.append({"segment_index": idx, **_align_segment_words(segment)})
    _rebuild_text(data)
    _save(path, data)
    return {"source_id": source_id, "aligned_segment_count": len(results), "segments": results,
            "note": "exact = timestamp sumber cocok; estimated = timestamp diperkirakan dan perlu diperiksa; needs_review = minimal satu kata belum memiliki timestamp yang aman. Periksa estimated/needs_review sebelum subtitle presisi atau pemotongan otomatis."}


def _save(path: Path, data: dict):
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def transcript_quality(source_id: str) -> dict:
    item, root, folder, path = _paths(source_id)
    data = _load(path)
    flagged_words=[]; flagged_segments=[]; total_words=0
    for si, segment in enumerate(data["segments"]):
        words = segment.get("words") or []
        low=[]
        for wi, word in enumerate(words):
            total_words += 1
            probability = word.get("probability")
            if probability is not None and float(probability) < CONFIDENCE_REVIEW_THRESHOLD:
                entry={"segment_index":si,"word_index":wi,"word":word.get("word",""),
                       "start":word.get("start"),"end":word.get("end"),"probability":probability}
                flagged_words.append(entry); low.append(entry)
        if low:
            flagged_segments.append({"segment_index":si,"start":segment.get("start"),"end":segment.get("end"),
                                     "text":segment.get("text",""),"flagged_word_count":len(low)})
    return {"source_id":source_id,"filename":item.get("filename"),"threshold":CONFIDENCE_REVIEW_THRESHOLD,
            "segment_count":len(data["segments"]),"word_count":total_words,
            "flagged_word_count":len(flagged_words),"flagged_segment_count":len(flagged_segments),
            "flagged_words":flagged_words,"flagged_segments":flagged_segments,
            "note":"Confidence adalah sinyal pemeriksaan, bukan ukuran pasti benar/salah. Kata tanpa probability tidak otomatis ditandai."}


def get_transcript_audio(source_id: str) -> Path:
    item, root, folder, path = _paths(source_id)
    audio = root / "audio_16k_mono.wav"
    if not audio.is_file():
        raise FileNotFoundError("Audio hasil ekstraksi belum tersedia")
    return audio


def correct_word(source_id: str, segment_index: int, word_index: int, word: str) -> dict:
    clean = " ".join((word or "").split())
    if not clean or len(clean) > 120:
        raise ValueError("Teks kata wajib diisi dan maksimal 120 karakter")
    item, root, folder, path = _paths(source_id)
    data = _load(path)
    try:
        target = data["segments"][segment_index]["words"][word_index]
    except (IndexError, KeyError, TypeError):
        raise IndexError("Index segmen/kata tidak ditemukan. Muat ulang transkrip sebelum mengedit.")
    original = target.get("word", "")
    if "source_words" not in data["segments"][segment_index]:
        data["segments"][segment_index]["source_words"] = [dict(w) for w in data["segments"][segment_index].get("words", [])]
    if not (folder / "transcript.original.json").exists():
        (folder / "transcript.original.json").write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    target["word"] = clean
    # Preserve timestamps and probability exactly; rebuild only text fields.
    segment = data["segments"][segment_index]
    segment["text"] = re.sub(r"\s+([,.;:!?%])", r"\1", " ".join((w.get("word", "") or "").strip() for w in (segment.get("words") or [])).strip())
    _rebuild_text(data)
    _save(path, data)
    log_path = folder / "corrections.jsonl"
    record={"at":datetime.now(timezone.utc).isoformat(),"segment_index":segment_index,"word_index":word_index,
            "from":original,"to":clean,"start":target.get("start"),"end":target.get("end")}
    with log_path.open("a",encoding="utf-8") as f: f.write(json.dumps(record,ensure_ascii=False)+"\n")
    return {"source_id":source_id,"segment_index":segment_index,"word_index":word_index,
            "word":target,"segment":segment,"transcript_text":data.get("text"),"saved":True,
            "timestamps_preserved":True}


def correct_segment(source_id: str, segment_index: int, text: str) -> dict:
    clean = " ".join((text or "").split())
    if not clean or len(clean) > 2000:
        raise ValueError("Teks segmen wajib diisi dan maksimal 2000 karakter")
    item, root, folder, path = _paths(source_id)
    data = _load(path)
    try: segment = data["segments"][segment_index]
    except IndexError: raise IndexError("Index segmen tidak ditemukan")
    if not (folder / "transcript.original.json").exists():
        (folder / "transcript.original.json").write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    before=segment.get("text", "")
    segment["text"] = clean
    alignment = _align_segment_words(segment)
    _rebuild_text(data); _save(path,data)
    record={"at":datetime.now(timezone.utc).isoformat(),"segment_index":segment_index,
            "from":before,"to":clean,"scope":"segment","alignment":alignment}
    with (folder/"corrections.jsonl").open("a",encoding="utf-8") as f: f.write(json.dumps(record,ensure_ascii=False)+"\n")
    return {"source_id":source_id,"segment_index":segment_index,"segment":segment,
            "transcript_text":data.get("text"),"saved":True,"alignment":alignment,
            "original_word_timestamps_preserved":True}


def transcript_revisions(source_id: str) -> dict:
    item, root, folder, path = _paths(source_id)
    original = folder / "transcript.original.json"
    log = folder / "corrections.jsonl"
    entries=[]
    if log.exists():
        for line in log.read_text(encoding="utf-8").splitlines():
            try: entries.append(json.loads(line))
            except Exception: continue
    return {"source_id":source_id,"has_original_backup":original.exists(),"correction_count":len(entries),"items":entries}
