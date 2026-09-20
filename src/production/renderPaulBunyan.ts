// Acceptance render: run the full local (mock) pipeline for Operation Paul
// Bunyan end to end and produce a complete Long and Short with the PB4 renderer.
// No paid providers. Run with: npm run render:paul-bunyan

import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { ensureSeed } from "./seed.ts";
import { getStoryBySlug, createJob, videosForStory } from "../server/store.ts";
import { estimateJob } from "./estimate.ts";
import { runJob, newJobId } from "./generate.ts";
import { ensureStoryDirs, inStory } from "./paths.ts";
import { MEDIA_DIR } from "../server/config.ts";

// Stage the real PB1 Paul Bunyan frames as this story's reference stills, and
// drop any previously generated stills so the render rebuilds from them.
function stageRealFrames(slug: string): void {
  ensureStoryDirs(slug);
  const source = path.join(MEDIA_DIR, "style", "paul-bunyan");
  if (existsSync(source)) cpSync(source, inStory(slug, "refs"), { recursive: true });
  for (const sub of ["images", "renders"]) rmSync(inStory(slug, sub), { recursive: true, force: true });
}

async function main(): Promise<void> {
  const started = Date.now();
  ensureSeed();
  const story = getStoryBySlug("paul-bunyan");
  if (!story) throw new Error("Paul Bunyan story missing after seed.");
  stageRealFrames(story.slug);

  const estimate = estimateJob(story);
  const job = createJob({ id: newJobId(), storyId: story.id, mock: true, estimatedCost: estimate.total, approvedMax: Math.max(estimate.total, 15) });

  console.log("Rendering Operation Paul Bunyan (mock, offline)...");
  await runJob(job.id, { autoApprovePreview: true });

  const videos = videosForStory(story.id);
  if (videos.length < 2) throw new Error("Expected a Long and a Short.");
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  for (const v of videos) {
    console.log(`${v.kind.toUpperCase().padEnd(5)} ${v.width}x${v.height} ${v.durationSec.toFixed(1)}s audio=${v.hasAudio}`);
    console.log(`      ${inStory(story.slug, `renders/${v.kind}.mp4`)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
