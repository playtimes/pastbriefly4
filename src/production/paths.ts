import path from "node:path";
import { mkdirSync } from "node:fs";
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

// Absolute path from a story-folder-relative path.
export function inStory(slug: string, rel: string): string {
  return path.join(storyDir(slug), rel);
}

// Media-relative path (for HTTP serving) from a story-folder-relative path.
export function mediaRel(slug: string, rel: string): string {
  return path.posix.join("stories", slug, rel.split(path.sep).join("/"));
}
