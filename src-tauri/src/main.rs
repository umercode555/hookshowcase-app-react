#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod media;
mod export;
mod batch;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .manage(batch::BatchState::default())
        .invoke_handler(tauri::generate_handler![
            media::save_media_file,
            media::read_media_file_path,
            media::delete_media_file,
            media::media_dir_usage_bytes,
            media::import_legacy_backup_zip,
            export::render_export,
            batch::enqueue_batch_pack,
            batch::get_batch_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hook & Showcase");
}
