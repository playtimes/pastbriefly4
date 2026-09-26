import type { PreviewFrame, VisualPreview } from "../../types.ts";

// The visual review's view model, derived only from the public preview frames.
// Nothing here writes production state: film, mode, filter, the current slot and
// the visited set are local UI state, and every count is derived from the frames.

export type Film = "long" | "short";
export type Mode = "sequence" | "assets";
export type Filter = "all" | "owners" | "motion" | "archive" | "graphics";

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
  metrics: { assets: number; reuses: number; archive: number; motion: number };
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
  return {
    film,
    frames,
    assets,
    assetOf,
    metrics: {
      assets: assets.length,
      reuses: frames.length - assets.length,
      archive: assets.filter((a) => a.truth === "archive").length,
      motion: frames.filter((f) => f.motion).length,
    },
  };
}

export const isOwnerFrame = (fr: FilmReview, i: number): boolean => fr.assets[fr.assetOf[i]]?.owner === i;
export const assetOfFrame = (fr: FilmReview, i: number): ReviewAsset | undefined => fr.assets[fr.assetOf[i]];

export const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "owners", label: "Owners" },
  { key: "motion", label: "Motion" },
  { key: "archive", label: "Archive" },
  { key: "graphics", label: "Graphics" },
];

export function matchesFilter(fr: FilmReview, i: number, filter: Filter): boolean {
  const f = fr.frames[i];
  switch (filter) {
    case "owners":
      return isOwnerFrame(fr, i);
    case "motion":
      return f.motion;
    case "archive":
      return f.truth === "archive";
    case "graphics":
      return f.truth === "graphic";
    default:
      return true;
  }
}

export function matchingSlots(fr: FilmReview, filter: Filter): number[] {
  return fr.frames.map((_, i) => i).filter((i) => matchesFilter(fr, i, filter));
}

// ---------------------------------------------------------------------------
// Local navigation state

export interface ReviewState {
  film: Film;
  mode: Mode;
  filter: Filter;
  index: Record<Film, number>; // current frame per film
  asset: Record<Film, string | null>; // open asset key per film (Assets mode)
  visited: Record<Film, number[]>; // frames the user has actually looked at
}

export type ReviewAction =
  | { type: "film"; film: Film }
  | { type: "mode"; mode: Mode }
  | { type: "filter"; filter: Filter }
  | { type: "slot"; index: number } // opens the slot in Sequence
  | { type: "asset"; key: string | null } // opens the asset (null: back to the grid)
  | { type: "markAll"; count: number };

export function initialReview(preview: VisualPreview): ReviewState {
  const film: Film = preview.frames.some((f) => (f.kind ?? "long") === "long") || preview.frames.length === 0 ? "long" : "short";
  return {
    film,
    mode: "sequence",
    filter: "all",
    index: { long: 0, short: 0 },
    asset: { long: null, short: null },
    visited: { long: film === "long" ? [0] : [], short: film === "short" ? [0] : [] },
  };
}

const visit = (list: number[], i: number): number[] => (list.includes(i) ? list : [...list, i]);
// The slot on screen in Sequence counts as visited.
const seeCurrent = (s: ReviewState): ReviewState =>
  s.mode === "sequence" ? { ...s, visited: { ...s.visited, [s.film]: visit(s.visited[s.film], s.index[s.film]) } } : s;

export function reviewReducer(s: ReviewState, a: ReviewAction): ReviewState {
  switch (a.type) {
    case "film":
      return seeCurrent({ ...s, film: a.film, filter: "all" });
    case "mode":
      return seeCurrent({ ...s, mode: a.mode });
    case "filter":
      return { ...s, filter: a.filter };
    case "slot":
      return { ...s, mode: "sequence", index: { ...s.index, [s.film]: a.index }, visited: { ...s.visited, [s.film]: visit(s.visited[s.film], a.index) } };
    case "asset":
      return { ...s, mode: "assets", asset: { ...s.asset, [s.film]: a.key } };
    case "markAll":
      return { ...s, visited: { ...s.visited, [s.film]: Array.from({ length: a.count }, (_, i) => i) } };
  }
}

// The action Previous/Next (and the arrow keys) take: the next slot matching the
// active filter in Sequence, the neighbouring asset in the asset inspector.
export function stepAction(s: ReviewState, fr: FilmReview, dir: 1 | -1): ReviewAction | null {
  if (s.mode === "sequence") {
    for (let i = s.index[s.film] + dir; i >= 0 && i < fr.frames.length; i += dir) {
      if (matchesFilter(fr, i, s.filter)) return { type: "slot", index: i };
    }
    return null;
  }
  const open = s.asset[s.film];
  if (open === null) return null;
  const j = fr.assets.findIndex((a) => a.key === open) + dir;
  return j >= 0 && j < fr.assets.length ? { type: "asset", key: fr.assets[j].key } : null;
}

// The frame key the regenerate endpoint and the Creating screen use.
export const regenKey = (f: PreviewFrame): string => `${f.kind}-${f.slot}`;
