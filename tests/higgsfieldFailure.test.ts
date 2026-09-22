import { describe, test, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Higgsfield terminal-failure handling: surface the provider's reason, mark the
// request journal "failed", and let a confirmed failure be retried with a NEW
// submission - while an uncertain "pending" journal still blocks resubmission.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-higgs-"));
process.env.PROVIDER_MODE = "live";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");
process.env.HIGGSFIELD_API_KEY = "test-key";
process.env.HIGGSFIELD_API_SECRET = "test-secret";

const { generateMotion } = await import("../src/providers/higgsfield.ts");

const IMAGE = "https://example.com/still.png";
const journalOf = (out: string) => JSON.parse(readFileSync(`${out}.req.json`, "utf8"));

function res(body: any, extra: Record<string, any> = {}) {
  return { ok: true, json: async () => body, ...extra } as any;
}

afterEach(() => vi.restoreAllMocks());

describe("higgsfield terminal failure", () => {
  test("surfaces the provider's failure detail in the thrown error", async () => {
    const out = path.join(tmp, "detail.mp4");
    global.fetch = vi.fn(async (url: any) => {
      if (String(url).includes("/status")) return res({ status: "failed", error: "could not fetch input image" });
      return res({ request_id: "req1", status_url: "https://api.higgsfield.ai/requests/req1/status" });
    }) as any;

    await expect(generateMotion({ prompt: "p", imageUrl: IMAGE, outPath: out })).rejects.toThrow(
      /Higgsfield job req1 failed: could not fetch input image/,
    );
  }, 15000);

  test("writes journal state \"failed\", preserving requestId/statusUrl and the message", async () => {
    const out = path.join(tmp, "journal.mp4");
    global.fetch = vi.fn(async (url: any) => {
      if (String(url).includes("/status")) return res({ status: "failed", message: "input rejected" });
      return res({ request_id: "req2", status_url: "https://api.higgsfield.ai/requests/req2/status" });
    }) as any;

    await expect(generateMotion({ prompt: "p", imageUrl: IMAGE, outPath: out })).rejects.toThrow();

    expect(journalOf(out)).toEqual({
      state: "failed",
      requestId: "req2",
      statusUrl: "https://api.higgsfield.ai/requests/req2/status",
      message: "input rejected",
    });
  }, 15000);

  test("a retry after a confirmed failure submits a NEW request instead of re-polling", async () => {
    const out = path.join(tmp, "retry.mp4");
    // A leftover terminal-failed journal from a prior attempt (old request id).
    writeFileSync(
      `${out}.req.json`,
      JSON.stringify({ state: "failed", requestId: "old", statusUrl: "https://api.higgsfield.ai/requests/old/status", message: "boom" }),
    );

    const fetchMock = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("/requests/") && u.includes("/status")) return res({ status: "completed", url: "https://cdn.example.com/new.mp4" });
      if (u.includes("cdn.example.com")) return res(null, { arrayBuffer: async () => new ArrayBuffer(16) });
      return res({ request_id: "req-new", status_url: "https://api.higgsfield.ai/requests/req-new/status" }); // fresh submit
    });
    global.fetch = fetchMock as any;

    const got = await generateMotion({ prompt: "p", imageUrl: IMAGE, outPath: out });

    expect(got.requestId).toBe("req-new");
    expect(journalOf(out).state).toBe("done");
    expect(journalOf(out).requestId).toBe("req-new");
    // The dead request must never be polled again.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/requests/old/"))).toBe(false);
    expect(urls.some((u) => u.endsWith(process.env.HIGGSFIELD_VIDEO_MODEL || "kling-video/v2.5-turbo/pro/image-to-video"))).toBe(true);
  }, 15000);

  test("an uncertain \"pending\" journal still blocks a duplicate submission", async () => {
    const out = path.join(tmp, "pending.mp4");
    writeFileSync(`${out}.req.json`, JSON.stringify({ state: "pending" }));
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;

    await expect(generateMotion({ prompt: "p", imageUrl: IMAGE, outPath: out })).rejects.toThrow(/uncertain outcome/);
    expect(fetchMock).not.toHaveBeenCalled(); // never resubmitted the uncertain request
  });
});
