// Replaces every `*Blobs` IndexedDB object store (videoBlobs, voiceoverBlobs,
// musicBlobs) with real files on disk under the app's data directory. This is
// the single biggest fix for the original app's freezing/size problems:
// - No per-origin quota, no `file://` path fragmentation on re-download.
// - No JSON.stringify/base64 round-trip for multi-hundred-MB blobs (that's
//   exactly what threw `RangeError: Invalid string length` during manual
//   recovery of the old app's data).
// - The SQLite `media` table stores only `{ id, store, filename, bytes,
//   created_at }` — cheap to list/query even with thousands of rows.

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn media_root(app: &AppHandle, store: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    let dir = base.join("media").join(store);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create media dir: {e}"))?;
    Ok(dir)
}

/// Save raw bytes (sent from the frontend as a Vec<u8>) to disk under
/// `<appData>/media/<store>/<id>.<ext>`, returning the absolute path to store
/// in SQLite alongside the record's metadata row.
#[tauri::command]
pub fn save_media_file(
    app: AppHandle,
    store: String,
    id: String,
    ext: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let dir = media_root(&app, &store)?;
    let path = dir.join(format!("{id}.{ext}"));
    let mut f = fs::File::create(&path).map_err(|e| format!("write failed: {e}"))?;
    f.write_all(&bytes).map_err(|e| format!("write failed: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_media_file_path(app: AppHandle, store: String, id: String, ext: String) -> Result<String, String> {
    let dir = media_root(&app, &store)?;
    let path = dir.join(format!("{id}.{ext}"));
    if !path.exists() {
        return Err(format!("media file not found: {}", path.display()));
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_media_file(app: AppHandle, store: String, id: String, ext: String) -> Result<(), String> {
    let dir = media_root(&app, &store)?;
    let path = dir.join(format!("{id}.{ext}"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("delete failed: {e}"))?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct UsageInfo {
    pub bytes: u64,
    pub file_count: u64,
}

#[tauri::command]
pub fn media_dir_usage_bytes(app: AppHandle) -> Result<UsageInfo, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?
        .join("media");
    let mut bytes = 0u64;
    let mut file_count = 0u64;
    if base.exists() {
        for entry in walkdir(&base) {
            if let Ok(meta) = fs::metadata(&entry) {
                if meta.is_file() {
                    bytes += meta.len();
                    file_count += 1;
                }
            }
        }
    }
    Ok(UsageInfo { bytes, file_count })
}

fn walkdir(dir: &PathBuf) -> Vec<PathBuf> {
    let mut out = vec![];
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                out.extend(walkdir(&p));
            } else {
                out.push(p);
            }
        }
    }
    out
}

/// Imports either:
///   1. the app's own "Backup all data" zip export, or
///   2. the manual `dump_*.json` recovery files (zipped together by the
///      frontend before calling this, for a single-file transfer)
/// Every entry is written to the same media/<store>/<id>.<ext> layout that
/// save_media_file uses, and a manifest of {store, id, ext, path} records is
/// returned so the frontend can upsert matching rows into SQLite.
#[derive(Serialize)]
pub struct ImportedItem {
    pub store: String,
    pub id: String,
    pub ext: String,
    pub path: String,
    pub json_meta: Option<String>,
}

#[tauri::command]
pub fn import_legacy_backup_zip(app: AppHandle, zip_path: String) -> Result<Vec<ImportedItem>, String> {
    let file = fs::File::open(&zip_path).map_err(|e| format!("cannot open zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("bad zip: {e}"))?;
    let mut imported = vec![];

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        // Legacy backup layout: "<store>/<id>.<ext>" for blobs, or a top-level
        // "dump_<store>.json" / "dump_localStorage.json" for metadata, matching
        // both the app's native backup zip and our manual recovery dumps.
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut buf).map_err(|e| e.to_string())?;

        if name.ends_with(".json") {
            let dir = media_root(&app, "_legacy_json")?;
            let path = dir.join(name.replace('/', "__"));
            fs::write(&path, &buf).map_err(|e| e.to_string())?;
            imported.push(ImportedItem {
                store: "_legacy_json".into(),
                id: name.clone(),
                ext: "json".into(),
                path: path.to_string_lossy().to_string(),
                json_meta: None,
            });
            continue;
        }

        if let Some((store, filename)) = name.split_once('/') {
            let (id, ext) = filename.rsplit_once('.').unwrap_or((filename, "bin"));
            let dir = media_root(&app, store)?;
            let path = dir.join(filename);
            fs::write(&path, &buf).map_err(|e| e.to_string())?;
            imported.push(ImportedItem {
                store: store.to_string(),
                id: id.to_string(),
                ext: ext.to_string(),
                path: path.to_string_lossy().to_string(),
                json_meta: None,
            });
        }
    }

    Ok(imported)
}
