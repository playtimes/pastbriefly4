import { describe, test, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The discovery prompt is the editorial policy for what counts as a PastBriefly
// story. We run the real findStories in live mode with stubbed OpenAI/ffmpeg and
// inspect the instructions sent to the discovery call.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-editorial-"));
process.env.PROVIDER_MODE = "live";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

vi.mock("../src/providers/openai.ts", () => ({ respondJson: vi.fn() }));
vi.mock("../src/production/mockAssets.ts", () => ({
  writePlaceholderStill: vi.fn(),
  writeSilentWav: vi.fn(),
  referenceFrame: vi.fn(() => null),
}));

const { respondJson } = await import("../src/providers/openai.ts");
const { findStories } = await import("../src/production/research.ts");

const respond = vi.mocked(respondJson);

beforeEach(() => {
  respond.mockReset();
  respond.mockImplementation(async () => ({ candidates: [] }) as any);
});

function discoveryInstructions(): string {
  return respond.mock.calls.find((c) => (c[0] as any).schemaName === "candidates")![0].instructions as string;
}

describe("discovery editorial policy", () => {
  test("the discovery prompt encodes the PastBriefly entertainment brief", async () => {
    await findStories("anything");
    const p = discoveryInstructions();

    // The core promise and its zero-context appeal.
    expect(p).toContain("true historical stories that sound made up");
    expect(p).toContain("ZERO-CONTEXT TEST");
    expect(p).toMatch(/before the context|BEFORE the context/);

    // Guards against generic biography / "Person X contributed to Event Y".
    expect(p).toContain("Person X");
    expect(p).toMatch(/biograph/i);

    // Visual / bizarre / high-concept preference.
    expect(p).toMatch(/bizarre/i);
    expect(p).toMatch(/visual/i);
  });

  test("the discovery prompt requires plain-English, instantly understandable titles", async () => {
    await findStories("anything");
    const p = discoveryInstructions();

    // Titles must state the strange event in plain English, understood fast.
    expect(p).toMatch(/plain English/i);
    expect(p).toMatch(/two seconds|2 seconds/i);
    // The strange event itself must carry the title.
    expect(p).toMatch(/event should carry the title|event itself/i);
    // Reject documentary / article-style title phrasing.
    expect(p).toMatch(/documentary/i);
    expect(p).toContain("The Story of");
    expect(p).toContain("The Role of");
  });
});
