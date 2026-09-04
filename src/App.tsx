import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore, fieldAction } from "./store/appStore";
import { drawCard, drawShowcase, drawHookFlash, CANVAS_W, CANVAS_H, type ImageAsset } from "./engine/renderer";
import { open } from "@tauri-apps/plugin-dialog";
import { importLegacyZip } from "./migration/importLegacy";

/**
 * Editor shell — phase 3 of MIGRATION.md. Demonstrates the full new stack
 * wired together (Zustand store + action-log undo/redo + ported canvas
 * renderer). Image tray upload, per-word card positioning UI, batch grid,
 * voice control, and export wiring are the remaining phases; this proves the
 * foundation they all build on works end-to-end.
 */
export function App() {
  const project = useAppStore((s) => s.project);
  const dispatch = useAppStore((s) => s.dispatch);
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const history = useAppStore((s) => s.history);
  const future = useAppStore((s) => s.future);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [previewT, setPreviewT] = useState(0);
  const [importStatus, setImportStatus] = useState<string | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Placeholder demo frame until the image tray (phase 3 remainder) is wired
    // to real uploaded assets — this proves drawCard renders correctly with
    // live store state (color, position, font size) via the ported engine.
    drawCard(ctx, "Save this before you buy another gadget", previewT, project.cardDur, project.cardStyle);
  }, [previewT, project]);

  useEffect(() => {
    draw();
  }, [draw]);

  const bumpFontSize = (delta: number) => {
    dispatch(
      fieldAction("Card font size", "cardStyle", {
        ...project.cardStyle,
        fontSize: Math.max(24, project.cardStyle.fontSize + delta),
      })
    );
  };

  const handleImportLegacy = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Backup zip", extensions: ["zip"] }],
    });
    if (!picked || Array.isArray(picked)) return;
    setImportStatus("Importing…");
    try {
      const { imported } = await importLegacyZip(picked);
      setImportStatus(`Imported ${imported} items from legacy backup.`);
    } catch (e) {
      setImportStatus(`Import failed: ${(e as Error).message}`);
    }
  };

  return (
    <div style={{ display: "flex", height: "100vh", background: "#050806", color: "#f2f0e6", fontFamily: "monospace" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: 24, gap: 16 }}>
        <div style={{ width: 340, aspectRatio: `${CANVAS_W}/${CANVAS_H}`, background: "#000" }}>
          <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} style={{ width: "100%", height: "100%" }} />
        </div>
        <input
          type="range"
          min={0}
          max={project.cardDur}
          step={0.01}
          value={previewT}
          onChange={(e) => setPreviewT(parseFloat(e.target.value))}
          style={{ width: 340 }}
        />
      </div>

      <div style={{ width: 360, borderLeft: "1px solid rgba(242,240,230,0.14)", padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: "0.1em", opacity: 0.6, marginBottom: 8 }}>CARD FONT SIZE</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={() => bumpFontSize(-4)}>−</button>
            <span>{project.cardStyle.fontSize}</span>
            <button onClick={() => bumpFontSize(4)}>+</button>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, letterSpacing: "0.1em", opacity: 0.6, marginBottom: 8 }}>HISTORY</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={history.length === 0} onClick={() => undo()}>
              ↶ Undo ({history.length})
            </button>
            <button disabled={future.length === 0} onClick={() => redo()}>
              ↷ Redo ({future.length})
            </button>
          </div>
        </div>

        <div style={{ borderTop: "1px solid rgba(242,240,230,0.14)", paddingTop: 16 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.1em", opacity: 0.6, marginBottom: 8 }}>
            IMPORT FROM OLD APP
          </div>
          <div style={{ fontSize: 10, opacity: 0.5, lineHeight: 1.5, marginBottom: 8 }}>
            Point this at the "Backup all data" zip (or a zipped set of the manual
            dump_*.json recovery files) from the original browser-based app.
          </div>
          <button onClick={handleImportLegacy}>⬆ Import legacy backup.zip</button>
          {importStatus && <div style={{ fontSize: 10, marginTop: 8, color: "#1fae66" }}>{importStatus}</div>}
        </div>
      </div>
    </div>
  );
}
