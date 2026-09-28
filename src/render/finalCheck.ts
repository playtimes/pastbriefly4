import type { RenderPlan } from "./types.ts";
import type { Probe } from "./renderVideo.ts";

// The deterministic output contract a finished MP4 must meet before its job can be
// Ready. Only the file's shape is checked (dimensions, frame rate, audio stream,
// duration against its RenderPlan), never its creative quality.
export const FINAL_VIDEO = {
  long: { width: 1920, height: 1080 },
  short: { width: 1080, height: 1920 },
  fps: 30,
  fpsTolerance: 0.01,
  durationToleranceSec: 0.25, // container / mux timing (AAC priming, last-frame rounding)
} as const;

// Throws a plain message naming the film if its probe breaks the contract.
export function validateFinalVideo(plan: RenderPlan, probe: Probe): void {
  const film = plan.kind === "long" ? "Long" : "Short";
  const fail = (why: string): never => {
    throw new Error(`Final file check failed for ${film}: ${why}.`);
  };
  const want = FINAL_VIDEO[plan.kind];
  if (probe.width !== want.width || probe.height !== want.height) fail(`expected ${want.width}x${want.height}, got ${probe.width}x${probe.height}`);
  if (!Number.isFinite(probe.fps) || probe.fps <= 0) fail("the file has no usable frame rate");
  if (Math.abs(probe.fps - FINAL_VIDEO.fps) > FINAL_VIDEO.fpsTolerance) fail(`expected ${FINAL_VIDEO.fps} fps, got ${+probe.fps.toFixed(2)}`);
  if (!probe.hasAudio) fail("audio stream is missing");
  if (!Number.isFinite(probe.durationSec) || probe.durationSec <= 0) fail("the file has no usable duration");
  const expected = plan.durationInFrames / plan.fps;
  if (Math.abs(probe.durationSec - expected) > FINAL_VIDEO.durationToleranceSec) fail(`expected about ${expected.toFixed(1)}s, got ${probe.durationSec.toFixed(1)}s`);
}
