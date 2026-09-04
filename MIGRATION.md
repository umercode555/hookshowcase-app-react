# Hook & Showcase — Migration Plan

## 1. Why the current app is slow/heavy

Root causes found reading the 7,944-line single-file app:

1. **All persistence is browser IndexedDB, scoped to the exact `file://` path.**
   Every state change writes through a hand-rolled `idbPut/idbGet` layer. Fine for
   small data, but blobs (images/video/audio, hundreds of MB–GB) live in the same
   engine as UI reads, so big libraries make every list/read slow, and re-downloads
   fragment storage entirely (the bug we just fixed manually).
2. **Video export happens inside the tab**, via three fallback paths (WebCodecs →
   ffmpeg.wasm → MediaRecorder), all competing for the same main-thread/GPU budget
   as the UI. On a 9:16 1080×1920 canvas this is expensive, and Chrome throttles
   background/occluded canvases, which is why the app uses a "clipped 1×1 iframe"
   hack to keep headless batch renders GPU-composited at all.
3. **Batch processing (100 packs) runs inside hidden iframes in the same renderer
   process** — there's no real worker/process isolation, so one pack's heavy
   render can stall the whole UI thread.
4. **Undo/redo snapshots the entire editor state and diffs via `JSON.stringify`**
   (`statesEqual`) — O(n) serialization of the whole project on every tracked
   edit, growing with every image/caption/timing field.
5. **No virtualization** — galleries, voice library, batch grid all render full
   DOM/canvas per item.

None of this is fixable by "keep optimizing the HTML file" — it needs process
separation (UI thread vs. encode thread vs. batch workers) and blobs to live
outside the browser's per-origin storage.

## 2. Full feature inventory (from source read)

Confirmed by direct code read, not guesswork — every one of these must survive
migration:

**Core editor**
- 3-act structure: hook flash → card → showcase, adjustable segment timing
  (hook flash duration slider, per-image showcase duration, card duration)
- Exactly-10-image project model, drag/drop or picker upload, thumbnail tray
  with reordering + remove
- Per-image caption text, word-by-word or one-line caption rendering, per-caption
  duration override
- Caption position: draggable on-canvas handle, per-segment-type position
  (hook / card / showcase independently), alignment (left/center/right),
  font-size stepper, font size scaled by `SIZE_SCALE`
- Card: solid color or image background, auto color-from-images, full HSV color
  picker (canvas-based SV square + hue strip + hex input), alpha/tint strength,
  per-word card position + per-word card text color overrides
- Live canvas preview (1080×1920), play/pause, scrub, fullscreen
- Background music: library with per-track default flag, trim (start/end
  sliders), loop under full video, live mix preview under playing voiceover

**Voice / audio pipeline**
- Voiceover library: upload MP3s, Groq Whisper transcription queue (retryable),
  auto-match voiceover→video by transcript-vs-caption scoring
  (`scoreTranscriptAgainstVideo`)
- Voice-over speed change via **SoundTouch.js time-stretch** (pitch-preserving),
  configurable speed (default 1.12x)
- Voice-to-caption **sync**: Levenshtein-based fuzzy alignment
  (`syncAlignCaption`, `globalAlignScript`) mapping transcript words to captions,
  forcing per-caption durations to match actual spoken timing
- Voice **control** of the editor itself: Web Speech recognition → Groq LLM
  command interpretation (`interpretCommand`) → `execAction` dispatch, with a
  "what can I say" help sheet, TTS spoken responses, undo/redo by voice
  ("undo the last two changes"), action history panel

**Templates**
- Save/load full project as a named template (images, captions, positions,
  font sizes, timing, card position/color, alignment) — one-click restore
- Export/import template as portable `.json`
- Locked default caption rules applied per template

**Gallery / library**
- Full video gallery grouped by day, newest first, storage usage display,
  auto-prune to keep latest N when storage gets tight
- Music library and voice library management (list, delete, use-by-default)

**Batch pipeline (the heavy part)**
- Ingest: drag a parent folder (or `.zip` via JSZip) containing many
  pack-subfolders (each: `manifest.json` + 10 images), or manual folder picker
- Per-pack **fully automatic** background pipeline: find matching MP3 → apply
  voice speed → sync captions to voice timing → apply locked caption style →
  apply default background music → render — all run **headless**, one pack at a
  time, in an off-screen-but-GPU-composited iframe
- Resumable batches (survives reload), pack-status store separated from the
  heavy pack-data store specifically to keep the status-polling grid from
  freezing Chrome (their own prior perf fix, must not regress)
- Pack grid UI (queued/preparing/good-to-go/no-mp3-match/rendering/done/error),
  per-pack sync log, "Download all packs" as a zip

**Export**
- WebCodecs (preferred, hardware-accelerated) → muxer → mp4
- ffmpeg.wasm fallback for webm→mp4 transcode
- MediaRecorder fallback path
- Final export mixes rendered voiceover + trimmed/looped background music into
  one audio track before mux

**Data safety**
- Manual "Backup all data" / "Restore all data" as a zip (blobs + metadata)
- This is the feature that just saved the user's data — must be equalled or
  bettered in the new architecture, not dropped.

## 3. Chosen architecture

**Tauri 2 (Rust shell) + React 18 + TypeScript, Vite build.**

Why this over the alternatives considered:

| Option | Verdict |
|---|---|
| Keep single HTML, just refactor/split JS | Doesn't fix the two real bottlenecks: blob storage inside browser-origin IndexedDB, and export competing with UI on one thread. Rejected. |
| Plain web app (React, still in-browser) | Same origin/storage-quota and single-process ceiling as today, just tidier code. Doesn't solve "Chrome freezing" on large batches. Rejected as the *only* layer, but is exactly what runs *inside* Tauri's webview, so none of this work is wasted even if desktop is dropped later. |
| Electron | Same capability as Tauri (native shell + web UI + node/rust backend + real filesystem), but ships a full Chromium + Node runtime per app (~150–200MB) and higher idle RAM. Given this app's whole problem is Chrome resource pressure, doubling down on bundling another Chromium is the wrong direction. |
| Full native (Swift/C++/Qt) | Would satisfy performance but throws away 100% of the existing canvas-rendering, Groq-integration, and voice-control logic, which are all naturally JS/web-API-shaped (Web Speech API, Groq SDK, Canvas2D). Massive rewrite for no compounding benefit here. |

Tauri wins because:
- **Rust backend replaces the browser as the storage layer.** Images/video/audio
  become real files on disk (fast, no quota, no per-origin fragmentation, no
  serialization tax) addressed by a lightweight **SQLite** database (via
  `tauri-plugin-sql`) for structured records — swaps the fragile hand-rolled
  IndexedDB layer for real transactions, indexes, and normal SQL joins/queries.
- **Export moves out of the webview entirely.** A Rust command shells out to a
  bundled `ffmpeg` binary (sidecar), fed either rendered PNG frame sequences or
  driven directly from a spec (positions/captions/timing) if we later port the
  canvas compositor to `ffmpeg`'s filter graph / a Rust image crate. This is
  the single biggest performance unlock: encoding no longer shares a thread or
  GPU budget with the UI, and isn't subject to Chrome's background-tab
  throttling — so the iframe-hack disappears entirely.
- **Batch pipeline becomes real background jobs.** Each pack's pipeline
  (MP3 match → speed → sync → render) runs as a Rust async task /
  `tauri::async_runtime` job with a job queue, reporting progress back to the
  UI over Tauri events — actual OS-level concurrency instead of hidden iframes
  competing inside one renderer process.
- **Everything web-shaped carries over almost unchanged:** Canvas2D preview
  rendering, Web Speech API voice control, Groq HTTP calls (transcription +
  command interpretation), SoundTouch.js time-stretch, the caption-alignment
  algorithm — all keep running in the React/TS frontend, ported with minimal
  logic changes (mostly moving IO out).
- **Cross-platform** (macOS/Windows/Linux) from one codebase, small install
  size, native performance where it matters (disk IO, encoding, batch jobs).

State/UI layer choices:
- **Zustand** for app state (replaces ~40 loose global `let`s in the current
  file) — small, no boilerplate, easy to slice per feature (editor, gallery,
  voice, batch).
- **Undo/redo rebuilt as an action log**, not full-state snapshots: each
  `execAction` records `{type, before, after}` for only the touched field(s),
  same UX (including "undo last two changes" by voice) at O(1) memory per step
  instead of O(project size).
- **react-window** for virtualized gallery/voice-library/batch-grid lists —
  needed once libraries exceed ~50-100 items, which the user is already past.

## 4. Data compatibility — no loss

The new SQLite schema mirrors every existing IndexedDB store 1:1
(`src/db/schema.ts` + `src-tauri` migrations), and `src/migration/importLegacy.ts`
directly ingests:
- The manual JSON dumps already taken during recovery (`dump_*.json`), and
- The app's own "Backup all data" zip export,

writing blobs to `<appDataDir>/media/<store>/<id>.<ext>` and metadata rows into
SQLite, so the 2GB backup already taken is the seed data for the new app —
nothing needs to be redone from scratch.

## 5. Phased build order (so nothing regresses silently)

1. **Data layer** — SQLite schema + file-blob storage + legacy importer. *(scaffolded below)*
2. **Renderer core** — port `coverDraw/drawWordByWord/drawCard/drawShowcase/drawHookFlash/renderAt`
   into a pure TS module, unit-testable independent of React. *(scaffolded below)*
3. **Editor shell** — image tray, caption fields, timing controls, color picker,
   canvas preview + scrub, wired to Zustand store.
4. **Groq services** — transcription, sync/alignment, voice command interpreter
   (near-direct port, they're already API-call-shaped).
5. **Export pipeline** — Tauri command + bundled ffmpeg sidecar, replacing
   WebCodecs/ffmpeg.wasm/MediaRecorder entirely.
6. **Templates, gallery, voice/music libraries** — CRUD screens over the new
   data layer, virtualized lists.
7. **Batch pipeline** — Rust job queue + progress events + pack grid UI,
   replacing the iframe-headless hack.
8. **Voice control** — Web Speech + Groq command loop + action-log undo/redo,
   ported last since it depends on every action existing in the new store first.

Phase 1 and 2 are implemented in this pass (below). Every later phase builds on
these without needing to revisit them.
