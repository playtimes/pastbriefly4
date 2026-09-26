import { describe, test, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The finalized scripts are stored and narrated with plain hyphens, not only the
// rendered subtitles. OpenAI and ElevenLabs are stubs: zero provider calls. The
// runJob storage path is covered in scriptAuditJob.test.ts.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-dashes-"));
process.env.PROVIDER_MODE = "live";
process.env.OPENAI_API_KEY = "test-key";
process.env.ELEVENLABS_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const h = vi.hoisted(() => ({ narrated: [] as string[] }));
const DASHED_LONG = "Sweden – Norway. Java — Australia. A―B and K-19.";
const DASHED_SHORT = "Java — Australia, then K-19.";

vi.mock("../src/providers/openai.ts", () => ({
  imageMimeType: () => "image/png",
  generateImageFile: vi.fn(async () => {
    throw new Error("no images in this test");
  }),
  respondJson: vi.fn(async (opts: { schemaName: string }) => {
    if (opts.schemaName === "script") return { script: "" };
    if (opts.schemaName === "script_audit") return { long: DASHED_LONG, short: DASHED_SHORT };
    return {};
  }),
}));
vi.mock("../src/providers/elevenlabs.ts", () => ({
  narrate: vi.fn(async (text: string) => {
    h.narrated.push(text);
    return text.split(" ").map((word, i) => ({ word, start: i * 0.4, end: i * 0.4 + 0.3 }));
  }),
}));
vi.mock("../src/providers/runway.ts", () => ({ generateMotion: vi.fn(async () => {}) }));

const { writeScript, auditScripts } = await import("../src/production/scripts.ts");
const { recordNarration } = await import("../src/production/narration.ts");
const { respondJson } = await import("../src/providers/openai.ts");

const story = { id: "s", slug: "dash-story", title: "T", hook: "H", category: "Disasters", year: "1942", place: "P", summary: "S", heroImage: null, moments: [], sources: [], productionNote: "", createdAt: "" } as any;
const research = { summary: "S", moments: [], sources: [], facts: [] } as any;

describe("finalized scripts are normalized before storage and narration", () => {
  test("a written draft comes back with plain hyphens", async () => {
    vi.mocked(respondJson).mockResolvedValueOnce({ script: `  ${DASHED_LONG}  ` });
    expect(await writeScript(story, research, "long")).toBe("Sweden - Norway. Java - Australia. A-B and K-19.");
  });

  test("the audited (final) scripts come back with plain hyphens", async () => {
    const final = await auditScripts(story, research, { long: "x", short: "y" });
    expect(final).toEqual({ long: "Sweden - Norway. Java - Australia. A-B and K-19.", short: "Java - Australia, then K-19." });
  });

  test("narration sends plain hyphens to the voice even for a legacy stored script", async () => {
    const n = await recordNarration(story.slug, "short", DASHED_SHORT);
    expect(h.narrated.at(-1)).toBe("Java - Australia, then K-19.");
    expect(n.words.map((w) => w.word).join(" ")).toBe("Java - Australia, then K-19.");
  });
});
