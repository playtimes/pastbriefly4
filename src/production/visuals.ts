import { existsSync } from "node:fs";
import { config } from "../server/config.ts";
import type { Story, Category, VisualPreview, PreviewFrame } from "../types.ts";
import type { RenderPlan, Shot, Truth, Motion, Caption } from "../render/types.ts";
import type { StoryWorld } from "./pipelineTypes.ts";
import type { Narration } from "./narration.ts";
import { PRICING, round } from "../server/pricing.ts";
import { groupSentences } from "./text.ts";
import { buildCues } from "./subtitles.ts";
import { inStory, mediaRel } from "./paths.ts";
import { writePlaceholderStill, referenceFrame } from "./mockAssets.ts";
import { copyFileSync } from "node:fs";
import { generateImageFile } from "../providers/openai.ts";
import { generateMotion } from "../providers/higgsfield.ts";
import { fetchArchive } from "./wikimedia.ts";

export const FPS = 30;

const ACCENTS: Record<Category, string> = {
  "Conflicts & Standoffs": "#d9a066",
  "Money & Deception": "#cda24e",
  Disasters: "#c76b4a",
  "Escapes & Operations": "#5c6b3c", // PB1's Operation Paul Bunyan olive

  "Strange Everyday History": "#b98a5e",
};

export function accentFor(category: Category): string {
  return ACCENTS[category] ?? "#d9a066";
}

// One planned shot, kept plain so it can live in the job scratch and survive a
// restart. `path` (still) and `motionPath` (clip) are filled during acquisition.
export interface PlannedShot {
  index: number;
  truth: Truth;
  motion: Motion;
  wantsMotion: boolean;
  prompt: string;
  archiveQuery?: string;
  caption?: Caption;
  source?: string;
  wordStart: number;
  wordEnd: number;
  path?: string;
  mediaType?: "image" | "video";
  motionPath?: string;
}

function targetShots(kind: "long" | "short", durationSec: number): number {
  return kind === "long" ? clamp(Math.round(durationSec / 11), 12, 26) : clamp(Math.round(durationSec / 5), 8, 12);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Decide what the viewer should see across the narration, tied to the words so
// visuals land with the story. Sparse editorial captions; a mix of media.
export function planShots(kind: "long" | "short", script: string, story: Story, world: StoryWorld, narration: Narration): PlannedShot[] {
  const count = targetShots(kind, narration.durationSec);
  const groups = groupSentences(script, count);
  const archiveEvery = kind === "long" ? 5 : 9; // a few archive candidates
  const graphicEvery = kind === "long" ? 6 : 7;

  // Which groups carry a story-moment caption (spread across the film).
  const momentAt = new Map<number, number>();
  story.moments.forEach((_, m) => {
    const g = Math.min(groups.length - 1, Math.round(((m + 0.7) / story.moments.length) * (groups.length - 1)));
    if (!momentAt.has(g)) momentAt.set(g, m);
  });

  return groups.map((group, i): PlannedShot => {
    let truth: Truth = "reconstruction";
    if (i > 0 && i % graphicEvery === 0) truth = "graphic";
    else if (i > 0 && i % archiveEvery === 0) truth = "archive";

    const wantsMotion = truth === "reconstruction" && i % 3 === 1;
    const motion: Motion = truth === "graphic" ? "hold" : wantsMotion ? pickMotion(i) : i % 4 === 0 ? "push" : "hold";

    let caption: Caption | undefined;
    if (i === 0) caption = { kicker: story.year, text: story.title, emphasis: kind === "short" ? story.place : undefined, variant: "opener" };
    else if (momentAt.has(i)) {
      const m = story.moments[momentAt.get(i)!];
      caption = { kicker: story.place, text: m.title, variant: "moment" };
    }

    return {
      index: i,
      truth,
      motion,
      wantsMotion,
      prompt: reconstructionPrompt(kind, world, group.text),
      archiveQuery: truth === "archive" ? `${story.place} ${story.year} ${story.title}`.trim() : undefined,
      caption,
      source: undefined,
      wordStart: group.wordStart,
      wordEnd: group.wordEnd,
    };
  });
}

function pickMotion(i: number): Motion {
  return (["push", "pan-left", "pan-right"] as Motion[])[i % 3];
}

function reconstructionPrompt(kind: "long" | "short", world: StoryWorld, text: string): string {
  const frame = kind === "short" ? "vertical 9:16 composition" : "wide 16:9 composition";
  return `${world.visualDirection} Scene: ${text.slice(0, 160)} Palette: ${world.palette}. Cinematic editorial historical reconstruction, ${frame}, strong subject separation, premium material rendering, not glossy or plastic.`;
}

// Resolve one shot's still. Live: OpenAI image (archive tried first for archive
// shots). Mock: a labelled placeholder. Falls back to reconstruction if archive
// is unavailable so a reconstruction never masquerades as archive.
export async function acquireStill(story: Story, kind: "long" | "short", shot: PlannedShot, masterRef: string | null): Promise<void> {
  const rel = `images/${kind}-${String(shot.index).padStart(2, "0")}.png`;
  const abs = inStory(story.slug, rel);
  const size = kind === "short" ? { w: 1080, h: 1920, oa: "1024x1536" } : { w: 1920, h: 1080, oa: "1536x1024" };

  if (shot.truth === "archive") {
    if (config.mode === "live" && shot.archiveQuery) {
      const archiveRel = `archive/${kind}-${String(shot.index).padStart(2, "0")}.jpg`;
      const got = await fetchArchive(shot.archiveQuery, inStory(story.slug, archiveRel)).catch(() => null);
      if (got) {
        shot.path = archiveRel;
        shot.mediaType = "image";
        shot.source = got.credit;
        shot.wantsMotion = false;
        return;
      }
    }
    shot.truth = "reconstruction"; // no usable archive - do not fake it
  }

  if (existsSync(abs)) {
    shot.path = rel;
    shot.mediaType = "image";
    return;
  }

  if (config.mode === "live") {
    const refs = masterRef && existsSync(inStory(story.slug, masterRef)) ? [inStory(story.slug, masterRef)] : undefined;
    await generateImageFile({ prompt: shot.prompt, size: size.oa, outPath: abs, referencePaths: refs });
  } else {
    const ref = referenceFrame(inStory(story.slug, "refs"), shot.index);
    if (ref) {
      copyFileSync(ref, abs);
    } else {
      const label = shot.caption?.text ?? story.title;
      writePlaceholderStill(abs, { width: size.w, height: size.h, index: shot.index, label, truth: shot.truth, accent: accentFor(story.category) });
    }
  }
  shot.path = rel;
  shot.mediaType = "image";
}

// Generate the master/hero reconstruction used as a continuity reference (live).
export async function ensureMaster(story: Story, world: StoryWorld): Promise<string> {
  const rel = "images/hero.png";
  const abs = inStory(story.slug, rel);
  if (config.mode === "live") {
    const prompt = `${world.visualDirection} A defining establishing reconstruction of ${story.title}. Palette: ${world.palette}. Cinematic editorial, premium, wide 16:9.`;
    await generateImageFile({ prompt, size: "1536x1024", outPath: abs });
  } else if (!existsSync(abs)) {
    writePlaceholderStill(abs, { width: 1600, height: 900, index: 0, label: story.title, truth: "reconstruction", accent: accentFor(story.category) });
  }
  return rel;
}

// Live only: turn a still into motion (after the visual preview is approved).
export async function acquireMotion(story: Story, kind: "long" | "short", shot: PlannedShot): Promise<void> {
  if (config.mode !== "live" || !shot.path) return; // mock keeps the transform motion
  if (!config.higgsfield.publicAssetBase) throw new Error("HIGGSFIELD_PUBLIC_ASSET_BASE not set - cannot give Higgsfield a reachable still URL.");
  const rel = `motion/${kind}-${String(shot.index).padStart(2, "0")}.mp4`;
  const imageUrl = `${config.higgsfield.publicAssetBase.replace(/\/$/, "")}/${mediaRel(story.slug, shot.path)}`;
  await generateMotion({ prompt: shot.prompt, imageUrl, outPath: inStory(story.slug, rel) });
  shot.motionPath = rel;
  shot.mediaType = "video";
}

export function buildPreview(story: Story, longShots: PlannedShot[], shortShots: PlannedShot[]): VisualPreview {
  const all = [...longShots, ...shortShots];
  const archive = all.filter((s) => s.truth === "archive").length;
  const reconstruction = all.filter((s) => s.truth !== "archive").length;
  const motionSelected = all.filter((s) => s.wantsMotion).length;
  const frames: PreviewFrame[] = longShots
    .filter((s) => s.path)
    .map((s) => ({
      path: mediaRel(story.slug, s.path!),
      truth: s.truth,
      motion: s.wantsMotion,
      caption: s.caption?.text ?? "",
    }));
  return {
    moments: all.length,
    archive,
    reconstruction,
    motionSelected,
    remainingMotionCost: config.mode === "live" ? round(motionSelected * PRICING.higgsfield.video) : 0,
    frames,
  };
}

// Lay the resolved shots across the narration timeline and attach subtitles.
export function buildRenderPlan(kind: "long" | "short", story: Story, shots: PlannedShot[], narration: Narration, accent: string): RenderPlan {
  const width = kind === "short" ? 1080 : 1920;
  const height = kind === "short" ? 1920 : 1080;
  const audioEndFrame = Math.max(1, Math.ceil(narration.durationSec * FPS));
  const durationInFrames = audioEndFrame + Math.round(0.5 * FPS);
  const words = narration.words;
  const frameAt = (i: number) => (words[i] ? Math.round(words[i].start * FPS) : audioEndFrame);

  const ordered = [...shots].sort((a, b) => a.index - b.index);
  const base: Shot[] = ordered.map((s, i) => {
    const start = i === 0 ? 0 : frameAt(s.wordStart);
    const end = i === ordered.length - 1 ? durationInFrames : frameAt(ordered[i + 1].wordStart);
    return {
      id: `${kind}-${String(s.index).padStart(2, "0")}`,
      startFrame: start,
      endFrame: Math.max(start + 1, end),
      mediaType: s.motionPath ? "video" : "image",
      path: s.motionPath ?? s.path ?? "",
      truth: s.truth,
      motion: s.motion,
      caption: s.caption,
      source: s.source,
    };
  });

  // Never sit on one still too long: re-cut any over-long hold into sub-shots.
  const MAX_HOLD = Math.round(13 * FPS);
  const renderShots: Shot[] = base.flatMap((shot) => {
    const len = shot.endFrame - shot.startFrame;
    if (len <= MAX_HOLD || shot.mediaType === "video") return [shot];
    const parts = Math.ceil(len / MAX_HOLD);
    const per = Math.floor(len / parts);
    return Array.from({ length: parts }, (_, k) => ({
      ...shot,
      id: `${shot.id}-${k}`,
      startFrame: shot.startFrame + k * per,
      endFrame: k === parts - 1 ? shot.endFrame : shot.startFrame + (k + 1) * per,
      caption: k === 0 ? shot.caption : undefined,
      motion: shot.motion === "hold" ? (k % 2 ? "push" : "hold") : shot.motion,
    }));
  });

  return {
    kind,
    width,
    height,
    fps: FPS,
    durationInFrames,
    audio: narration.audioRel,
    audioEndFrame,
    accent,
    title: story.title,
    year: story.year,
    place: story.place,
    shots: renderShots,
    subtitles: buildCues(words, FPS, kind, durationInFrames),
  };
}
