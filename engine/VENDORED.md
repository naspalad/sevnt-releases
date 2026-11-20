# Vendored engine (from SEVNTY APP / B)

Copied on 2026-11-17 from `SEVNTY APP\engine\sevnt_engine` (snapshot: `Documents\SEVNT_SNAPSHOTS\2026-11-17_pre-integration`).
B itself was not modified (verified: 1,196 files identical to the snapshot manifest after the work).

## What runs
Only `sevnt_engine/server.py` (new launcher) is started, by `src/engine/engine-supervisor.js`:
`python -m sevnt_engine.server` — loopback only, dynamic port, per-launch bearer token, parent-PID watchdog.
Mounted routes: `GET /health` (no token), `GET /api/v1/system/{profile,whisper-capabilities}`, `POST/GET/DELETE /api/v1/asr/...`, `POST /api/v1/shutdown`.

## What is vendored but deliberately NOT mounted (owner decisions 2026-11-17)
`api/main.py` (projects, YouTube import, render, clips, licence, transcript correction/alignment/quality/revisions), `core/`, `services/*`.
- Rendering and clipping stay in the Electron app (A).
- Transcript correction/alignment/quality/revisions (S2) are postponed until A has a UI and workflow for them.
- The engine licence router must never be mounted (A is the only licence authority). A test asserts these routes return 404.
Do NOT run `sevnt_engine.api.main` — it is unauthenticated and allows `file://`/`null` CORS origins.

## Modifications to vendored files
- `services/processing.py::_binary` and `services/media.py::probe_media`: prefer `SEVNT_FFMPEG` / `SEVNT_FFPROBE` (the app's own binaries) before PATH, so no second FFmpeg is shipped.

## New files
`server.py`, `asr_service.py` (faster-whisper S1), `memory.py`, `tests/`.
