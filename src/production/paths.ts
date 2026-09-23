import path from "node:path";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { MEDIA_DIR } from "../server/config.ts";

// A story's asset folder is the Remotion publicDir for its films, so render
// plans reference assets by paths relative to it (e.g. "images/hero.png").
export function storyDir(slug: string): string {
  return path.join(MEDIA_DIR, "stories", slug);
}

export function ensureStoryDirs(slug: string): void {
  for (const sub of ["archive", "images", "motion", "audio", "renders", "jobs"]) {
    mkdirSync(path.join(storyDir(slug), sub), { recursive: true });
  }
}

// Shot stills are story-scoped (images/long-00.png ...), so a fresh job for a
// story that was produced before would otherwise find and reuse the older job's
// files. Remove only the per-shot working visuals: generated shot stills, archive
// stills and motion clips. hero.png, audio, renders, refs and anything else in
// the story folder are left alone.
export function clearWorkingVisuals(slug: string): void {
  const dir = storyDir(slug);
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
  ensureStoryDirs(slug);
}

// Absolute path from a story-folder-relative path.
export function inStory(slug: string, rel: string): string {
  return path.join(storyDir(slug), rel);
}

// Media-relative path (for HTTP serving) from a story-folder-relative path.
export function mediaRel(slug: string, rel: string): string {
  return path.posix.join("stories", slug, rel.split(path.sep).join("/"));
}
