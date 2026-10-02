import { describe, test, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

// Stage 16A Slice 2, prompt safety. The Long-first prompts are new, so the pair
// prompts must not have moved as a side effect: each legacy prompt and payload
// builder is pinned by the SHA-256 it had at a563196 (before Slice 2), measured
// on the same fixture inputs. And the Long-only prompts, schemas and inputs
// carry no Short at all.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-long-first-prompts-"));
process.env.PROVIDER_MODE = "mock";
process.env.OPENAI_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const seen = vi.hoisted(() => [] as any[]);
vi.mock("../src/providers/openai.ts", async (orig) => ({
  ...(await orig<typeof import("../src/providers/openai.ts")>()),
  respondJson: vi.fn(async (opts: any) => {
    seen.push(opts);
    if (opts.schemaName === "script_audit") return { long: "L", short: "S" };
    if (opts.schemaName === "long_script_audit") return { long: "L" };
    if (opts.schemaName === "story_revision" || opts.schemaName === "long_story_revision") return { title: "T", hook: "H", moments: [], facts: [], long: "L", short: "S" };
    return { decision: "PASS", summary: "ok", repairFeedback: null, humanReview: [] };
  }),
}));

const s = await import("../src/production/scripts.ts");
const v = await import("../src/production/visuals.ts");
const { config } = await import("../src/server/config.ts");
const { recordNarration } = await import("../src/production/narration.ts");
const { ensureStoryDirs } = await import("../src/production/paths.ts");
const { paulBunyanStory, paulBunyanResearch, paulBunyanScripts } = await import("../src/production/fixtures/paulBunyan.ts");

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
// A non-fixture story, so the live text calls really reach the (stubbed) provider.
const story = { ...paulBunyanStory, id: "prompt-pins", slug: "prompt-pins", createdAt: "2026-01-01T00:00:00.000Z" };

// Everything measured, by name: the legacy pair prompts and payloads.
async function legacyMeasures(): Promise<Record<string, string>> {
  config.mode = "live";
  seen.length = 0;
  await s.auditScripts(story, paulBunyanResearch, paulBunyanScripts);
  await s.reviseStoryText(story, paulBunyanResearch, paulBunyanScripts, "Tighten the hook.");
  await s.reviewStoryDraft(story, paulBunyanResearch, paulBunyanScripts);
  await s.verifyStoryDraft(story, paulBunyanResearch, paulBunyanScripts, "Tighten the hook.");
  config.mode = "mock";
  const [audit, revision, review, verify] = seen;
  ensureStoryDirs(story.slug);
  const narration = { long: await recordNarration(story.slug, "long", paulBunyanScripts.long), short: await recordNarration(story.slug, "short", paulBunyanScripts.short) };
  const slots = { long: v.planSlots("long", paulBunyanScripts.long, narration.long), short: v.planSlots("short", paulBunyanScripts.short, narration.short) };
  const cov = await v.fallbackCoverageDirector({ story, research: paulBunyanResearch, scripts: paulBunyanScripts, slots });
  const library = { long: v.validateCoverage("long", cov.longAssets), short: v.validateCoverage("short", cov.shortAssets) };
  const presentations = { long: v.buildPresentations(library.long), short: v.buildPresentations(library.short) };
  return {
    COVERAGE_INSTRUCTIONS: v.COVERAGE_INSTRUCTIONS,
    EDITOR_INSTRUCTIONS: v.EDITOR_INSTRUCTIONS,
    COVERAGE_REPAIR_INSTRUCTIONS: v.COVERAGE_REPAIR_INSTRUCTIONS,
    EDIT_REPAIR_INSTRUCTIONS: v.EDIT_REPAIR_INSTRUCTIONS,
    coveragePayload: v.coveragePayload({ story, research: paulBunyanResearch, scripts: paulBunyanScripts, slots }),
    editorPayload: v.editorPayload({ story, research: paulBunyanResearch, scripts: paulBunyanScripts, slots, library, presentations }),
    SCRIPT_AUDIT_INSTRUCTIONS: audit.instructions,
    auditInput: audit.input,
    REVISION_INSTRUCTIONS: revision.instructions,
    revisionInput: revision.input,
    TEXT_QA_INSTRUCTIONS: review.instructions,
    textQaInput: review.input,
    TEXT_VERIFY_INSTRUCTIONS: verify.instructions,
    textVerifyInput: verify.input,
    schemas: JSON.stringify([audit.schema, revision.schema, review.schema, verify.schema, v.COVERAGE_SCHEMA]),
  };
}

// Measured at a563196 (the main before Slice 2) with this same function.
const AT_A563196: Record<string, string> = {
  COVERAGE_INSTRUCTIONS: "dcdc0a9b1d76bda88e3afd9cccbd7f9186fc5b9b369eba7f4ff9d90b947ed76d",
  EDITOR_INSTRUCTIONS: "b1fd97cc15b972dca15f289eb01d451b05491532dbae2bcd44657206811adc16",
  COVERAGE_REPAIR_INSTRUCTIONS: "0a9a803844fd78a7b02199e38c5649d427d52cb0514de458fab90b8e7f2dfc22",
  EDIT_REPAIR_INSTRUCTIONS: "ff7825961da27a03962aec3b86507b86228e2294b0e2d95c07cb9165f657b2e1",
  coveragePayload: "0854e71b1db1c557ea4b0fb352b5e194db46d747759ab6b48dec780d9570be47",
  editorPayload: "be87460ed8530f16fa6abe83563443af18757f0a2b15a76561088a452d6e3050",
  SCRIPT_AUDIT_INSTRUCTIONS: "a478d8e30a8327b1a23c6f7fef3a4a077ea52cd05f110ecfcfb23f110b64da6c",
  auditInput: "b609a86265eec92bf3abb0e9e93a6fe0b0dfede26cc0c01b38e7555a4a671dd1",
  REVISION_INSTRUCTIONS: "de5087b62727b3d285b3ce3f856657ab2ca8865b0aafcc0973053fe1ee236d8a",
  revisionInput: "76199cb32faea947e64553e9deb9c73c7085bdda58920b1e12759eaa4c9cf036",
  TEXT_QA_INSTRUCTIONS: "5f6a00fb4bb0f6bccc4d828056bcc0e35f4147052943923b83adb2d626832ef8",
  textQaInput: "1ed1095ff5415c5cbeae1dac88a5fa1acadc017dd212bd41c7fd76f8d264bb02",
  TEXT_VERIFY_INSTRUCTIONS: "e08f6f681be2649fedd06a24c658244af8d73afb5b7f0d114f9b8d3698b08925",
  textVerifyInput: "4bd7557a77430195ef4426c8ce22d8add589082399eb1bb1b5859666fc4486a4",
  schemas: "31bcdb1065d73e1f51f8880a6244ab5151220efee36e34965b41fd9805098197",
};

describe("the pair prompts did not move", () => {
  test("every legacy prompt, payload and schema has the hash it had before Slice 2", async () => {
    const now = Object.fromEntries(Object.entries(await legacyMeasures()).map(([k, t]) => [k, sha(t)]));
    if (process.env.PB4_PRINT_PROMPT_HASHES) console.log(`PROMPT-HASHES ${JSON.stringify(now)}`);
    expect(now).toEqual(AT_A563196);
  });
});

describe("the Long-first prompts and inputs carry no Short", () => {
  const SHORT = /\bShort\b|SHORT SCRIPT|shortAssets|"short"/;

  test("prompts and schemas", () => {
    for (const p of [s.LONG_SCRIPT_AUDIT_INSTRUCTIONS, s.LONG_REVISION_INSTRUCTIONS, s.LONG_TEXT_QA_INSTRUCTIONS, s.LONG_TEXT_VERIFY_INSTRUCTIONS, v.LONG_COVERAGE_INSTRUCTIONS, v.LONG_EDITOR_INSTRUCTIONS]) expect(p).not.toMatch(SHORT);
    expect(v.LONG_COVERAGE_SCHEMA.required).toEqual(["longAssets"]);
    expect(Object.keys(v.LONG_COVERAGE_SCHEMA.properties)).toEqual(["longAssets"]);
    const editor = v.longEditorSchema(v.buildPresentations([]));
    expect(editor.required).toEqual(["long"]);
    expect(Object.keys(editor.properties)).toEqual(["long"]);
    // The section enum a Long-first review may name.
    expect(s.LONG_TEXT_QA_INSTRUCTIONS).toContain("A section is one of: story, hook, spine, facts, long.");
    expect(v.LONG_COVERAGE_INSTRUCTIONS).toContain("VISUAL HIERARCHY");
    expect(v.LONG_COVERAGE_INSTRUCTIONS).not.toMatch(/Blender/);
  });

  test("the live Long-only calls: no Short in what is sent, a Long-only schema, and an answer naming the Short is refused", async () => {
    config.mode = "live";
    seen.length = 0;
    const draft = { long: paulBunyanScripts.long };
    expect(await s.auditLongScript(story, paulBunyanResearch, draft.long)).toBe("L");
    await s.reviseLongText(story, paulBunyanResearch, draft, "Tighten the hook.");
    await s.reviewLongDraft(story, paulBunyanResearch, draft);
    await s.verifyLongDraft(story, paulBunyanResearch, draft, "Tighten the hook.");
    config.mode = "mock";
    expect(seen.map((o) => o.schemaName)).toEqual(["long_script_audit", "long_story_revision", "long_text_qa", "long_text_verify"]);
    for (const o of seen) {
      expect(o.input).toContain(paulBunyanScripts.long);
      expect(o.input).not.toContain(paulBunyanScripts.short);
      expect(o.input).not.toMatch(/SHORT/);
      expect(JSON.stringify(o.schema)).not.toMatch(/"short"/);
    }
    expect(() => s.readTextQa({ decision: "HUMAN_REVIEW", summary: "x", repairFeedback: null, humanReview: [{ section: "short", reason: "r" }] }, ["story", "hook", "spine", "facts", "long"])).toThrow(/section "short" is unknown/);
    // The pair reader still accepts it, as before.
    expect(s.readTextQa({ decision: "HUMAN_REVIEW", summary: "x", repairFeedback: null, humanReview: [{ section: "short", reason: "r" }] }).humanReview).toHaveLength(1);
  });

  test("the Long Coverage and Editor payloads: the Long's script and slots only", async () => {
    ensureStoryDirs(story.slug);
    const narration = await recordNarration(story.slug, "long", paulBunyanScripts.long);
    const slots = v.planSlots("long", paulBunyanScripts.long, narration);
    const cov = await v.fallbackLongCoverageDirector({ story, research: paulBunyanResearch, script: paulBunyanScripts.long, slots, retained: [] });
    const library = v.validateCoverage("long", cov.longAssets);
    const presentations = v.buildPresentations(library);
    const coverage = v.longCoveragePayload({ story, research: paulBunyanResearch, script: paulBunyanScripts.long, slots, retained: [] });
    const editor = v.longEditorPayload({ story, research: paulBunyanResearch, script: paulBunyanScripts.long, slots, library, presentations });
    for (const p of [coverage, editor]) {
      expect(p).toContain(`LONG SCRIPT:\n${paulBunyanScripts.long}`);
      expect(p).not.toContain(paulBunyanScripts.short);
      expect(p).not.toMatch(/SHORT/);
    }
    expect(coverage).not.toContain("SCREENED ARCHIVE CANDIDATES"); // a new story has none: nothing is invented
    const fallback = await v.fallbackLongEditor({ story, research: paulBunyanResearch, script: paulBunyanScripts.long, slots, library, presentations });
    expect(Object.keys(fallback)).toEqual(["long"]);
  });
});
