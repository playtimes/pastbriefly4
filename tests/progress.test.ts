import { describe, test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JobStep } from "../src/types.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-progress-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const { jobProgress } = await import("../src/production/generate.ts");

// jobProgress is pure over { step, scratch }, so tests build the scratch directly.
function at(step: JobStep, scratch: Record<string, any>) {
  return jobProgress({ step, scratch });
}

function shot(over: Record<string, any>) {
  return { truth: "reconstruction", wantsMotion: false, ...over };
}

describe("jobProgress derivation", () => {
  test("research and finishing have no count", () => {
    expect(at("research", {})).toBeNull();
    expect(at("finishing", {})).toBeNull();
  });

  test("scripts count completed parts out of 2", () => {
    expect(at("scripts", {})).toEqual({ current: 0, total: 2 });
    expect(at("scripts", { scriptParts: { long: "L" } })).toEqual({ current: 1, total: 2 });
    expect(at("scripts", { scriptParts: { long: "L", short: "S" } })).toEqual({ current: 2, total: 2 });
  });

  test("narration counts recorded parts out of 2", () => {
    expect(at("narration", { narration: { long: { path: "a" } } })).toEqual({ current: 1, total: 2 });
    expect(at("narration", { narration: { long: { path: "a" }, short: { path: "b" } } })).toEqual({ current: 2, total: 2 });
  });

  test("archive counts resolved archive shots only", () => {
    const scratch = {
      longShots: [shot({ truth: "archive", path: "a.jpg" }), shot({ truth: "archive" })],
      shortShots: [shot({ truth: "reconstruction", path: "r.jpg" })],
    };
    expect(at("archive", scratch)).toEqual({ current: 1, total: 2 });
  });

  test("archive is null when there are no archive shots", () => {
    expect(at("archive", { longShots: [shot({ truth: "graphic" })], shortShots: [] })).toBeNull();
  });

  test("stills counts every planned shot with a path", () => {
    const scratch = {
      longShots: [shot({ path: "a" }), shot({})],
      shortShots: [shot({ truth: "archive", path: "c" })],
    };
    expect(at("stills", scratch)).toEqual({ current: 2, total: 3 });
    expect(at("stills", {})).toBeNull();
  });

  test("build counts motion shots with a rendered clip out of wantsMotion", () => {
    const scratch = {
      longShots: [shot({ wantsMotion: true, motionPath: "m.mp4" }), shot({ wantsMotion: true })],
      shortShots: [shot({ wantsMotion: false })],
    };
    expect(at("build", scratch)).toEqual({ current: 1, total: 2 });
    expect(at("build", { longShots: [shot({ wantsMotion: false })], shortShots: [] })).toBeNull();
  });
});
