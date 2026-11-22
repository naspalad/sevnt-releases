# SEVNT Production Integration QA

This layer is separate from the renderer-mock suite. It launches the real Electron package entry point (sevnt-main.js), uses the production src/preload.js, and exercises real local media binaries.

## Commands

- npm run test:qa:production-ipc — launch real Electron Main + Preload and invoke safe production IPC handlers.
- npm run test:qa:production-media — render actual fixture media with bundled FFmpeg/FFprobe, validate metadata and decode, then start the real bundled Python EngineSupervisor and verify its authenticated runtime/capabilities.
- npm run test:qa:production-persistence — write a harmless settings marker through production IPC, fully close Electron, relaunch against the same disposable userData profile, and verify the marker remains.

Run these after npm install. The media suite also requires the platform's bundled Python runtime from npm run engine:runtime or an explicit SEVNT_ENGINE_PYTHON path.

## Isolation and safety

- Production Electron is launched only in unpackaged QA mode.
- SEVNT_QA_USER_DATA must resolve inside the OS temporary directory; the app rejects any other path.
- The test profile is disposable and removed after each suite.
- The Python Engine is disabled during IPC/persistence tests to isolate those checks.
- No real license activation, external provider request, Telegram send, update install, or destructive History operation is performed.

## What each layer proves

### Production IPC
- The actual application entry point starts.
- The actual preload bridge is present.
- Safe read-only calls reach registered production IPC handlers (settings, app info, history inspection, local model/engine status and Telegram/mobile status).
- A missing handler or rejected IPC call fails the suite.

### Production media
- Bundled FFmpeg performs real trim/crop, subtitle/overlay, and split-screen encoding.
- Bundled FFprobe confirms H.264 video streams, dimensions and non-zero duration.
- FFmpeg decodes every generated output.
- The real Python Engine starts, protects authenticated endpoints with its launch token, and reports runtime/media/Whisper capabilities.

Important boundary: the currently shipped src/sevnt-engine.js starts engine/sevnt_engine/server.py, whose mounted API is the S1 health/system/ASR surface. It does not mount the separate engine/sevnt_engine/api/main.py project/render API. Therefore this suite proves the production binary/runtime path and real output integrity, but it does not yet prove every legacy renderer action (Editor/Watermark/Crop/Split) calls a single end-to-end production render service. Those UI-to-render integrations remain explicitly NOT COVERED rather than being reported as PASS.

### Restart persistence
- Settings are written using the production setSettings IPC handler.
- Electron is fully terminated.
- The same isolated profile is reopened.
- The production getSettings handler must return the exact marker after restart.

## Status semantics

- PASS means the specific production path in that test completed and its output/evidence was checked.
- FAIL means a tested production path returned an error or violated an assertion.
- BLOCKED means a required platform runtime or binary is missing.
- NOT COVERED means the application architecture does not currently expose an end-to-end production path for that feature.
- No mock result is counted as a production PASS.
