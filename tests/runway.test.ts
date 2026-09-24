import { describe, test, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Runway provider: request shape, journal-based no-double-submit, resume, local
// download and terminal failures. fetch is stubbed; no live provider calls.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-runway-"));
process.env.PROVIDER_MODE = "live";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");
process.env.RUNWAYML_API_SECRET = "rw-test-secret";
delete process.env.RUNWAY_VIDEO_MODEL;

const { generateMotion, imageDataUri } = await import("../src/providers/runway.ts");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"); // a tiny PNG-signature payload
const still = path.join(tmp, "long-07.png");
writeFileSync(still, PNG);
const journalOf = (out: string) => JSON.parse(readFileSync(`${out}.req.json`, "utf8"));
const CLIP = Buffer.from("fake-mp4-bytes");

function res(body: any, extra: Record<string, any> = {}) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), ...extra } as any;
}

// A stub Runway: submit returns a task id, polling walks through the given
// statuses, and the output URL serves the clip bytes.
function stubRunway(statuses: any[], taskId = "task-1") {
  const calls: { url: string; init?: any }[] = [];
  let i = 0;
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith("/v1/image_to_video")) return res({ id: taskId });
    if (u.includes("/v1/tasks/")) return res(statuses[Math.min(i++, statuses.length - 1)]);
    if (u.startsWith("https://cdn.example.com/")) return res(null, { arrayBuffer: async () => CLIP.buffer.slice(CLIP.byteOffset, CLIP.byteOffset + CLIP.length) });
    throw new Error(`unexpected fetch ${u}`);
  }) as any;
  return calls;
}
const submits = (calls: { url: string }[]) => calls.filter((c) => c.url.endsWith("/v1/image_to_video"));

afterEach(() => vi.restoreAllMocks());

describe("runway request", () => {
  test("a local image becomes a data URI", () => {
    expect(imageDataUri(still)).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    const jpg = path.join(tmp, "x.jpg");
    writeFileSync(jpg, PNG);
    expect(imageDataUri(jpg).startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  test("Long is landscape gen4.5, 5s, with the Runway headers and an inline image", async () => {
    const out = path.join(tmp, "long.mp4");
    const calls = stubRunway([{ status: "SUCCEEDED", output: ["https://cdn.example.com/a.mp4"] }]);
    await generateMotion({ prompt: "animate", imagePath: still, kind: "long", outPath: out, pollMs: 1 });

    const [submit] = submits(calls);
    expect(submit.url).toBe("https://api.dev.runwayml.com/v1/image_to_video");
    expect(submit.init.method).toBe("POST");
    expect(submit.init.headers).toMatchObject({
      Authorization: "Bearer rw-test-secret",
      "Content-Type": "application/json",
      "X-Runway-Version": "2024-11-06",
    });
    const body = JSON.parse(submit.init.body);
    expect(body).toEqual({ model: "gen4.5", promptImage: imageDataUri(still), promptText: "animate", ratio: "1280:720", duration: 5 });
    // No public URL of any kind is involved.
    expect(body.promptImage.startsWith("data:")).toBe(true);
  });

  test("Short is portrait", async () => {
    const out = path.join(tmp, "short.mp4");
    const calls = stubRunway([{ status: "SUCCEEDED", output: ["https://cdn.example.com/b.mp4"] }]);
    await generateMotion({ prompt: "p", imagePath: still, kind: "short", outPath: out, pollMs: 1 });
    expect(JSON.parse(submits(calls)[0].init.body).ratio).toBe("720:1280");
  });
});

describe("runway polling and journal", () => {
  test("waits through PENDING/THROTTLED/RUNNING, downloads output[0] locally and journals done", async () => {
    const out = path.join(tmp, "ok.mp4");
    const calls = stubRunway([{ status: "PENDING" }, { status: "THROTTLED" }, { status: "RUNNING" }, { status: "SUCCEEDED", output: ["https://cdn.example.com/ok.mp4"] }], "task-ok");
    const got = await generateMotion({ prompt: "p", imagePath: still, kind: "long", outPath: out, pollMs: 1 });

    expect(got.taskId).toBe("task-ok");
    expect(readFileSync(out)).toEqual(CLIP); // the clip lives locally; the URL is not relied on later
    expect(journalOf(out)).toEqual({ state: "done", taskId: "task-ok", providerUrl: "https://cdn.example.com/ok.mp4" });
    expect(calls.filter((c) => c.url.endsWith("/v1/tasks/task-ok"))).toHaveLength(4);
  });

  test("an accepted task is journaled before polling", async () => {
    const out = path.join(tmp, "accepted.mp4");
    let seen: any = null;
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.endsWith("/v1/image_to_video")) return res({ id: "task-acc" });
      seen = journalOf(out); // what a restart would find mid-poll
      return { ok: false, status: 400, json: async () => ({}), text: async () => "" } as any;
    }) as any;
    await expect(generateMotion({ prompt: "p", imagePath: still, kind: "long", outPath: out, pollMs: 1 })).rejects.toThrow();
    expect(seen).toEqual({ state: "accepted", taskId: "task-acc" });
    expect(journalOf(out)).toEqual({ state: "accepted", taskId: "task-acc" }); // uncertain: kept for resume
  });

  test("resume polls the journaled task instead of resubmitting", async () => {
    const out = path.join(tmp, "resume.mp4");
    writeFileSync(`${out}.req.json`, JSON.stringify({ state: "accepted", taskId: "task-old" }));
    const calls = stubRunway([{ status: "SUCCEEDED", output: ["https://cdn.example.com/r.mp4"] }]);
    const got = await generateMotion({ prompt: "p", imagePath: still, kind: "long", outPath: out, pollMs: 1 });

    expect(got.taskId).toBe("task-old");
    expect(submits(calls)).toHaveLength(0);
    expect(calls.some((c) => c.url.endsWith("/v1/tasks/task-old"))).toBe(true);
    expect(existsSync(out)).toBe(true);
  });

  test("a done journal with the clip on disk makes no calls", async () => {
    const out = path.join(tmp, "done.mp4");
    writeFileSync(out, CLIP);
    writeFileSync(`${out}.req.json`, JSON.stringify({ state: "done", taskId: "task-d", providerUrl: "https://cdn.example.com/d.mp4" }));
    const calls = stubRunway([]);
    await generateMotion({ prompt: "p", imagePath: still, kind: "long", outPath: out, pollMs: 1 });
    expect(calls).toHaveLength(0);
  });

  test("an uncertain pending journal blocks a duplicate submission", async () => {
    const out = path.join(tmp, "pending.mp4");
    writeFileSync(`${out}.req.json`, JSON.stringify({ state: "pending" }));
    const calls = stubRunway([]);
    await expect(generateMotion({ prompt: "p", imagePath: still, kind: "long", outPath: out, pollMs: 1 })).rejects.toThrow(/uncertain outcome/);
    expect(calls).toHaveLength(0);
  });

  test.each(["FAILED", "CANCELED"])("terminal %s is surfaced and journaled as failed", async (status) => {
    const out = path.join(tmp, `fail-${status}.mp4`);
    stubRunway([{ status: "RUNNING" }, { status, failure: "Input image was rejected" }], "task-f");
    await expect(generateMotion({ prompt: "p", imagePath: still, kind: "long", outPath: out, pollMs: 1 })).rejects.toThrow(
      new RegExp(`Runway task task-f ${status}: Input image was rejected`),
    );
    expect(journalOf(out)).toEqual({ state: "failed", taskId: "task-f", message: "Input image was rejected" });
    expect(existsSync(out)).toBe(false);
  });

  test("a confirmed failure may be retried with a fresh submission", async () => {
    const out = path.join(tmp, "retry.mp4");
    writeFileSync(`${out}.req.json`, JSON.stringify({ state: "failed", taskId: "task-dead", message: "boom" }));
    const calls = stubRunway([{ status: "SUCCEEDED", output: ["https://cdn.example.com/n.mp4"] }], "task-new");
    const got = await generateMotion({ prompt: "p", imagePath: still, kind: "long", outPath: out, pollMs: 1 });
    expect(got.taskId).toBe("task-new");
    expect(submits(calls)).toHaveLength(1);
    expect(calls.some((c) => c.url.includes("task-dead"))).toBe(false);
  });

  test("a rejected submission is not journaled (not billed)", async () => {
    const out = path.join(tmp, "rejected.mp4");
    global.fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => "bad ratio" }) as any) as any;
    await expect(generateMotion({ prompt: "p", imagePath: still, kind: "long", outPath: out, pollMs: 1 })).rejects.toThrow(/Runway submit 400: bad ratio/);
    expect(existsSync(`${out}.req.json`)).toBe(false);
  });
});
