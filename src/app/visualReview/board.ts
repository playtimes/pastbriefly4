import { framingTransform } from "../../render/framing.ts";
import type { PreviewFrame } from "../../types.ts";
import { fmtTime, slotLabel, type Film, type FilmReview } from "./model.ts";

// The Director board: every slot of one film in edit order, with deterministic
// attention flags that say where to look. Derived only from the preview frames;
// nothing here judges quality or writes production state.

export type AttentionFlag = "OPENING" | "ENDING" | "ADJACENT REUSE" | "CLOSE REUSE" | "ALTERNATING REUSE" | "HIGH REUSE" | "MOTION";

export const OPENING_SEC = 15;
export const ENDING_SEC = 10;
export const CLOSE_REUSE_SEC = 15;
export const HIGH_REUSE_USES = 3;

export const FLAG_LEGEND: [AttentionFlag, string][] = [
  ["OPENING", `overlaps the first ${OPENING_SEC} s`],
  ["ENDING", `overlaps the final ${ENDING_SEC} s`],
  ["ADJACENT REUSE", "same asset as the previous slot"],
  ["CLOSE REUSE", `same asset seen within the previous ${CLOSE_REUSE_SEC} s`],
  ["ALTERNATING REUSE", "part of an A-B-A-B run of two assets over four slots"],
  ["HIGH REUSE", `asset used in ${HIGH_REUSE_USES}+ slots`],
  ["MOTION", "motion selected"],
];

export const TRUTH_UPPER: Record<PreviewFrame["truth"], string> = { archive: "ARCHIVE", reconstruction: "RECONSTRUCTION", graphic: "GRAPHIC" };

export interface BoardCard {
  index: number; // position in the film's frames (for Sequence navigation)
  slot: string; // slot label, e.g. "04"
  frame: PreviewFrame;
  assetId: string;
  owner: boolean;
  ownerSlot: string; // the owning slot's label (same as slot for an owner)
  startSec?: number;
  endSec?: number;
  durationSec?: number;
  caption: string;
  flags: AttentionFlag[];
}

export interface DirectorBoard {
  film: Film;
  cards: BoardCard[];
  summary: { slots: number; durationSec: number; owners: number; archive: number; graphics: number; motion: number; attention: number };
}

const timed = (f: PreviewFrame): boolean => typeof f.startSec === "number" && typeof f.durationSec === "number";
const endOf = (f: PreviewFrame): number => f.startSec! + f.durationSec!;

// Attention flags per frame, in FLAG_LEGEND order. Time-based flags need slot
// timing; a frame without it only gets the reuse and motion flags.
export function sequenceAttentionFlags(fr: FilmReview): AttentionFlag[][] {
  const total = filmDuration(fr);
  const alternating = new Set(alternatingWindows(fr).flat());
  return fr.frames.map((f, i) => {
    const flags: AttentionFlag[] = [];
    if (timed(f) && f.startSec! < OPENING_SEC) flags.push("OPENING");
    if (timed(f) && total > 0 && endOf(f) > total - ENDING_SEC) flags.push("ENDING");
    const adjacent = i > 0 && fr.assetOf[i - 1] === fr.assetOf[i];
    if (adjacent) flags.push("ADJACENT REUSE");
    if (!adjacent && timed(f)) {
      // The most recent earlier slot showing the same asset.
      for (let j = i - 1; j >= 0; j--) {
        if (fr.assetOf[j] !== fr.assetOf[i]) continue;
        if (timed(fr.frames[j]) && f.startSec! - endOf(fr.frames[j]) < CLOSE_REUSE_SEC) flags.push("CLOSE REUSE");
        break;
      }
    }
    if (alternating.has(i)) flags.push("ALTERNATING REUSE");
    if ((fr.assets[fr.assetOf[i]]?.uses.length ?? 0) >= HIGH_REUSE_USES) flags.push("HIGH REUSE");
    if (f.motion) flags.push("MOTION");
    return flags;
  });
}

// Every A-B-A-B window of four consecutive frames: two different assets, each
// shown twice, alternating. Frame indexes, in order.
export function alternatingWindows(fr: FilmReview): number[][] {
  const a = fr.assetOf;
  const out: number[][] = [];
  for (let i = 0; i + 3 < a.length; i++) if (a[i] !== a[i + 1] && a[i] === a[i + 2] && a[i + 1] === a[i + 3]) out.push([i, i + 1, i + 2, i + 3]);
  return out;
}

// ---------------------------------------------------------------------------
// Mandatory sequence cleanup after Director QA: the repetition patterns PB4 can
// see in its own metadata and should not leave to a person. CLOSE REUSE and HIGH
// REUSE alone are not here: they can be editorially valid.

export type CleanupPattern = "ADJACENT REUSE" | "CONSECUTIVE REUSE" | "ALTERNATING REUSE" | "OPENING REPEAT";

export interface CleanupIssue {
  pattern: CleanupPattern;
  frames: number[]; // the frames that form the pattern, in order
  targets: number[]; // the frames chosen to change (empty: no member can change)
}

// Find every mandatory pattern and the smallest set of editable frames to change:
// - ADJACENT REUSE (two in a row): the later one;
// - CONSECUTIVE REUSE (three or more in a row): every second one after the first;
// - ALTERNATING REUSE (A-B-A-B): the latest member;
// - OPENING REPEAT (one asset twice inside the opening): each later occurrence.
// A frame that cannot change is swapped for the nearest editable member; a frame
// already chosen for another pattern is reused rather than adding another.
export function sequenceCleanup(fr: FilmReview, editable: (frame: number) => boolean): CleanupIssue[] {
  const a = fr.assetOf;
  const chosen = new Set<number>();
  const pick = (order: number[]) => {
    const already = order.find((i) => chosen.has(i));
    if (already !== undefined) return already;
    const i = order.find((j) => editable(j));
    if (i !== undefined) chosen.add(i);
    return i;
  };
  const issues: CleanupIssue[] = [];
  // Runs of one asset.
  for (let start = 0; start < a.length; ) {
    let end = start;
    while (end + 1 < a.length && a[end + 1] === a[start]) end++;
    if (end > start) {
      const frames = Array.from({ length: end - start + 1 }, (_, k) => start + k);
      const targets: number[] = [];
      for (let k = 1; k < frames.length; k += 2) {
        const t = pick([frames[k], frames[k + 1], frames[k - 1]].filter((i): i is number => i !== undefined && !targets.includes(i)));
        if (t !== undefined) targets.push(t);
      }
      issues.push({ pattern: frames.length === 2 ? "ADJACENT REUSE" : "CONSECUTIVE REUSE", frames, targets });
    }
    start = end + 1;
  }
  // A-B-A-B: one change breaks the window; a window already broken is skipped.
  for (const w of alternatingWindows(fr)) {
    if (w.some((i) => chosen.has(i))) continue;
    const t = pick([w[3], w[2], w[1], w[0]]);
    issues.push({ pattern: "ALTERNATING REUSE", frames: w, targets: t === undefined ? [] : [t] });
  }
  // One asset more than once inside the opening window: keep the first.
  const opening = fr.frames.map((_, i) => i).filter((i) => typeof fr.frames[i].startSec === "number" && fr.frames[i].startSec! < OPENING_SEC);
  const byAsset = new Map<number, number[]>();
  for (const i of opening) byAsset.set(a[i], [...(byAsset.get(a[i]) ?? []), i]);
  for (const frames of byAsset.values()) {
    if (frames.length < 2 || frames.every((i, k) => k === 0 || i === frames[k - 1] + 1)) continue; // a plain run is already handled above
    const targets: number[] = [];
    for (let k = frames.length - 1; k >= 1; k--) {
      const t = pick([frames[k], ...frames.slice(0, k).reverse()].filter((i) => !targets.includes(i)));
      if (t !== undefined) targets.push(t);
    }
    issues.push({ pattern: "OPENING REPEAT", frames, targets: targets.sort((x, y) => x - y) });
  }
  return issues;
}

export function filmDuration(fr: FilmReview): number {
  return fr.frames.reduce((m, f) => (timed(f) ? Math.max(m, endOf(f)) : m), 0);
}

export function buildDirectorBoard(fr: FilmReview): DirectorBoard {
  const flags = sequenceAttentionFlags(fr);
  const cards = fr.frames.map((f, i): BoardCard => {
    const asset = fr.assets[fr.assetOf[i]];
    return {
      index: i,
      slot: slotLabel(f, i),
      frame: f,
      assetId: asset?.id ?? f.asset ?? `Slot ${slotLabel(f, i)}`,
      owner: asset ? asset.owner === i : true,
      ownerSlot: asset ? slotLabel(fr.frames[asset.owner], asset.owner) : slotLabel(f, i),
      startSec: timed(f) ? f.startSec : undefined,
      endSec: timed(f) ? endOf(f) : undefined,
      durationSec: timed(f) ? f.durationSec : undefined,
      caption: f.caption ?? "",
      flags: flags[i],
    };
  });
  return {
    film: fr.film,
    cards,
    summary: {
      slots: cards.length,
      durationSec: filmDuration(fr),
      owners: fr.assets.length,
      archive: fr.assets.filter((a) => a.truth === "archive").length,
      graphics: fr.assets.filter((a) => a.truth === "graphic").length,
      motion: fr.frames.filter((f) => f.motion).length,
      attention: cards.filter((c) => c.flags.length > 0).length,
    },
  };
}

// The text a card carries, shared by the on-screen board and the PNG export.
export function cardTime(c: BoardCard): string {
  return typeof c.startSec === "number" ? `${fmtTime(c.startSec)} → ${fmtTime(c.endSec!)} · ${c.durationSec!.toFixed(1)}s` : "No timing";
}
export function cardUse(c: BoardCard): string {
  return c.owner ? "OWNER" : `REUSE OF ${c.assetId} · SLOT ${c.ownerSlot}`;
}
export const NO_CAPTION = "No on-screen caption";

export function summaryLines(board: DirectorBoard, storyTitle: string): string[] {
  const s = board.summary;
  return [
    `Story: ${storyTitle || "Untitled"}`,
    `Film: ${board.film === "long" ? "Long" : "Short"}   Slots: ${s.slots}   Duration: ${fmtTime(s.durationSec)}   Owners: ${s.owners}   Archive: ${s.archive}   Graphics: ${s.graphics}   Motion: ${s.motion}   Attention: ${s.attention}`,
  ];
}

// ---------------------------------------------------------------------------
// PNG contact sheet. A fixed width and column count per film, so the export never
// depends on the browser window.

export const EXPORT_WIDTH = 1600;
const PAD = 40;
const GAP = 20;
const HEADER_H = 190;
const TEXT_H = 132; // below each thumbnail: slot/time, asset, use, caption x2, flags

export interface BoardLayout {
  width: number;
  height: number;
  columns: number;
  cardW: number;
  thumbH: number;
  cards: { x: number; y: number }[];
}

export function boardLayout(board: DirectorBoard): BoardLayout {
  const long = board.film === "long";
  const columns = long ? 4 : 6;
  const cardW = Math.floor((EXPORT_WIDTH - PAD * 2 - GAP * (columns - 1)) / columns);
  const thumbH = Math.round(long ? (cardW * 9) / 16 : (cardW * 16) / 9);
  const rowH = thumbH + TEXT_H + GAP;
  const rows = Math.ceil(board.cards.length / columns);
  const cards = board.cards.map((_, i) => ({ x: PAD + (i % columns) * (cardW + GAP), y: PAD + HEADER_H + Math.floor(i / columns) * rowH }));
  return { width: EXPORT_WIDTH, height: PAD + HEADER_H + rows * rowH - GAP + PAD, columns, cardW, thumbH, cards };
}

// The subset of the 2D context the renderer uses, so tests can pass a recorder.
export type BoardCtx = Pick<CanvasRenderingContext2D, "fillStyle" | "strokeStyle" | "font" | "lineWidth" | "textBaseline" | "fillRect" | "strokeRect" | "fillText" | "measureText" | "drawImage">;
export interface BoardImage {
  width: number;
  height: number;
  source: CanvasImageSource;
}

const C = { bg: "#0e0a09", card: "#17110f", ink: "#f3ebde", muted: "#8f8579", dim: "#6f6459", line: "#2a211d", accent: "#e50914", flag: "#e3b8ab" };
const SANS = "system-ui, -apple-system, 'Segoe UI', sans-serif";

// Wrap text into at most maxLines lines, ellipsizing the last one.
export function wrapLines(ctx: Pick<BoardCtx, "measureText">, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    let line = words[i++];
    while (i < words.length && ctx.measureText(`${line} ${words[i]}`).width <= maxWidth) line += ` ${words[i++]}`;
    lines.push(line);
  }
  if (i < words.length) {
    let last = lines[lines.length - 1];
    while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last.trimEnd()}…`;
  }
  return lines;
}

// Draw the image as the slot shows it: cover-fit, then the slot's framing crop.
function drawThumb(ctx: BoardCtx, img: BoardImage, frame: PreviewFrame, x: number, y: number, w: number, h: number): void {
  const s = Math.max(w / img.width, h / img.height);
  const t = framingTransform(frame.framing);
  const k = t.scale;
  const bx = (t.originX / 100) * w * (1 - 1 / k);
  const by = (t.originY / 100) * h * (1 - 1 / k);
  const sx = (img.width - w / s) / 2 + bx / s;
  const sy = (img.height - h / s) / 2 + by / s;
  ctx.drawImage(img.source, sx, sy, w / s / k, h / s / k, x, y, w, h);
}

export function drawDirectorBoard(ctx: BoardCtx, board: DirectorBoard, storyTitle: string, layout: BoardLayout, images: (BoardImage | null)[]): void {
  ctx.textBaseline = "top";
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, layout.width, layout.height);

  // Header: title, story, counts and the legend.
  ctx.fillStyle = C.accent;
  ctx.font = `700 15px ${SANS}`;
  ctx.fillText("PASTBRIEFLY DIRECTOR VISUAL REVIEW", PAD, PAD);
  const [story, counts] = summaryLines(board, storyTitle);
  ctx.fillStyle = C.ink;
  ctx.font = `600 28px ${SANS}`;
  ctx.fillText(story, PAD, PAD + 30);
  ctx.font = `500 17px ${SANS}`;
  ctx.fillText(counts, PAD, PAD + 76);
  ctx.fillStyle = C.muted;
  ctx.font = `400 13px ${SANS}`;
  ctx.fillText("Attention flags mark where to look. They are not errors or verdicts.", PAD, PAD + 110);
  const legend = FLAG_LEGEND.map(([f, what]) => `${f}: ${what}`);
  ctx.fillText(legend.slice(0, 3).join("    "), PAD, PAD + 132);
  ctx.fillText(legend.slice(3).join("    "), PAD, PAD + 152);

  board.cards.forEach((c, i) => {
    const { x, y } = layout.cards[i];
    const w = layout.cardW;
    const img = images[i];
    ctx.fillStyle = C.card;
    ctx.fillRect(x, y, w, layout.thumbH);
    if (img) drawThumb(ctx, img, c.frame, x, y, w, layout.thumbH);
    else {
      ctx.fillStyle = C.dim;
      ctx.font = `400 13px ${SANS}`;
      ctx.fillText("Image unavailable", x + 12, y + 12);
    }
    ctx.strokeStyle = c.flags.length ? C.accent : C.line;
    ctx.lineWidth = c.flags.length ? 2 : 1;
    ctx.strokeRect(x, y, w, layout.thumbH);

    let ty = y + layout.thumbH + 8;
    ctx.fillStyle = C.ink;
    ctx.font = `700 14px ${SANS}`;
    ctx.fillText(`Slot ${c.slot}  ${cardTime(c)}`, x, ty);
    ty += 20;
    ctx.font = `600 13px ${SANS}`;
    ctx.fillText(`${c.assetId} · ${TRUTH_UPPER[c.frame.truth]}`, x, ty);
    ty += 18;
    ctx.fillStyle = C.muted;
    ctx.font = `500 12px ${SANS}`;
    ctx.fillText(cardUse(c), x, ty);
    ty += 18;
    ctx.font = `400 12px ${SANS}`;
    for (const line of wrapLines(ctx, c.caption || NO_CAPTION, w, 2)) {
      ctx.fillStyle = c.caption ? C.ink : C.dim;
      ctx.fillText(line, x, ty);
      ty += 16;
    }
    if (c.flags.length) {
      ctx.fillStyle = C.flag;
      ctx.font = `700 11px ${SANS}`;
      for (const line of wrapLines(ctx, c.flags.join(" · "), w, 2)) {
        ctx.fillText(line, x, ty + 4);
        ty += 15;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Browser export: the same board, drawn on a canvas from the existing media URLs.

export interface ExportDeps {
  loadImage: (url: string) => Promise<BoardImage | null>;
  canvas: (width: number, height: number) => { ctx: BoardCtx; toBlob: () => Promise<Blob> };
}

export const browserExportDeps: ExportDeps = {
  loadImage: (url) =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, source: img });
      img.onerror = () => resolve(null); // one missing still never sinks the board
      img.src = url;
    }),
  canvas: (width, height) => {
    const el = document.createElement("canvas");
    el.width = width;
    el.height = height;
    const ctx = el.getContext("2d");
    if (!ctx) throw new Error("This browser cannot draw the board.");
    return {
      ctx,
      toBlob: () => new Promise((resolve, reject) => el.toBlob((b) => (b ? resolve(b) : reject(new Error("The board image could not be encoded."))), "image/png")),
    };
  },
};

export async function renderDirectorBoardPng(board: DirectorBoard, storyTitle: string, imageUrl: (f: PreviewFrame) => string, deps: ExportDeps = browserExportDeps): Promise<Blob> {
  const layout = boardLayout(board);
  const images = await Promise.all(board.cards.map((c) => deps.loadImage(imageUrl(c.frame))));
  const { ctx, toBlob } = deps.canvas(layout.width, layout.height);
  drawDirectorBoard(ctx, board, storyTitle, layout, images);
  return toBlob();
}

// Write the PNG to the clipboard. The ClipboardItem is built at once from the
// pending image, so the click still counts as the user gesture. Resolves true
// only after the write succeeds; false when unsupported, refused or failed.
export async function copyBoardPng(
  png: Promise<Blob>,
  clipboard: Pick<Clipboard, "write"> | undefined = globalThis.navigator?.clipboard,
  Item: typeof ClipboardItem | undefined = globalThis.ClipboardItem,
): Promise<boolean> {
  try {
    if (!clipboard?.write || !Item) return false;
    await clipboard.write([new Item({ "image/png": png })]);
    return true;
  } catch {
    return false;
  }
}

export const boardFileName = (film: Film): string => `director-board-${film}.png`;

export type BoardCopy = { kind: "idle" } | { kind: "working" } | { kind: "copied" } | { kind: "fallback"; url: string } | { kind: "error"; message: string };

// One click: render the PNG and hand it to the clipboard in the same tick. If the
// clipboard refuses, offer the same PNG as a download instead of claiming success.
export async function startBoardCopy(
  board: DirectorBoard,
  storyTitle: string,
  imageUrl: (f: PreviewFrame) => string,
  opts: { deps?: ExportDeps; clipboard?: Pick<Clipboard, "write">; Item?: typeof ClipboardItem; objectUrl?: (b: Blob) => string } = {},
): Promise<BoardCopy> {
  const clipboard = "clipboard" in opts ? opts.clipboard : globalThis.navigator?.clipboard;
  const Item = "Item" in opts ? opts.Item : globalThis.ClipboardItem;
  const png = renderDirectorBoardPng(board, storyTitle, imageUrl, opts.deps);
  const copied = await copyBoardPng(png, clipboard, Item);
  if (copied) return { kind: "copied" };
  try {
    return { kind: "fallback", url: (opts.objectUrl ?? URL.createObjectURL)(await png) };
  } catch (e: any) {
    return { kind: "error", message: e?.message || "The board image could not be built." };
  }
}
