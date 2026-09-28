import type { PreviewFrame } from "../../types.ts";
import { slotLabel, type Film, type FilmReview } from "./model.ts";

// Deterministic sequence patterns PB4's engine reads in its own edit: the
// attention flags and the mandatory cleanup after Director QA, and the per-slot
// board they are summarized on. Derived only from the preview frames; nothing
// here judges quality or writes production state. There is no user-facing board.

export type AttentionFlag = "OPENING" | "ENDING" | "ADJACENT REUSE" | "CLOSE REUSE" | "ALTERNATING REUSE" | "HIGH REUSE" | "MOTION";

export const OPENING_SEC = 15;
export const ENDING_SEC = 10;
export const CLOSE_REUSE_SEC = 15;
export const HIGH_REUSE_USES = 3;

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

// Attention flags per frame, in the order the AttentionFlag type lists them.
// Time-based flags need slot timing; a frame without it only gets the reuse and
// motion flags.
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
