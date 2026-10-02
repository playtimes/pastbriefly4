import { describe, test, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import type { Story } from "../src/types.ts";

// Director revision at the text gate: one bounded revision call plus the existing
// script audit, grounded in the job's current draft. The provider is stubbed per
// schema, so nothing live runs; research, narration and media must never run.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-director-revision-"));
process.env.PROVIDER_MODE = "live";
process.env.OPENAI_API_KEY = "test-key";
process.env.ELEVENLABS_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const h = vi.hoisted(() => ({
  calls: [] as { schemaName: string; input: string; instructions: string }[],
  revision: null as any,
  fail: "" as string,
  research: 0,
  narration: 0,
  images: 0,
}));

vi.mock("../src/providers/openai.ts", () => ({
  respondJson: vi.fn(async (o: { schemaName: string; input: string; instructions: string }) => {
    h.calls.push(o);
    if (h.fail) throw new Error(h.fail);
    if (o.schemaName === "story_revision") return h.revision;
    if (o.schemaName === "script_audit") return { long: "Audited revised long RL-2.", short: "Audited revised short RS-2." };
    // A successful manual revision re-runs Text QA on the new draft: it passes here.
    if (o.schemaName === "text_qa") return { decision: "PASS", summary: "Clear.", repairFeedback: null, humanReview: [] };
    throw new Error(`unexpected provider call ${o.schemaName}`);
  }),
  imageMimeType: () => "image/png",
  generateImageFile: vi.fn(async () => {
    h.images++;
  }),
}));
vi.mock("../src/production/research.ts", () => ({
  researchStory: vi.fn(async () => {
    h.research++;
    throw new Error("research must not run");
  }),
  findStories: vi.fn(),
  recheckStory: vi.fn(),
}));
vi.mock("../src/production/narration.ts", () => ({
  recordNarration: vi.fn(async () => {
    h.narration++;
    throw new Error("narration must not run");
  }),
}));
vi.mock("../src/production/wikimedia.ts", () => ({ fetchArchive: vi.fn(async () => null) }));
vi.mock("../src/providers/runway.ts", () => ({ generateMotion: vi.fn(async () => {}) }));

const { runJob, newJobId, textQaState } = await import("../src/production/generate.ts");
const { createJob, getJob, updateJob, upsertStory, getStory, getScripts } = await import("../src/server/store.ts");
const { registerRoutes } = await import("../src/server/routes.ts");

// A story unrelated to any real production, so nothing depends on one film.
const research = {
  summary: "A lighthouse keeper's ledger ZX-1 records a strange winter.",
  moments: [
    { title: "Spine one SP-1", detail: "spine detail SD-1" },
    { title: "Spine two SP-2", detail: "spine detail SD-2" },
  ],
  sources: [{ title: "Harbour archive HA-7", url: "https://example.org/ha7", note: "ledger scans" }],
  facts: [
    { fact: "Fact FX-1 is supported.", sourceTitle: "Harbour archive HA-7", sourceUrl: "https://example.org/ha7" },
    { fact: "Fact FX-2 is disputed.", sourceTitle: "Parish record PR-3", sourceUrl: "https://example.org/pr3" },
  ],
  productionNote: "",
  world: { period: "p", place: "q", palette: "r", visualDirection: "s", recurringPeople: [], recurringLocations: [], referenceImages: [] },
};
const scripts = { long: "Current long CL-1.\n\nCurrent long paragraph CL-2.", short: "Current short CS-1." };

let n = 0;
function atTextGate(opts: { approvedMax?: number } = {}): { story: Story; jobId: string } {
  const slug = `director-revision-${n++}`;
  const story: Story = {
    id: slug,
    slug,
    title: "Current title CT-5",
    hook: "Current hook CH-5",
    category: "Strange Everyday History",
    year: "1902",
    place: "Somewhere QP-4",
    summary: research.summary,
    heroImage: null,
    moments: [],
    sources: [],
    productionNote: "",
    createdAt: new Date().toISOString(),
  };
  upsertStory(story);
  const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: opts.approvedMax ?? 15 });
  updateJob(job.id, { state: "awaiting_text", step: "scripts", message: "Ready for story review", scratch: { research: structuredClone(research), scripts: { ...scripts }, spent: 1 }, spent: 1 });
  return { story, jobId: job.id };
}

async function app() {
  const a = Fastify();
  await registerRoutes(a);
  return a;
}
const revise = (a: any, jobId: string, feedback: unknown) => a.inject({ method: "POST", url: `/api/jobs/${jobId}/revise-text`, payload: { feedback } });
const review = async (a: any, jobId: string) => (await a.inject({ method: "GET", url: `/api/jobs/${jobId}` })).json().job.review;
// The Text QA a successful revision starts runs in the background: wait for it.
const settled = async (jobId: string) => {
  for (let i = 0; i < 200 && textQaState(jobId)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 5));
};

beforeEach(() => {
  h.calls.length = 0;
  h.fail = "";
  h.research = h.narration = h.images = 0;
  h.revision = {
    title: "Revised title RT-6",
    hook: "Revised hook RH-6",
    moments: [{ title: "Revised spine RS-1", detail: "revised detail RD-1" }],
    facts: [{ fact: "Fact FX-1 is supported.", source: 1 }], // FX-2 removed, per the feedback
    long: "Revised long RL-1.",
    short: "Revised short RS-1.",
  };
});

describe("director revision", () => {
  test("the revision is grounded in the current draft and the pasted feedback", async () => {
    const { jobId } = atTextGate();
    const a = await app();
    const res = await revise(a, jobId, "  Remove the disputed fact FX-2 and tighten the opening.  ");
    expect(res.statusCode).toBe(200);
    await settled(jobId);

    const call = h.calls.find((c) => c.schemaName === "story_revision")!;
    for (const s of [
      "Current title CT-5",
      "Current hook CH-5",
      "Spine one SP-1 - spine detail SD-1",
      "Spine two SP-2 - spine detail SD-2",
      "Fact FX-1 is supported. [source 1]",
      "Fact FX-2 is disputed. [source 2]",
      "1. Harbour archive HA-7 <https://example.org/ha7>",
      "2. Parish record PR-3 <https://example.org/pr3>",
      "Current long CL-1.\n\nCurrent long paragraph CL-2.",
      "Current short CS-1.",
      "DIRECTOR FEEDBACK:\nRemove the disputed fact FX-2 and tighten the opening.",
    ])
      expect(call.input).toContain(s);
    expect(call.instructions).toContain("revising an existing PastBriefly story at its human text gate");
    expect(call.instructions).toContain("Do not invent unsupported facts.");
    expect(call.input).not.toMatch(/Dagen H|Sweden/);
    await a.close();
  });

  test("success: the revised, audited draft replaces the review and the job stays at the text gate", async () => {
    const { story, jobId } = atTextGate();
    const a = await app();
    const res = await revise(a, jobId, "Remove FX-2.");
    expect(res.statusCode).toBe(200);
    const job = res.json().job;
    expect(job.state).toBe("awaiting_text");
    // The old Text QA result is gone; the new draft is being checked.
    expect(job.textQa).toEqual({ status: "running", phase: "review" });
    await settled(jobId);

    // The revision plus the existing audit, the audit seeing the revised facts;
    // then Text QA again, on the NEW saved draft.
    expect(h.calls.map((c) => c.schemaName)).toEqual(["story_revision", "script_audit", "text_qa"]);
    expect(h.calls[2].input).toContain("LONG SCRIPT:\nAudited revised long RL-2.");
    const audit = h.calls[1].input;
    expect(audit).toContain("TITLE: Revised title RT-6");
    expect(audit).toContain("DRAFT LONG SCRIPT:\nRevised long RL-1.");
    expect(audit).not.toContain("Fact FX-2");

    expect(job.review).toEqual({
      title: "Revised title RT-6",
      hook: "Revised hook RH-6",
      moments: [{ title: "Revised spine RS-1", detail: "revised detail RD-1" }],
      facts: [{ fact: "Fact FX-1 is supported.", sourceTitle: "Harbour archive HA-7", sourceUrl: "https://example.org/ha7" }],
      sources: research.sources, // the source pack is never replaced
      longScript: "Audited revised long RL-2.",
      shortScript: "Audited revised short RS-2.",
    });
    expect(await review(a, jobId)).toEqual(job.review); // persisted, not just returned
    expect(getScripts(story.id)).toEqual({ long: "Audited revised long RL-2.", short: "Audited revised short RS-2." });
    expect(getStory(story.id)!.title).toBe("Revised title RT-6");

    // Charged like three script calls (revision, audit, the new draft's Text QA
    // review), never approved, nothing else ran.
    const rec = getJob(jobId)!;
    expect(rec.spent).toBeCloseTo(1.09);
    expect((rec.scratch as any).textApproved).toBeUndefined();
    expect(h.research + h.narration + h.images).toBe(0);
    await a.close();
  });

  test("revision is not approval: the pipeline still waits at the text gate afterwards", async () => {
    const { jobId } = atTextGate();
    const a = await app();
    await revise(a, jobId, "Remove FX-2.");
    await settled(jobId);
    await runJob(jobId);
    expect(getJob(jobId)!.state).toBe("awaiting_text");
    expect(h.narration + h.images).toBe(0);
    await a.close();
  });

  test("a provider failure leaves the draft intact at the text gate", async () => {
    const { story, jobId } = atTextGate();
    const a = await app();
    const before = await review(a, jobId);
    h.fail = "OpenAI responses 500: boom";
    const res = await revise(a, jobId, "Tighten the opening.");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("OpenAI responses 500");
    expect(await review(a, jobId)).toEqual(before);
    expect(getJob(jobId)!.state).toBe("awaiting_text");
    expect(getJob(jobId)!.spent).toBe(1); // a failed call is not charged
    expect(getScripts(story.id)).toBeNull();
    expect(getStory(story.id)!.title).toBe("Current title CT-5");
    await a.close();
  });

  test("a revision citing a source outside the pack is rejected and changes nothing", async () => {
    const { jobId } = atTextGate();
    const a = await app();
    const before = await review(a, jobId);
    h.revision.facts = [{ fact: "A new claim NC-1.", source: 3 }]; // the pack has 2 sources
    const res = await revise(a, jobId, "Add more.");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Revision referenced source 3, but valid source numbers are 1-2.");
    expect(h.calls.map((c) => c.schemaName)).toEqual(["story_revision"]); // no audit
    expect(await review(a, jobId)).toEqual(before);
    await a.close();
  });

  test("blank feedback, the wrong state and the budget cap all refuse before any provider call", async () => {
    const a = await app();
    const { jobId } = atTextGate();
    for (const f of ["", "   \n ", 42]) {
      const res = await revise(a, jobId, f);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Director feedback is required.");
    }
    const tooLong = await revise(a, jobId, "z".repeat(20001));
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error).toBe("Director feedback must be 20,000 characters or fewer.");

    const other = atTextGate();
    updateJob(other.jobId, { state: "awaiting_preview" });
    expect((await revise(a, other.jobId, "Fix it.")).statusCode).toBe(409);

    const capped = atTextGate({ approvedMax: 1.01 }); // spent 1 + one script call would exceed it
    const res = await revise(a, capped.jobId, "Fix it.");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Approved maximum");
    expect(getJob(capped.jobId)!.state).toBe("awaiting_text");

    expect(h.calls).toEqual([]);
    await a.close();
  });

  test("a failed revision leaves one diagnostic line: job, feedback length and error only", async () => {
    const { jobId } = atTextGate();
    const a = await app();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    h.revision.facts = [{ fact: "A new claim NC-1.", source: 0 }];
    const feedback = "Secret director note SN-77 about the opening.";
    const res = await revise(a, jobId, `  ${feedback}  `);
    expect(res.statusCode).toBe(400);
    expect(logged).toHaveBeenCalledOnce();
    const line = String(logged.mock.calls[0][0]);
    expect(logged.mock.calls[0]).toHaveLength(1);
    expect(line).toBe(
      `Director revision failed job=${jobId} feedbackLength=${feedback.length} error=Revision referenced source 0, but valid source numbers are 1-2. The current story is unchanged.`,
    );
    for (const secret of ["SN-77", "Current long CL-1", "Harbour archive", "test-key"]) expect(line).not.toContain(secret);

    // A successful revision and a validation refusal log nothing.
    logged.mockClear();
    h.revision.facts = [{ fact: "Fact FX-1 is supported.", source: 1 }];
    expect((await revise(a, jobId, "Tighten it.")).statusCode).toBe(200);
    await settled(jobId);
    expect((await revise(a, jobId, "")).statusCode).toBe(400);
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
    await a.close();
  });
});
