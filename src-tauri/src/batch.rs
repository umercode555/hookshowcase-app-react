// Replaces the old "hidden 1x1-clipped iframe running the full pipeline
// headless" trick. That existed only to keep Chrome from throttling an
// off-screen tab's canvas/encoder — a real OS process has no such throttling,
// so batch jobs become plain async tasks with real concurrency control.
//
// This is a phase-7 skeleton (see MIGRATION.md): the queue and status
// reporting are wired end-to-end; the actual per-pack pipeline (mp3 match,
// speed change, sync, render) is invoked in the frontend today and will move
// here incrementally, one stage at a time, without changing this command's
// external shape.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize, Clone, Deserialize)]
pub struct PackStatus {
    pub id: String,
    pub stage: String, // queued | preparing | good_to_go | no_mp3_match | rendering | done | error
    pub message: Option<String>,
    pub percent: f32,
}

#[derive(Default)]
pub struct BatchState(pub Mutex<HashMap<String, PackStatus>>);

#[tauri::command]
pub async fn enqueue_batch_pack(
    app: AppHandle,
    state: State<'_, BatchState>,
    pack_id: String,
) -> Result<(), String> {
    {
        let mut map = state.0.lock().map_err(|_| "lock poisoned")?;
        map.insert(
            pack_id.clone(),
            PackStatus { id: pack_id.clone(), stage: "queued".into(), message: None, percent: 0.0 },
        );
    }
    let _ = app.emit("batch-status", state.0.lock().map_err(|_| "lock poisoned")?.get(&pack_id).cloned());
    // Real pipeline stages get spawned here as tokio tasks in later phases,
    // each updating BatchState and emitting "batch-status" as it progresses —
    // concurrency-limited (e.g. semaphore of N) instead of "however many hidden
    // iframes the renderer process can keep alive".
    Ok(())
}

#[tauri::command]
pub fn get_batch_status(state: State<'_, BatchState>, pack_id: String) -> Result<Option<PackStatus>, String> {
    let map = state.0.lock().map_err(|_| "lock poisoned")?;
    Ok(map.get(&pack_id).cloned())
}
