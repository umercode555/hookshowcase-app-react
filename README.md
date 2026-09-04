# Hook & Showcase v2 — Tauri + React + TypeScript

Rebuild of the original single-file `hook_showcase (2).html` product-video
editor as a real desktop application. See **MIGRATION.md** for the full
architecture rationale, complete feature inventory pulled from the old code,
and the phased build plan — this scaffold implements phases 1–2 and stubs
3–8.

## What's implemented in this pass

- `src-tauri/` — Rust/Tauri shell: file-based media storage (replaces
  IndexedDB blob stores), ffmpeg-sidecar export command (replaces
  WebCodecs/MediaRecorder/ffmpeg.wasm), batch job queue skeleton.
- `src/db/` — SQLite schema mirroring every original IndexedDB store.
- `src/engine/renderer.ts` — pixel-faithful port of the canvas drawing logic
  (`coverDraw`, `drawCard`, `drawShowcase`, `drawHookFlash`, timeline math).
- `src/engine/export.ts` — frame-sequence writer + ffmpeg invocation.
- `src/services/groqSync.ts` — faithful port of the Groq transcription call
  and the fuzzy/forced-alignment voice-sync algorithm.
- `src/store/appStore.ts` — Zustand state + O(1)-per-step undo/redo (replaces
  the original's full-project JSON.stringify snapshotting).
- `src/migration/importLegacy.ts` — imports the app's own "Backup all data"
  zip (or the manual `dump_*.json` recovery files) with no data loss.
- `src/App.tsx` — minimal working shell proving the stack renders live state
  through the ported engine end-to-end.

## Prerequisites

- Node.js 18+
- Rust stable (`rustup`) + platform build tools (Xcode CLT on macOS /
  `build-essential` on Linux / MSVC Build Tools on Windows)
- A real `ffmpeg` binary per target platform, placed at
  `src-tauri/binaries/ffmpeg-<target-triple>` (Tauri sidecar naming
  convention) — download static builds from https://ffmpeg.org/download.html
  or `johnvansickle.com/ffmpeg` (Linux) / `evermeet.cx/ffmpeg` (macOS).

## Setup

```bash
npm install
npm run tauri:dev      # desktop app, hot-reloading
npm run tauri:build    # production installer for the current platform
```

## Migrating your existing data

1. In the old app, click **Backup all data** (already generates a zip with
   every image/video/audio blob + metadata) — or use the `dump_*.json` files
   from manual console recovery if that's what you have.
2. Launch the new app, click **Import legacy backup.zip** in the right panel,
   pick that file.
3. Everything lands in `<app data dir>/media/` on disk plus rows in
   `hookshowcase.db` (SQLite) — inspect with any SQLite browser if you want to
   verify before deleting the old browser-based copy.

## Next steps (phases 3–8, see MIGRATION.md §5)

The scaffold intentionally stops at a working foundation rather than a
half-finished full UI — every remaining screen (image tray, color picker,
gallery, voice/music libraries, batch grid, voice control) is a self-contained
phase that plugs into `appStore.ts` / `db/client.ts` / `engine/renderer.ts`
without needing to revisit this pass's code.
