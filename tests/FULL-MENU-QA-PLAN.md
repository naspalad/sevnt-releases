# SEVNT Studio — Full 10-Menu QA Plan

**Status:** Renderer scenario suite implemented; not executed. Production IPC/persistence layers remain pending.  
**Branch:** `qa/full-menu-coverage-design`  
**Purpose:** Build an auditable test design for all ten menus without starting the test suite.

## 1. QA rules

1. Every user-visible control and meaningful state transition must map to one or more case IDs in the coverage manifest.
2. Mock/QA-preload tests may prove renderer behavior only. They must never be reported as production IPC or production-pipeline PASS.
3. Production integration must use the real Electron main process and `src/preload.js`, not `tests/qa-preload.cjs`.
4. Media output must be checked with `ffprobe` and decode validation, not merely by checking that an IPC call occurred.
5. Every case records PASS, FAIL, BLOCKED, NOT_IMPLEMENTED, or NOT_RUN. No silent skips.
6. A test expectation must be derived from the fixture and product contract. Do not alter production code to satisfy a wrong test expectation.

## 2. Test layers

| Layer | What it proves | Counts as production PASS? |
|---|---|---:|
| Static inventory | UI selector, renderer handler, preload API and IPC mapping exist | No |
| Renderer interaction | Controls, navigation, validation, empty/error states | No |
| Production IPC | Real preload and main-process handler behavior | Yes |
| Media pipeline | Real FFmpeg/Python work and verified output | Yes |
| Persistence | State survives app restart where required | Yes |

## 3. Menu-by-menu coverage

The machine-readable source of truth is `tests/full-menu-qa-plan.json`. It defines **10 menus and 88 explicit cases**.

### M01 — Clips
- Import local video and verify metadata.
- Paste supported/unsupported URL and verify validation.
- Attach, replace and clear transcript.
- Run Find Highlights; cover progress, completion and error.
- Exercise All/Hot/Saved filters, including empty state.
- Select Mode, Select All, individual selection, Clear and Done.
- Preview each candidate; playback, seek, close and candidate switching.
- Render Selected and Render All with one-to-one candidate/render/output reconciliation.
- Cancel pipeline/render and verify recovery.
- Validate outputs with ffprobe and decode checks.

### M02 — Clip
- Verify option groups and defaults.
- Exercise trim start/end and bounds validation.
- Exercise aspect, quality, subtitle language/burn and speed.
- Navigate between clips and verify active clip.
- Exercise playback, pause and seek.
- Verify configuration persistence.
- Render configured clip and inspect output.
- Reject invalid/contradictory values safely.

### M03 — Editor
- Open/close and load selected clip/transcript.
- Edit caption text, timing and manual captions.
- Exercise typography, color, size, position and style.
- Exercise animation/effects and preview.
- Add/edit/reorder/delete titles.
- Undo/redo multiple operations.
- Verify preview parity.
- Render and inspect subtitle/title content and media.
- Verify documented draft persistence/reset behavior.

### M04 — Watermark
- Upload valid/invalid/corrupt assets.
- Toggle enabled state.
- Exercise all anchors and X/Y geometry.
- Exercise size/opacity and preview.
- Add/edit/remove text rows.
- Delete assets and handle missing assets.
- Verify settings after restart.
- Inspect real image/text watermark output.
- Verify per-clip override precedence/reset.

### M05 — Crop Studio
- Open with selected clip and verify source.
- Exercise every aspect preset and free aspect.
- Exercise X/Y, zoom and bounds.
- Add/select/navigate/delete keyframes.
- Undo/redo/reset.
- Apply current clip and Apply All scope.
- Verify preview and final geometry.
- Render and inspect dimensions/frames.
- Verify gating without a selected clip.

### M06 — Split Studio
- Open and verify first source.
- Enable/disable, select and replace second source.
- Toggle each source's mute independently.
- Change ratio and inspect preview.
- Swap source positions.
- Exercise keyframes and undo/redo where supported.
- Apply and inspect layout/audio mix.
- Handle missing/invalid second source.
- Verify return to single-source state.

### M07 — History
- Load populated and empty history.
- Search/filter sessions and clips.
- Refresh and reconcile records.
- Open session and inspect metadata.
- Preview/reveal/open output.
- Delete selected clips and verify filesystem/history.
- Delete session and verify path safety.
- Verify history after restart.
- Handle missing/corrupt report/media safely.

### M08 — Settings
- Load defaults and verify secret masking.
- Add/test/delete every AI provider key.
- Change provider models.
- Change ASR engine and verify restart persistence.
- Save and read back settings.
- Import/replace/clear cookies and test invalid files.
- Exercise Whisper/context model status, install/remove and progress/errors.
- Exercise tracker/engine status, update and failure.
- Exercise Telegram configuration/send/clear using a safe test double.
- Exercise cache/disk operations only on temporary test data.
- Exercise license refresh/activation using a dedicated test license.
- Exercise update check/navigation without uncontrolled installation.

### M09 — Output
- Open and verify output destination/session.
- Handle missing destination.
- Verify output exists and expected container/codec.
- Verify duration, dimensions, frame rate and audio stream.
- Decode frames/audio to detect corruption/truncation.
- Verify subtitles/titles/watermark/crop/split effects when enabled.
- Verify safe filenames and no unrelated overwrite.

### M10 — Help
- Open/close from supported entry points.
- Exercise every section and internal navigation.
- Open external links safely and verify targets.
- Launch/replay/close tutorial and verify completion state.
- Handle unavailable links/media.
- Verify Help does not disturb workspace or selected project.

## 4. Implemented renderer suite

The 88 case IDs are mapped in `tests/full-menu-functional.spec.js` across ten menu-level Playwright test blocks. The tests launch the isolated QA Electron harness, use prepared video/transcript fixtures, and assert visible controls, state transitions, bridge calls and deterministic FFmpeg output where the fixture supports it. The History mock seeds a disposable QA session so open/preview/delete flows can be exercised without touching user files.

Run command (not yet executed): `npm run test:qa:menu-coverage`. The existing narrower regression file remains available through `npm run test:qa:menu-legacy`. The GitHub macOS workflow runs both suites and uploads the coverage report.

**Granularity note:** IDs are grouped by menu-level Playwright test blocks, not yet split into 88 independent Playwright test functions. A failure in a menu block can therefore mark several IDs failed together. The next refinement is to split each ID into its own test and attach per-case evidence/diagnostics.

## 5. Coverage-manifest validator

A static validator is provided at `tests/full-menu-qa-plan.test.js`. It checks the ten required menus, all 88 unique case IDs, and verifies that every planned ID is mapped in the functional Playwright suite. It does not launch the app or execute functional tests. Planned command: `node --test tests/full-menu-qa-plan.test.js`.

## 6. Harness design and evidence limits

- **Renderer suite (implemented, not executed):** Playwright against the isolated Electron QA harness with deterministic video/transcript fixtures and mock bridge responses.
- **Production IPC suite (implemented, not executed):** tests launch the real package entry point (sevnt-main.js) and production src/preload.js, then invoke safe read-only handlers. QA mode is restricted to unpackaged runs and a temp-directory userData profile.
- **Media suite (implemented, not executed; bounded coverage):** bundled FFmpeg/FFprobe perform real trim/crop, subtitle/overlay and split-screen encodes; outputs are probed and fully decoded. The real Python EngineSupervisor is also started and its bearer-token protection and S1 runtime capabilities are checked.
- **Persistence suite (implemented, not executed):** settings are written through the production setSettings IPC handler, Electron is fully closed, and the same disposable profile is relaunched to verify the marker through getSettings.
- **Important media boundary:** the running engine server currently exposes health/system/ASR only. The separate project/render API module is not mounted by server.py. Therefore editor/watermark/crop/split UI-to-production-render integration is still NOT COVERED; the media suite must not be represented as a full end-to-end pass for those effects.
- **Safety:** provider, Telegram send, license activation, update installation, cookies and destructive filesystem tests are not executed. QA profile is temporary and isolated.
- **Artifacts:** Playwright report/trace, screenshots, main-process logs, output media, ffprobe metadata, decode result and commit SHA.

## 7. Remaining implementation order

1. Split the ten menu-level blocks into 88 independently reportable test cases.
2. Extend production IPC coverage from safe read-only calls to every menu operation and assert real Main Process side effects.
3. Extend production media coverage to the actual legacy renderer-to-render path for Editor, Watermark, Crop and Split; the currently mounted Python engine API does not expose those render routes.
4. Extend restart persistence coverage to Watermark assets, History records and Editor drafts where those features promise persistence.
5. Run the full matrix on the target Windows environment and supported macOS ARM64/x64 after confirming platform runtimes; report each case and all blocked/not-covered states.

## 8. Release gates

- All 88 cases have an explicit status; no case silently omitted.
- Renderer interactions pass on supported macOS architectures.
- Production IPC tests use the real preload and main process.
- Media tests use the production FFmpeg/Python path and ffprobe/decode validation.
- Persistence tests pass across a full restart.
- No temporary skip, placeholder, or mock result is counted as production PASS.
- Each failure report identifies case ID, source location, layer, failure class, evidence and remediation.

## 9. Execution wiring

The repository has these commands:

- `npm run test:qa:plan` — validate the 10-menu / 88-case inventory and mapping.
- `npm run test:qa:menu-coverage` — run the new 88-ID renderer scenario suite and write `test-results/full-menu-qa/full-menu-qa-report.json` plus `test-results/full-menu-qa/full-menu-qa-report.md`.
- `npm run test:qa:menu-legacy` — retain the previous narrower menu interaction regression.
- `npm run test:qa:production-ipc` — real Electron Main + production Preload IPC smoke tests.
- `npm run test:qa:production-media` — real bundled FFmpeg/FFprobe transforms and authenticated Python Engine runtime smoke tests.
- `npm run test:qa:production-persistence` — settings persistence across a complete Electron restart.
- `npm run test:qa:production` — run all three production integration suites in sequence.

The custom reporter reads case IDs from Playwright test titles and reports PASS, FAIL, SKIPPED, TIMEOUT, INTERRUPTED or NOT_IMPLEMENTED. Missing IDs, skipped cases and unmapped tests make the coverage command fail.

**Current implementation boundary:** all 88 IDs are mapped into the renderer suite, which still uses the QA mock bridge. Separate production suites now exist for actual Electron IPC, real FFmpeg/FFprobe plus Python Engine smoke checks, and settings persistence across restart. These production suites are implemented but have not been executed. The media suite is not a full end-to-end proof of every legacy editor effect because the currently mounted engine API does not expose the project/render routes.

**Execution status:** no test command or GitHub Actions workflow has been run in this implementation pass. The branch is wired to run the new coverage suite, the legacy menu regression and the inventory validator in CI when a workflow run is triggered.
