// Replaces performExportAndDownload / encodeWithWebCodecs / webmToMp4 /
// exportViaMediaRecorder from the original app. The canvas rendering per
// frame is unchanged (renderer.ts); what changes is where encoding happens:
// every frame is written to a temp dir as a PNG (fast, main-thread-cheap),
// then a single Tauri command hands the whole sequence + final mixed audio
// to a bundled ffmpeg process running outside the webview entirely.

import { invoke } from "@tauri-apps/api/tauri";
import { writeBinaryFile as writeFile, createDir as mkdir, removeFile as remove } from "@tauri-apps/api/fs";
import { listen } from "@tauri-apps/api/event";
import { appDataDir, join } from "@tauri-apps/api/path";
import type { TimelineConfig } from "./renderer";
import { segmentAt } from "./renderer";

export interface ExportProgressEvent {
  stage: string;
  percent: number;
}

export interface FrameRenderer {
  (ctx: CanvasRenderingContext2D, t: number, segInfo: ReturnType<typeof segmentAt>): void;
}

export async function exportVideo(opts: {
  cfg: TimelineConfig;
  fps: number;
  drawFrame: FrameRenderer;
  audioPath?: string;
  outputPath: string;
  onProgress?: (e: ExportProgressEvent) => void;
}): Promise<string> {
  const { cfg, fps, drawFrame, audioPath, outputPath, onProgress } = opts;

  const unlisten = onProgress
    ? await listen<ExportProgressEvent>("export-progress", (e) => onProgress(e.payload))
    : null;

  try {
    const framesDir = await join(await appDataDir(), "tmp", `export_${Date.now()}`);
    await mkdir(framesDir, { recursive: true });

    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 1920;
    const ctx = canvas.getContext("2d")!;

    const totalDur = totalDurationFromCfg(cfg);
    const totalFrames = Math.ceil(totalDur * fps);

    onProgress?.({ stage: "rendering-frames", percent: 0 });

    for (let f = 0; f < totalFrames; f++) {
      const t = f / fps;
      const segInfo = segmentAt(cfg, t);
      drawFrame(ctx, t, segInfo);

      const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), "image/png"));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const framePath = await join(framesDir, `frame_${String(f).padStart(5, "0")}.png`);
      await writeFile(framePath, bytes);

      if (f % 10 === 0) {
        onProgress?.({ stage: "rendering-frames", percent: (f / totalFrames) * 40 });
      }
    }

    onProgress?.({ stage: "encoding", percent: 40 });

    const result = await invoke<string>("render_export", {
      framesDir,
      fps,
      audioPath: audioPath ?? null,
      outputPath,
      totalFrames,
    });

    await remove(framesDir, { recursive: true }).catch(() => {});
    return result;
  } finally {
    unlisten?.();
  }
}

function totalDurationFromCfg(cfg: TimelineConfig): number {
  const perImage = cfg.showcaseDurPerImage.reduce((a, b) => a + (b ?? 2), 0);
  return cfg.hookDur + cfg.cardDur + perImage;
}
