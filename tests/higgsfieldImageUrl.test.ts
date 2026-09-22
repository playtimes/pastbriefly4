import { describe, test, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Story } from "../src/types.ts";
import type { PlannedShot } from "../src/production/visuals.ts";

// The Higgsfield still URL must be provider-reachable: PB4 serves MEDIA_DIR under
// the Fastify "/media/" prefix, so the URL handed to Higgsfield has to include it.
// mediaRel() returns "stories/<slug>/<path>" (no /media/), so acquireMotion() must
// prepend it - otherwise Higgsfield fetches https://host/stories/... and 404s.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-higgs-url-"));
process.env.PROVIDER_MODE = "live";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");
process.env.HIGGSFIELD_PUBLIC_ASSET_BASE = "https://example.com";

// Capture the imageUrl acquireMotion builds without touching the live provider.
const calls: { imageUrl: string }[] = [];
vi.mock("../src/providers/higgsfield.ts", () => ({
  generateMotion: async (opts: { imageUrl: string }) => {
    calls.push({ imageUrl: opts.imageUrl });
    return { requestId: "req-test" };
  },
}));

const { acquireMotion } = await import("../src/production/visuals.ts");

function makeStory(): Story {
  return {
    id: "s1",
    slug: "whiskey-on-the-rocks",
    title: "The Whiskey on the Rocks Incident",
    hook: "A Soviet submarine ran aground.",
    category: "Conflicts & Standoffs",
    year: "1981",
    place: "Karlskrona, Sweden",
    summary: "A stranded submarine sparks a standoff.",
    heroImage: null,
    moments: [{ title: "The grounding", detail: "Stuck fast near a naval base." }],
    sources: [],
    productionNote: "",
    createdAt: new Date().toISOString(),
  };
}

function makeShot(): PlannedShot {
  return {
    index: 3,
    truth: "reconstruction",
    motion: "push",
    wantsMotion: true,
    prompt: "slow push in on the stranded submarine",
    wordStart: 0,
    wordEnd: 10,
    path: "still/long-03.png",
  } as PlannedShot;
}

afterEach(() => {
  calls.length = 0;
  vi.restoreAllMocks();
});

describe("higgsfield image URL", () => {
  test("includes the /media/ static prefix so the provider can reach the still", async () => {
    const story = makeStory();
    await acquireMotion(story, "long", makeShot());

    expect(calls).toHaveLength(1);
    expect(calls[0].imageUrl).toBe("https://example.com/media/stories/whiskey-on-the-rocks/still/long-03.png");
    // Never the prefix-less path the Fastify static route does not serve.
    expect(calls[0].imageUrl).not.toBe("https://example.com/stories/whiskey-on-the-rocks/still/long-03.png");
  });
});
