// Replaces the old WebCodecs -> muxer -> ffmpeg.wasm -> MediaRecorder fallback
// chain, which ran entirely inside the tab and fought the UI for the same
// thread/GPU budget (and was why the batch pipeline needed the "clipped 1x1
// iframe" hack to avoid Chrome throttling it into silent stalls).
//
// New pipeline:
//   1. Frontend still renders every frame on <canvas> (unchanged pixel-perfect
//      logic, see src/engine/renderer.ts) and writes each frame to disk as a
//      PNG via the fs plugin — this part is cheap and doesn't need Rust.
//   2. This command hands the frame sequence + final mixed audio track to a
//      bundled `ffmpeg` binary running as a genuinely separate OS process.
//      Encoding no longer shares a thread with the UI, isn't subject to
//      Chrome tab-visibility throttling, and can use hardware encoders
//      ffmpeg exposes natively (videotoolbox / nvenc / qsv) rather than only
//      whatever WebCodecs happens to expose in-browser.

use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

#[derive(Serialize, Clone)]
pub struct ExportProgress {
    pub stage: String,
    pub percent: f32,
}

#[tauri::command]
pub async fn render_export(
    app: AppHandle,
    frames_dir: String,
    fps: u32,
    audio_path: Option<String>,
    output_path: String,
    total_frames: u32,
) -> Result<String, String> {
    let emit = |stage: &str, percent: f32| {
        let _ = app.emit(
            "export-progress",
            ExportProgress { stage: stage.into(), percent },
        );
    };

    emit("starting", 0.0);

    let frame_pattern = PathBuf::from(&frames_dir)
        .join("frame_%05d.png")
        .to_string_lossy()
        .to_string();

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-framerate".into(),
        fps.to_string(),
        "-i".into(),
        frame_pattern,
    ];

    if let Some(audio) = &audio_path {
        args.push("-i".into());
        args.push(audio.clone());
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-shortest".into());
    }

    args.push("-c:v".into());
    args.push("libx264".into());
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    args.push("-preset".into());
    args.push("medium".into());
    args.push("-movflags".into());
    args.push("+faststart".into());
    args.push(output_path.clone());

    let sidecar = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("ffmpeg sidecar not found: {e}"))?;

    let (mut rx, _child) = sidecar
        .args(args)
        .spawn()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(line) => {
                // ffmpeg logs progress ("frame=  123 ...") to stderr.
                let text = String::from_utf8_lossy(&line);
                if let Some(frame_no) = parse_ffmpeg_frame(&text) {
                    let pct = (frame_no as f32 / total_frames.max(1) as f32 * 100.0).min(99.0);
                    emit("encoding", pct);
                }
            }
            CommandEvent::Terminated(payload) => {
                if payload.code != Some(0) {
                    return Err(format!("ffmpeg exited with code {:?}", payload.code));
                }
            }
            _ => {}
        }
    }

    emit("done", 100.0);
    Ok(output_path)
}

fn parse_ffmpeg_frame(line: &str) -> Option<u32> {
    // Matches ffmpeg's "frame=  123 fps=..." progress lines.
    let idx = line.find("frame=")?;
    let rest = &line[idx + 6..];
    let digits: String = rest.chars().skip_while(|c| c.is_whitespace()).take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u32>().ok()
}
