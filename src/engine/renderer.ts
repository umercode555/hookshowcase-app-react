// Direct, pixel-faithful port of the original app's drawing functions
// (coverDraw / drawWordByWord / drawCard / drawShowcase / drawOneLine /
// wrapTextAligned / drawHookFlash / renderAt — see repo's
// `hook_showcase (2).html` lines ~4938-5100).
//
// Deliberately kept as plain functions operating on a CanvasRenderingContext2D,
// not React state — this is exactly the module a future Web Worker /
// OffscreenCanvas frame-export pass reuses without any UI dependency, and the
// thing export.ts calls once per frame when writing the PNG sequence for the
// Rust/ffmpeg encoder.

export const CANVAS_W = 1080;
export const CANVAS_H = 1920;
export const SIZE_SCALE = 1; // kept as a named constant, same role as the original global

export type Align = "left" | "center" | "right";

export interface TextPos {
  xNorm: number;
  yNorm: number;
  align?: Align;
}

export interface ImageAsset {
  img: CanvasImageSource;
  width: number;
  height: number;
}

export interface CardStyle {
  mode: "color" | "image";
  bgImage?: ImageAsset | null;
  fillColor: string; // resolved rgba(...) or hex, already alpha-applied
  textColor: string;
  textPos: TextPos;
  wordPos?: Record<number, TextPos>;
  wordColors?: Record<number, string>;
  fontSize: number;
}

export interface ShowcaseStyle {
  capPos: TextPos;
  wordByWord: boolean;
  fontSize: number;
  textColor: string;
}

export interface HookStyle {
  capPos: TextPos;
  wordByWord: boolean;
  fontSize: number;
}

/** Cover-fit an image/video frame into a rect, cropping to fill (matches old coverDraw). */
export function coverDraw(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  naturalW: number,
  naturalH: number,
  x: number,
  y: number,
  w: number,
  h: number
) {
  const ir = naturalW / naturalH;
  const r = w / h;
  let sx: number, sy: number, sw: number, sh: number;
  if (ir > r) {
    sh = naturalH;
    sw = sh * r;
    sx = (naturalW - sw) / 2;
    sy = 0;
  } else {
    sw = naturalW;
    sh = sw / r;
    sx = 0;
    sy = (naturalH - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

/** Returns which word index is "active" at localT within a dur-second reveal window. */
export function wordIndexAt(text: string, localT: number, dur: number): number {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const per = dur / words.length;
  return Math.max(0, Math.min(words.length - 1, Math.floor(localT / per)));
}

export function drawWordByWord(
  ctx: CanvasRenderingContext2D,
  text: string,
  localT: number,
  dur: number,
  fontSize: number,
  x: number,
  y: number,
  align: Align,
  fillColor: string = "#ffffff"
) {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const wIdx = wordIndexAt(text, localT, dur);
  const word = words[wIdx];

  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  let fs = fontSize;
  ctx.font = `800 ${fs}px 'League Spartan', Archivo, Arial, sans-serif`;
  while (ctx.measureText(word).width > CANVAS_W * 0.86 && fs > 24) {
    fs -= 4;
    ctx.font = `800 ${fs}px 'League Spartan', Archivo, Arial, sans-serif`;
  }
  ctx.fillStyle = fillColor;
  let xx = x;
  if (align === "left") xx = Math.max(48, x);
  if (align === "right") xx = Math.min(CANVAS_W - 48, x);
  ctx.fillText(word, xx, y);
  return { words, wIdx, fontSizeUsed: fs };
}

export function drawOneLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  fontSize: number,
  align: Align,
  fillColor: string = "#ffffff"
) {
  let fs = fontSize;
  ctx.font = `800 ${fs}px 'League Spartan', Archivo, Arial, sans-serif`;
  while (ctx.measureText(text).width > maxWidth && fs > 18) {
    fs -= 2;
    ctx.font = `800 ${fs}px 'League Spartan', Archivo, Arial, sans-serif`;
  }
  ctx.fillStyle = fillColor;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

function legibilityBand(ctx: CanvasRenderingContext2D, y: number, bandH: number, peakAlpha: number) {
  const grad = ctx.createLinearGradient(0, y - bandH, 0, y + bandH);
  grad.addColorStop(0, "rgba(5,8,6,0)");
  grad.addColorStop(0.5, `rgba(5,8,6,${peakAlpha})`);
  grad.addColorStop(1, "rgba(5,8,6,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, Math.max(0, y - bandH), CANVAS_W, bandH * 2);
}

/** The "card" segment: solid/image background + one word revealed at a time. */
export function drawCard(
  ctx: CanvasRenderingContext2D,
  text: string,
  localT: number,
  dur: number,
  style: CardStyle
) {
  if (style.mode === "image" && style.bgImage) {
    ctx.fillStyle = "#050806";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    coverDraw(ctx, style.bgImage.img, style.bgImage.width, style.bgImage.height, 0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = style.fillColor; // semi-transparent tint over the image
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  } else {
    ctx.fillStyle = style.fillColor;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }

  const wIdx = wordIndexAt(text, localT, dur);
  const pos = style.wordPos?.[wIdx] ?? style.textPos;
  const cx = pos.xNorm * CANVAS_W;
  const cy = pos.yNorm * CANVAS_H;
  const color = style.wordColors?.[wIdx] ?? style.textColor;
  drawWordByWord(ctx, text, localT, dur, style.fontSize * SIZE_SCALE, cx, cy, "center", color);
}

/** The "showcase" segment: full-bleed product image + caption. */
export function drawShowcase(
  ctx: CanvasRenderingContext2D,
  image: ImageAsset,
  caption: string | undefined,
  dur: number,
  localT: number,
  style: ShowcaseStyle
) {
  ctx.fillStyle = "#050806";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  coverDraw(ctx, image.img, image.width, image.height, 0, 0, CANVAS_W, CANVAS_H);

  if (!caption) return;

  const pos = style.capPos;
  const x = pos.xNorm * CANVAS_W;
  const y = pos.yNorm * CANVAS_H;
  const align = pos.align ?? "center";

  legibilityBand(ctx, y, 380, 0.78);

  if (style.wordByWord) {
    drawWordByWord(ctx, caption, localT || 0, dur, style.fontSize * SIZE_SCALE, x, y, align, style.textColor);
  } else {
    let xClamped = x;
    if (align === "left") xClamped = Math.max(48, x);
    if (align === "right") xClamped = Math.min(CANVAS_W - 48, x);
    drawOneLine(ctx, caption, xClamped, y, CANVAS_W * 0.86, style.fontSize * SIZE_SCALE, align, style.textColor);
  }
}

/** The opening "hook flash" segment. */
export function drawHookFlash(
  ctx: CanvasRenderingContext2D,
  image: ImageAsset,
  caption: string | undefined,
  localT: number,
  dur: number,
  style: HookStyle
) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  coverDraw(ctx, image.img, image.width, image.height, 0, 0, CANVAS_W, CANVAS_H);

  if (!caption) return;

  const x = style.capPos.xNorm * CANVAS_W;
  const y = style.capPos.yNorm * CANVAS_H;
  const align = style.capPos.align ?? "center";

  legibilityBand(ctx, y, 220, 0.7);

  let xClamped = x;
  if (align === "left") xClamped = Math.max(48, x);
  if (align === "right") xClamped = Math.min(CANVAS_W - 48, x);

  if (style.wordByWord) {
    drawWordByWord(ctx, caption, localT || 0, dur, style.fontSize * SIZE_SCALE, xClamped, y, align);
  } else {
    drawOneLine(ctx, caption, xClamped, y, CANVAS_W * 0.86, style.fontSize * SIZE_SCALE, align);
  }
}

// ---------- timeline ----------

export type SegmentType = "hook" | "card" | "showcase";

export interface Segment {
  type: SegmentType;
  start: number;
  dur: number;
  imageIdx?: number; // for hook/showcase
  captionIdx?: number;
}

export interface TimelineConfig {
  hookDur: number;
  cardDur: number;
  showcaseDurPerImage: number[]; // per-image override, falls back to a default
  imageCount: number;
}

/** Builds the flat segment list: [hook, card, showcase x N] — same order as the original app. */
export function getSegments(cfg: TimelineConfig): Segment[] {
  const segs: Segment[] = [];
  let t = 0;
  segs.push({ type: "hook", start: t, dur: cfg.hookDur, imageIdx: 0 });
  t += cfg.hookDur;
  segs.push({ type: "card", start: t, dur: cfg.cardDur });
  t += cfg.cardDur;
  for (let i = 0; i < cfg.imageCount; i++) {
    const d = cfg.showcaseDurPerImage[i] ?? 2;
    segs.push({ type: "showcase", start: t, dur: d, imageIdx: i, captionIdx: i });
    t += d;
  }
  return segs;
}

export function totalDuration(cfg: TimelineConfig): number {
  const segs = getSegments(cfg);
  const last = segs[segs.length - 1];
  return last ? last.start + last.dur : 0;
}

/** Given absolute time t, returns the active segment and time local to it. */
export function segmentAt(cfg: TimelineConfig, t: number): { seg: Segment; localT: number } | null {
  const segs = getSegments(cfg);
  let acc = 0;
  for (const s of segs) {
    if (t < acc + s.dur || s === segs[segs.length - 1]) {
      return { seg: s, localT: t - acc };
    }
    acc += s.dur;
  }
  return null;
}
