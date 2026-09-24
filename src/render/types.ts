// The render vocabulary. Small on purpose: this is the hand-off from the
// production pipeline (node) to the Remotion composition (browser), not a DSL.

export type Truth = "archive" | "reconstruction" | "graphic";
export type Motion = "hold" | "push" | "pan-left" | "pan-right";

// How an edit slot presents its still: a clean full-frame crop (wide), a modest
// push (medium), or a stronger crop toward one region of the image (detail-*).
export type Framing = "wide" | "medium" | "detail-left" | "detail-center" | "detail-right";

export interface Caption {
  kicker?: string;
  text: string;
  emphasis?: string;
  // "opener" gets the strong PB1 title treatment; "moment" is the calmer
  // documentary caption used after the opening. Defaults to "moment".
  variant?: "opener" | "moment";
}

export interface Shot {
  id: string;
  startFrame: number;
  endFrame: number;
  mediaType: "image" | "video";
  path: string; // staticFile name, staged into the render's public dir
  truth: Truth;
  motion?: Motion;
  framing?: Framing;
  caption?: Caption;
  source?: string;
}

export interface SubtitleCue {
  startFrame: number;
  endFrame: number;
  text: string;
}

// A type alias (not an interface) so it satisfies Remotion's props constraint
// `Props extends Record<string, unknown>`.
export type RenderPlan = {
  kind: "long" | "short";
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  audio: string; // staticFile name
  audioEndFrame: number;
  accent: string;
  title: string;
  year: string;
  place: string;
  shots: Shot[];
  subtitles: SubtitleCue[];
};
