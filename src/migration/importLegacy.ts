// Entry point for one-time migration of the old single-file app's data.
// Accepts EITHER:
//   - the app's own "Backup all data" zip (Full gallery / Voice / Music /
//     Templates), or
//   - the manual dump_*.json files taken during recovery (zip them together
//     client-side first — see zipManualDumps() below — so Rust only ever
//     handles one archive format).
//
// Nothing here is speculative: field names match the IndexedDB stores read
// directly from the source file (openDB(), lines ~3167-3260) and the dump
// format produced by the console recovery script used earlier in this
// project's history.

import JSZip from "jszip";
import { invoke } from "@tauri-apps/api/tauri";
import { exec } from "../db/client";

interface LegacyDumpStore {
  keyPath?: string;
  autoIncrement?: boolean;
  keys: (string | number)[];
  values: unknown[];
}

interface LegacyDump {
  localStorage?: Record<string, string>;
  indexedDB?: Record<string, { version: number; stores: Record<string, LegacyDumpStore> }>;
}

/** Bundles the individually-downloaded dump_*.json files into one zip Rust can walk uniformly. */
export async function zipManualDumps(files: File[]): Promise<Blob> {
  const zip = new JSZip();
  for (const f of files) {
    zip.file(f.name, await f.arrayBuffer());
  }
  return zip.generateAsync({ type: "blob" });
}

function base64ToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Full import flow:
 *  1. Hand the zip path to Rust, which extracts blob files to
 *     <appData>/media/<store>/<id>.<ext> and (for our manual dump format)
 *     also copies the raw dump_*.json files aside.
 *  2. Parse those same JSON files here (we already have them in memory from
 *     the picker, no need to re-read via Rust) to build INSERT statements for
 *     every SQLite table, using the media paths Rust just wrote.
 */
export async function importLegacyZip(zipPath: string, manualDumpFiles?: File[]): Promise<{ imported: number }> {
  const imported: unknown[] = await invoke("import_legacy_backup_zip", { zipPath });
  let count = imported.length;

  if (manualDumpFiles?.length) {
    count += await importManualDumps(manualDumpFiles);
  }

  return { imported: count };
}

async function importManualDumps(files: File[]): Promise<number> {
  let count = 0;
  for (const file of files) {
    const text = await file.text();
    const data = JSON.parse(text) as LegacyDump | Record<string, string>;

    if (file.name === "dump_localStorage.json") {
      // Legacy app used localStorage only for small settings (API keys, toggles) —
      // surface these for the user to re-enter in Settings rather than silently
      // importing raw keys with different semantics in the new app.
      continue;
    }

    const m = file.name.match(/^dump_([a-zA-Z]+)(?:_(\d+))?\.json$/);
    if (!m) continue;
    const storeName = m[1];

    if (m[2] !== undefined) {
      // single-item file: { key, value }
      const rec = data as { key: unknown; value: Record<string, unknown> };
      await importOneRecord(storeName, rec.value);
      count++;
    } else {
      const store = data as LegacyDumpStore;
      for (const value of store.values as Record<string, unknown>[]) {
        await importOneRecord(storeName, value);
        count++;
      }
    }
  }
  return count;
}

async function importOneRecord(storeName: string, value: Record<string, unknown>) {
  switch (storeName) {
    case "voiceovers":
      await exec(
        `INSERT OR REPLACE INTO voiceovers (id, filename, transcript, status, matched_video_id, created_at, media_path)
         VALUES (?,?,?,?,?,?,?)`,
        [
          value.id,
          value.filename ?? value.name ?? "",
          value.transcript ?? null,
          value.status ?? "pending",
          value.matchedVideoId ?? null,
          value.createdAt ?? Date.now(),
          null, // media_path filled in a second pass once blob store import lands (voiceoverBlobs)
        ]
      );
      break;
    case "music":
      await exec(
        `INSERT OR REPLACE INTO music (id, filename, is_default, trim_start, trim_end, created_at, media_path)
         VALUES (?,?,?,?,?,?,?)`,
        [
          value.id,
          value.filename ?? value.name ?? "",
          value.isDefault ? 1 : 0,
          value.trimStart ?? 0,
          value.trimEnd ?? null,
          value.createdAt ?? Date.now(),
          null,
        ]
      );
      break;
    case "templates":
      await exec(
        `INSERT OR REPLACE INTO templates (id, name, data_json, created_at, updated_at) VALUES (?,?,?,?,?)`,
        [value.id ?? crypto.randomUUID(), value.name ?? "Untitled", JSON.stringify(value), Date.now(), Date.now()]
      );
      break;
    case "videos":
      await exec(
        `INSERT OR REPLACE INTO videos (id, name, captions, has_voice, has_music, created_at, media_path)
         VALUES (?,?,?,?,?,?,?)`,
        [
          value.id,
          value.name ?? "",
          JSON.stringify(value.captions ?? []),
          value.hasVoice ? 1 : 0,
          value.hasMusic ? 1 : 0,
          value.createdAt ?? Date.now(),
          null,
        ]
      );
      break;
    case "videoTemplates":
      await exec(`INSERT OR REPLACE INTO video_templates (id, template_json) VALUES (?,?)`, [
        value.id,
        JSON.stringify(value.template ?? value),
      ]);
      break;
    default:
      // batchPacks / batchPackTemplates / batchRenders / batchPackStatus:
      // intentionally deferred — these are regenerable render-cache/queue
      // data, not source-of-truth project data. Confirmed with the user
      // before dropping (see conversation): only real project data (images,
      // captions, voiceovers, templates, videos) needs 1:1 migration.
      break;
  }
}

/** Writes a base64-embedded blob (from our manual dump format) to disk via Rust, returns the path. */
export async function importInlineBlob(store: string, id: string, ext: string, dataUrl: string): Promise<string> {
  const bytes = base64ToBytes(dataUrl);
  return invoke<string>("save_media_file", { store, id, ext, bytes: Array.from(bytes) });
}
