import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Final audio mastering: every rendered film is brought to -16 LUFS / -1.5 dBTP by
// two-pass loudnorm with the video stream copied, through a temporary file that only
// replaces the render once ffmpeg succeeds. The flow tests use a fake ffmpeg; one
// test masters a small synthetic clip with the real ffmpeg.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-master-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const { masterAudio, MASTER } = await import("../src/render/master.ts");
const { probeVideo } = await import("../src/render/renderVideo.ts");
const { config } = await import("../src/server/config.ts");

const MEASURED = { input_i: "-26.77", input_tp: "-9.91", input_lra: "3.10", input_thresh: "-37.08", output_i: "-16.0", target_offset: "0.49" };
const loudnormStderr = (m: Record<string, string>) => `[Parsed_loudnorm_0 @ 0000] \n${JSON.stringify(m, null, 1)}\n`;

let n = 0;
function render(): string {
  const file = path.join(tmp, `film-${n++}.mp4`);
  writeFileSync(file, "original render");
  return file;
}

// A fake ffmpeg: pass 1 prints the measurement; pass 2 writes its output file.
function fakeFfmpeg(opts: { measured?: Record<string, string>; failPass2?: boolean } = {}) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args.includes("null")) return loudnormStderr(opts.measured ?? MEASURED);
    const out = args[args.length - 1];
    writeFileSync(out, "half-written");
    if (opts.failPass2) throw new Error("ffmpeg failed (exit 1): encoder error");
    writeFileSync(out, "mastered render");
    return loudnormStderr({ ...MEASURED, normalization_type: "dynamic" });
  };
  return { run, calls };
}

const leftovers = (file: string) => readdirSync(path.dirname(file)).filter((f) => f.startsWith(path.basename(file, ".mp4")) && f !== path.basename(file));

describe("audio mastering flow", () => {
  test("targets -16 LUFS integrated and -1.5 dBTP true peak", () => {
    expect(MASTER.I).toBe(-16);
    expect(MASTER.TP).toBe(-1.5);
  });

  test("two passes: measure, then apply the measured values with the video copied", () => {
    const file = render();
    const { run, calls } = fakeFfmpeg();
    expect(masterAudio(file, run)).toBe("mastered");
    expect(calls).toHaveLength(2);

    const [p1, p2] = calls;
    const af1 = p1[p1.indexOf("-af") + 1];
    expect(af1).toBe("loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json");
    expect(p1.slice(-3)).toEqual(["-f", "null", "-"]); // pass 1 writes nothing

    const af2 = p2[p2.indexOf("-af") + 1];
    expect(af2).toContain("loudnorm=I=-16:TP=-1.5:LRA=11");
    expect(af2).toContain("measured_I=-26.77:measured_TP=-9.91:measured_LRA=3.10:measured_thresh=-37.08:offset=0.49");
    expect(af2).toContain("linear=true"); // loudnorm falls back to dynamic itself when linear gain would clip
    expect(p2[p2.indexOf("-c:v") + 1]).toBe("copy");
    expect(p2).not.toContain("-vf");
    expect(p2).not.toContain("-filter_complex");
    expect(p2[p2.indexOf("-c:a") + 1]).toBe("aac");
    expect(p2.at(-1)).not.toBe(file); // never writes over the render directly
  });

  test("replaces the render only after mastering succeeds and leaves no temp file", () => {
    const file = render();
    masterAudio(file, fakeFfmpeg().run);
    expect(readFileSync(file, "utf8")).toBe("mastered render");
    expect(leftovers(file)).toEqual([]);
  });

  test("a failed mastering pass keeps the original render and removes the partial file", () => {
    const file = render();
    expect(() => masterAudio(file, fakeFfmpeg({ failPass2: true }).run)).toThrow(/encoder error/);
    expect(readFileSync(file, "utf8")).toBe("original render");
    expect(leftovers(file)).toEqual([]);
  });

  test("a failed measurement pass keeps the original render", () => {
    const file = render();
    const run = () => {
      throw new Error("ffmpeg failed (exit 1)");
    };
    expect(() => masterAudio(file, run)).toThrow();
    expect(readFileSync(file, "utf8")).toBe("original render");
  });

  test("digital silence (mock narration) is left untouched", () => {
    const file = render();
    const { run, calls } = fakeFfmpeg({ measured: { input_i: "-inf", input_tp: "-inf", input_lra: "0.00", input_thresh: "-70.00", target_offset: "inf" } });
    expect(masterAudio(file, run)).toBe("silent");
    expect(calls).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe("original render");
  });
});

// Real ffmpeg on a synthetic 6s clip (a quiet tone under a test pattern).
describe("audio mastering with ffmpeg", () => {
  const ff = (args: string[]) => execFileSync(config.ffmpeg, ["-v", "error", ...args], { encoding: "utf8" });
  const videoMd5 = (f: string) => ff(["-i", f, "-map", "0:v", "-c", "copy", "-f", "md5", "-"]).trim();
  const ebur128 = (f: string) => {
    const r = spawnSync(config.ffmpeg, ["-hide_banner", "-nostats", "-i", f, "-map", "0:a", "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" });
    const summary = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
    return { I: Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)![1]), TP: Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)![1]) };
  };

  test("reaches -16 LUFS within -1.5 dBTP and copies the video stream bit for bit", () => {
    const file = path.join(tmp, "synthetic.mp4");
    ff([
      "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=6",
      "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=6,volume=0.03,aformat=channel_layouts=stereo",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file,
    ]);
    const before = { md5: videoMd5(file), probe: probeVideo(file), loud: ebur128(file) };
    expect(before.loud.I).toBeLessThan(-24); // well under the target, like U-137's -26 LUFS

    expect(masterAudio(file)).toBe("mastered");

    const after = { md5: videoMd5(file), probe: probeVideo(file), loud: ebur128(file) };
    expect(after.md5).toBe(before.md5); // video stream copied, never re-encoded
    expect([after.probe.width, after.probe.height, after.probe.fps]).toEqual([before.probe.width, before.probe.height, before.probe.fps]);
    expect(after.probe.hasAudio).toBe(true);
    expect(Math.abs(after.probe.durationSec - before.probe.durationSec)).toBeLessThan(0.1);
    expect(Math.abs(after.loud.I - MASTER.I)).toBeLessThanOrEqual(0.5);
    expect(after.loud.TP).toBeLessThanOrEqual(MASTER.TP + 0.1);
    expect(existsSync(file.replace(/\.mp4$/, ".mastering.mp4"))).toBe(false);
  }, 60000);
});
