import path from "node:path";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { DATA_DIR, MEDIA_DIR } from "../server/config.ts";

// A story's asset folder is the Remotion publicDir for its films, so render
// plans reference assets by paths relative to it (e.g. "images/hero.png", or a
// Long-first job's "jobs/<jobId>/images/hero.png": see productionMediaPrefix).
export function storyDir(slug: string): string {
  return path.join(MEDIA_DIR, "stories", slug);
}

// A story's retained archive (archiveRetention.ts). Deliberately under DATA_DIR,
// outside storyDir: it is never bundled with a render, and no working-visual
// cleanup (clearWorkingVisuals, a visual rebuild) can reach it.
export function retainedArchiveDir(slug: string): string {
  return path.join(DATA_DIR, "archive-retained", slug);
}

export function ensureStoryDirs(slug: string): void {
  for (const sub of ["archive", "images", "motion", "audio", "renders", "jobs"]) {
    mkdirSync(path.join(storyDir(slug), sub), { recursive: true });
  }
}

// The working folders of one production: the story root for a legacy job (empty
// prefix), or the job's own jobs/<jobId>/ workspace for a Long-first job.
export function ensureProductionDirs(slug: string, prefix: string): void {
  ensureStoryDirs(slug);
  if (!prefix) return;
  for (const sub of ["archive", "images", "motion", "audio", "renders"]) {
    mkdirSync(path.join(storyDir(slug), prefix, sub), { recursive: true });
  }
}

// Remove only one production's per-shot working visuals before it starts its
// visual assets: generated shot stills, archive stills and motion clips. With a
// legacy job's empty prefix that is the story root, as it always was (shot
// stills there are story-scoped, so a fresh legacy job would otherwise reuse an
// older job's files); with a Long-first job's prefix it is that job's workspace
// only, so nothing at the story root or of another job is touched. hero.png,
// audio, renders, refs and anything else are left alone.
export function clearWorkingVisuals(slug: string, prefix = ""): void {
  const dir = prefix ? path.join(storyDir(slug), prefix) : storyDir(slug);
  rmSync(path.join(dir, "archive"), { recursive: true, force: true });
  rmSync(path.join(dir, "motion"), { recursive: true, force: true });
  const images = path.join(dir, "images");
  let names: string[] = [];
  try {
    names = readdirSync(images);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (/^(long|short)-\d+\.(png|jpe?g|webp)$/i.test(name)) rmSync(path.join(images, name), { force: true });
  }
  ensureProductionDirs(slug, prefix);
}

// Whether a stored story-relative production path is a file directly in one of
// the production folders, at the story root (legacy) or in a job's workspace
// (Long-first): "images/long-00.png" or "jobs/<jobId>/images/long-00.png". The
// folder says what kind of media it is; neither form ever decides a job's flow.
export function isProductionMedia(rel: string, folder: "images" | "archive" | "motion" | "audio" | "renders"): boolean {
  return new RegExp(`^(?:jobs/[A-Za-z0-9_-]+/)?${folder}/[^/]+$`).test(rel);
}

// Absolute path from a story-folder-relative path.
export function inStory(slug: string, rel: string): string {
  return path.join(storyDir(slug), rel);
}

// Media-relative path (for HTTP serving) from a story-folder-relative path.
export function mediaRel(slug: string, rel: string): string {
  return path.posix.join("stories", slug, rel.split(path.sep).join("/"));
}
