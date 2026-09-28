import type { PreviewFrame, VisualPreview } from "../../types.ts";

// The films' view model, derived only from the public preview frames (the engine
// uses buildFilm too). Nothing here writes production state: the film and the
// current slot are local UI state.

export type Film = "long" | "short";

// A generated owner still (never a reuse slot or an archive still) can be
// regenerated. Mirrors the backend rule; the server still refuses anything else.
export function canRegenerate(f: PreviewFrame): boolean {
  return f.edit === "new" && (f.truth === "reconstruction" || f.truth === "graphic") && typeof f.slot === "number" && f.path.includes("/images/");
}

export interface ReviewAsset {
  id: string; // the asset id, or a slot label for frames that carry none
  key: string;
  owner: number; // index of the owning frame in the film's frame list
  uses: number[]; // indexes of every frame that shows this asset, owner first
  truth: PreviewFrame["truth"];
  motion: boolean; // any use of the asset is selected for motion
}

export interface FilmReview {
  film: Film;
  frames: PreviewFrame[]; // in edit order
  assets: ReviewAsset[]; // unique owners, in order of first appearance
  assetOf: number[]; // frame index -> index into assets
}

export const pad2 = (n: number): string => String(n).padStart(2, "0");

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

export const slotNumber = (f: PreviewFrame, i: number): number => (typeof f.slot === "number" ? f.slot : i);
export const slotLabel = (f: PreviewFrame, i: number): string => pad2(slotNumber(f, i));

const assetKey = (f: PreviewFrame): string => f.asset ?? f.path;

export function buildFilm(preview: VisualPreview, film: Film): FilmReview {
  const frames = preview.frames.filter((f) => (f.kind ?? "long") === film);
  const byKey = new Map<string, ReviewAsset>();
  const assets: ReviewAsset[] = [];
  frames.forEach((f, i) => {
    const key = assetKey(f);
    let a = byKey.get(key);
    if (!a) {
      a = { id: f.asset ?? `Slot ${slotLabel(f, i)}`, key, owner: i, uses: [], truth: f.truth, motion: false };
      byKey.set(key, a);
      assets.push(a);
    }
    // The slot that acquired the asset owns it, even if a reuse is listed first.
    if (f.edit === "new" && frames[a.owner].edit !== "new") {
      a.owner = i;
      a.truth = f.truth;
    }
    a.uses.push(i);
    if (f.motion) a.motion = true;
  });
  for (const a of assets) a.uses.sort((x, y) => (x === a.owner ? -1 : y === a.owner ? 1 : x - y));
  assets.sort((x, y) => x.owner - y.owner);
  const assetOf = frames.map((f) => assets.findIndex((a) => a.key === assetKey(f)));
  return { film, frames, assets, assetOf };
}

// ---------------------------------------------------------------------------
// Local navigation state for the film view: which film, and which slot in it.

export interface ReviewState {
  film: Film;
  index: Record<Film, number>; // current frame per film
}

export type ReviewAction = { type: "film"; film: Film } | { type: "slot"; index: number };

export function initialReview(preview: VisualPreview): ReviewState {
  const film: Film = preview.frames.some((f) => (f.kind ?? "long") === "long") || preview.frames.length === 0 ? "long" : "short";
  return { film, index: { long: 0, short: 0 } };
}

export function reviewReducer(s: ReviewState, a: ReviewAction): ReviewState {
  return a.type === "film" ? { ...s, film: a.film } : { ...s, index: { ...s.index, [s.film]: a.index } };
}

// Previous/Next (and the arrow keys): the neighbouring slot, or null at an end.
export function stepAction(s: ReviewState, fr: FilmReview, dir: 1 | -1): ReviewAction | null {
  const i = s.index[s.film] + dir;
  return i >= 0 && i < fr.frames.length ? { type: "slot", index: i } : null;
}

// The frame key the regenerate endpoint and the Creating screen use.
export const regenKey = (f: PreviewFrame): string => `${f.kind}-${f.slot}`;
