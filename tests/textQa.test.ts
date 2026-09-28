import { describe, test, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import type { Story } from "../src/types.ts";

// Automatic Director Text QA (Autopilot v1): one Director review of the saved
// Story Review, at most one automatic repair through the existing revision and
// audit, one read-only verification, then the existing approval path. The
// provider is stubbed per schema, so nothing live runs; research, narration and
// media must never run inside Text QA.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-text-qa-"));
process.env.PROVIDER_MODE = "live";
process.env.OPENAI_API_KEY = "test-key";
process.env.ELEVENLABS_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const h = vi.hoisted(() => ({
  calls: [] as { schemaName: string; input: string; instructions: string }[],
  review: null as any,
  verify: null as any,
  revision: null as any,
  failOn: "" as string,
  hold: null as Promise<void> | null,
  research: 0,
  narration: 0,
  images: 0,
}));

vi.mock("../src/providers/openai.ts", () => ({
  respondJson: vi.fn(async (o: { schemaName: string; input: string; instructions: string }) => {
    h.calls.push(o);
    if (h.hold) await h.hold;
    if (h.failOn === o.schemaName) throw new Error(`OpenAI responses 500: ${o.schemaName} boom`);
    if (o.schemaName === "text_qa") return h.review;
    if (o.schemaName === "text_verify") return h.verify;
    if (o.schemaName === "story_revision") return h.revision;
    if (o.schemaName === "script_audit") return { long: "Audited revised long RL-2.", short: "Audited revised short RS-2." };
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
    throw new Error("narration reached");
  }),
}));
// The manual approve route's requeue is recorded, never run, in this file.
vi.mock("../src/server/worker.ts", () => ({ enqueueJob: vi.fn() }));
vi.mock("../src/production/wikimedia.ts", () => ({ fetchArchive: vi.fn(async () => null) }));
vi.mock("../src/providers/runway.ts", () => ({ generateMotion: vi.fn(async () => {}) }));

const { runJob, newJobId, approveTextForJob, autoTextQaForJob } = await import("../src/production/generate.ts");
const { createJob, getJob, updateJob, upsertStory, getStory, getScripts } = await import("../src/server/store.ts");
const { registerRoutes } = await import("../src/server/routes.ts");
const { config } = await import("../src/server/config.ts");
const { enqueueJob } = await import("../src/server/worker.ts");
const { readTextQa, readTextVerify, TEXT_QA_INSTRUCTIONS, TEXT_VERIFY_INSTRUCTIONS } = await import("../src/production/scripts.ts");
const { buildStoryReviewClipboardText } = await import("../src/app/screens/Creating.tsx");

// A story unrelated to any real production, so nothing depends on one film.
const research = {
  summary: "A lighthouse keeper's ledger ZX-1 records a strange winter.",
  moments: [
    { title: "Spine one SP-1", detail: "spine detail SD-1" },
    { title: "Spine two SP-2", detail: "spine detail SD-2" },
  ],
  sources: [{ title: "Harbour archive HA-7", url: "https://example.org/ha7", note: "ledger scans LS-3" }],
  facts: [
    { fact: "Fact FX-1 is supported.", sourceTitle: "Harbour archive HA-7", sourceUrl: "https://example.org/ha7" },
    { fact: "Fact FX-2 is disputed.", sourceTitle: "Parish record PR-3", sourceUrl: "https://example.org/pr3" },
  ],
  productionNote: "",
  world: { period: "p", place: "q", palette: "r", visualDirection: "s", recurringPeople: [], recurringLocations: [], referenceImages: [] },
};
const scripts = { long: "Current long CL-1.\n\nCurrent long paragraph CL-2.", short: "Current short CS-1." };
const FEEDBACK = "Remove the disputed fact FX-2 from the facts and both scripts.";

let n = 0;
function atTextGate(opts: { approvedMax?: number } = {}): { story: Story; jobId: string } {
  const slug = `text-qa-${n++}`;
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
const publicJob = async (a: any, jobId: string) => (await a.inject({ method: "GET", url: `/api/jobs/${jobId}` })).json().job;
const names = () => h.calls.map((c) => c.schemaName);
const advance = vi.fn();
const qa = (jobId: string) => autoTextQaForJob(jobId, advance);
const PASS = { decision: "PASS", summary: "Clear, sourced and causal.", repairFeedback: null, humanReview: [] };

beforeEach(() => {
  h.calls.length = 0;
  h.failOn = "";
  h.hold = null;
  h.research = h.narration = h.images = 0;
  advance.mockReset();
  h.review = { ...PASS };
  h.verify = { decision: "PASS", summary: "The repair holds.", humanReview: [] };
  h.revision = {
    title: "Revised title RT-6",
    hook: "Revised hook RH-6",
    moments: [{ title: "Revised spine RS-1", detail: "revised detail RD-1" }],
    facts: [{ fact: "Fact FX-1 is supported.", source: 1 }],
    long: "Revised long RL-1.",
    short: "Revised short RS-1.",
  };
});

describe("Automatic Text QA: PASS", () => {
  test("one review of the complete saved Story Review, then the existing approval, with no click", async () => {
    const { jobId } = atTextGate();
    expect(await qa(jobId)).toEqual({ status: "passed" });

    expect(names()).toEqual(["text_qa"]); // no revision, no verification
    const call = h.calls[0];
    for (const s of [
      "TITLE: Current title CT-5",
      "PREMISE / HOOK: Current hook CH-5",
      "YEAR: 1902",
      "PLACE: Somewhere QP-4",
      "A lighthouse keeper's ledger ZX-1 records a strange winter.",
      "1. Spine one SP-1 - spine detail SD-1",
      "2. Spine two SP-2 - spine detail SD-2",
      "1. Harbour archive HA-7 <https://example.org/ha7>\n   Supports: ledger scans LS-3",
      "2. Parish record PR-3 <https://example.org/pr3>",
      "1. Fact FX-1 is supported. [source 1: Harbour archive HA-7]",
      "2. Fact FX-2 is disputed. [source 2: Parish record PR-3]",
      "LONG SCRIPT:\nCurrent long CL-1.\n\nCurrent long paragraph CL-2.",
      "SHORT SCRIPT:\nCurrent short CS-1.",
    ])
      expect(call.input).toContain(s);
    expect(call.input).not.toContain("REPAIR THAT WAS APPLIED");
    expect(call.instructions).toBe(TEXT_QA_INSTRUCTIONS);

    // Approved through approveTextForJob and requeued through `advance`.
    const job = getJob(jobId)!;
    expect(job.state).toBe("queued");
    expect((job.scratch as any).textApproved).toBe(true);
    expect(advance).toHaveBeenCalledOnce();
    expect(advance).toHaveBeenCalledWith(jobId);
    expect(job.spent).toBeCloseTo(1.03); // one script-priced call
    expect(h.research + h.narration + h.images).toBe(0);
  });

  test("the auto-approved job is the manual Approve & continue job, and resumes the same pipeline at narration", async () => {
    const auto = atTextGate();
    const manual = atTextGate();
    await qa(auto.jobId);
    approveTextForJob(manual.jobId);

    const shape = (id: string) => {
      const { id: _id, storyId: _s, createdAt: _c, updatedAt: _u, spent: _sp, scratch, ...rest } = getJob(id)!;
      const { spent: _x, ...s } = scratch as any;
      return { ...rest, scratch: s };
    };
    expect(shape(auto.jobId)).toEqual(shape(manual.jobId));

    // The same continuation: runJob skips research and scripts and starts narration.
    const before = h.calls.length;
    await expect(runJob(auto.jobId)).rejects.toThrow("narration reached");
    await expect(runJob(manual.jobId)).rejects.toThrow("narration reached");
    expect(h.calls.length).toBe(before);
    expect(h.research).toBe(0);
    expect(h.narration).toBe(2);
    for (const id of [auto.jobId, manual.jobId]) expect(getJob(id)!.step).toBe("narration");
  });

  test("the passed job says so while it continues, and the draft is no longer up for review", async () => {
    const { jobId } = atTextGate();
    const a = await app();
    await qa(jobId);
    const job = await publicJob(a, jobId);
    expect(job.state).toBe("queued");
    expect(job.textQa).toEqual({ status: "passed" });
    expect(job.review).toBeUndefined();
    await a.close();
  });
});

describe("Automatic Text QA: REPAIR", () => {
  test("the Director's feedback reaches the existing revision and audit, and the verifier sees the NEW saved draft", async () => {
    const { story, jobId } = atTextGate();
    h.review = { decision: "REPAIR", summary: "One disputed fact.", repairFeedback: FEEDBACK, humanReview: [] };
    expect(await qa(jobId)).toEqual({ status: "passed" });

    expect(names()).toEqual(["text_qa", "story_revision", "script_audit", "text_verify"]);
    const [, revision, audit, verify] = h.calls;
    expect(revision.input).toContain(`DIRECTOR FEEDBACK:\n${FEEDBACK}`);
    expect(revision.input).toContain("1. Harbour archive HA-7 <https://example.org/ha7>"); // the same source pack
    expect(revision.input).toContain("2. Parish record PR-3 <https://example.org/pr3>");
    expect(audit.input).toContain("DRAFT LONG SCRIPT:\nRevised long RL-1.");

    // Built fresh from the saved revision, not the original draft.
    for (const s of ["TITLE: Revised title RT-6", "PREMISE / HOOK: Revised hook RH-6", "1. Revised spine RS-1 - revised detail RD-1", "LONG SCRIPT:\nAudited revised long RL-2.", "SHORT SCRIPT:\nAudited revised short RS-2.", `REPAIR THAT WAS APPLIED:\n${FEEDBACK}`])
      expect(verify.input).toContain(s);
    for (const s of ["Current title CT-5", "Current long CL-1", "Current short CS-1", "Fact FX-2 is disputed", "Spine one SP-1"]) expect(verify.input).not.toContain(s);
    expect(verify.instructions).toBe(TEXT_VERIFY_INSTRUCTIONS);

    expect(getScripts(story.id)).toEqual({ long: "Audited revised long RL-2.", short: "Audited revised short RS-2." });
    const job = getJob(jobId)!;
    expect(job.state).toBe("queued");
    expect((job.scratch as any).textApproved).toBe(true);
    expect(advance).toHaveBeenCalledOnce();
    expect(advance).toHaveBeenCalledWith(jobId);
    expect(job.spent).toBeCloseTo(1.12); // review + revision + audit + verification: the maximum chain
    expect(h.research + h.narration + h.images).toBe(0);
  });

  test("a REPAIR that also lists human issues is HUMAN_REVIEW and never repairs", async () => {
    const { jobId } = atTextGate();
    h.review = { decision: "REPAIR", summary: "Mixed.", repairFeedback: FEEDBACK, humanReview: [{ section: "facts", reason: "Needs new research RR-1." }] };
    const out = await qa(jobId);
    expect(out).toMatchObject({ status: "stopped", stage: "director_review", issues: [{ section: "facts", reason: "Needs new research RR-1." }] });
    expect(names()).toEqual(["text_qa"]);
    expect(getJob(jobId)!.state).toBe("awaiting_text");
  });
});

describe("Automatic Text QA: HUMAN_REVIEW", () => {
  test("an initial HUMAN_REVIEW stops at the Story Review with its issues, and the manual tools still work", async () => {
    const { jobId } = atTextGate();
    const a = await app();
    const before = (await publicJob(a, jobId)).review;
    h.review = { decision: "HUMAN_REVIEW", summary: "The premise needs a decision.", repairFeedback: null, humanReview: [{ section: "hook", reason: "The pack cannot support the hook HK-9." }] };
    await qa(jobId);

    expect(names()).toEqual(["text_qa"]);
    expect(advance).not.toHaveBeenCalled();
    const job = await publicJob(a, jobId);
    expect(job.state).toBe("awaiting_text");
    expect(job.review).toEqual(before);
    expect(job.textQa).toEqual({
      status: "stopped",
      stage: "director_review",
      message: "The Director needs a human decision on this draft.",
      summary: "The premise needs a decision.",
      issues: [{ section: "hook", reason: "The pack cannot support the hook HK-9." }],
    });
    expect((getJob(jobId)!.scratch as any).textApproved).toBeUndefined();

    // Manual Revise and Approve & continue remain the escape hatch.
    const revised = await a.inject({ method: "POST", url: `/api/jobs/${jobId}/revise-text`, payload: { feedback: "Soften the hook." } });
    expect(revised.statusCode).toBe(200);
    expect(h.narration + h.images).toBe(0); // nothing advanced before the human approved
    const approved = await a.inject({ method: "POST", url: `/api/jobs/${jobId}/approve-text` });
    expect(approved.json().job.state).toBe("queued");
    expect(enqueueJob).toHaveBeenCalledWith(jobId);
    await a.close();
  });

  test("final verification HUMAN_REVIEW: no second revision; the revised draft stays at the gate and is the one source of truth", async () => {
    const { jobId } = atTextGate();
    const a = await app();
    h.review = { decision: "REPAIR", summary: "One disputed fact.", repairFeedback: FEEDBACK, humanReview: [] };
    h.verify = { decision: "HUMAN_REVIEW", summary: "The Short still overstates.", humanReview: [{ section: "short", reason: "The Short ends on a weak statistic WS-4." }] };
    await qa(jobId);

    expect(names()).toEqual(["text_qa", "story_revision", "script_audit", "text_verify"]);
    expect(advance).not.toHaveBeenCalled();
    const job = await publicJob(a, jobId);
    expect(job.state).toBe("awaiting_text");
    expect(job.textQa).toMatchObject({ status: "stopped", stage: "final_verify", summary: "The Short still overstates.", feedback: FEEDBACK, issues: [{ section: "short", reason: "The Short ends on a weak statistic WS-4." }] });

    // Story Review, Copy Director Review and the verifier all saw the same revised draft.
    expect(job.review).toMatchObject({ title: "Revised title RT-6", hook: "Revised hook RH-6", longScript: "Audited revised long RL-2.", shortScript: "Audited revised short RS-2." });
    const packet = buildStoryReviewClipboardText(job.review);
    const verify = h.calls[3].input;
    for (const s of ["Revised title RT-6", "Revised hook RH-6", "Audited revised long RL-2.", "Audited revised short RS-2.", "Fact FX-1 is supported."]) {
      expect(packet).toContain(s);
      expect(verify).toContain(s);
    }
    for (const s of ["Current long CL-1", "Fact FX-2 is disputed"]) {
      expect(packet).not.toContain(s);
      expect(verify).not.toContain(s);
    }
    await a.close();
  });
});

describe("Automatic Text QA: failures", () => {
  test("an initial review failure saves nothing new, stays at the gate, logs one line and is not retried", async () => {
    const { story, jobId } = atTextGate();
    const a = await app();
    const before = (await publicJob(a, jobId)).review;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    h.failOn = "text_qa";
    await qa(jobId);

    expect(names()).toEqual(["text_qa"]);
    const job = await publicJob(a, jobId);
    expect(job.state).toBe("awaiting_text");
    expect(job.review).toEqual(before);
    expect(job.spent).toBe(1); // a failed call is not charged
    expect(getScripts(story.id)).toBeNull();
    expect(getStory(story.id)!.title).toBe("Current title CT-5");
    expect(job.textQa).toMatchObject({ status: "stopped", stage: "director_review", message: "Text QA could not complete. Review the current draft manually.", error: "OpenAI responses 500: text_qa boom" });
    expect(advance).not.toHaveBeenCalled();

    expect(logged).toHaveBeenCalledOnce();
    expect(logged.mock.calls[0]).toEqual([`Text QA failed job=${jobId} stage=director_review error=OpenAI responses 500: text_qa boom`]);
    logged.mockRestore();
    await a.close();
  });

  test("a malformed review answer is a review failure", async () => {
    const { jobId } = atTextGate();
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.review = { decision: "REPAIR", summary: "x", repairFeedback: "   ", humanReview: [] };
    expect(await qa(jobId)).toMatchObject({ status: "stopped", stage: "director_review" });
    expect(names()).toEqual(["text_qa"]);
    vi.mocked(console.error).mockRestore();
  });

  test("a revision failure keeps the old draft, shows the existing revision error and does not verify", async () => {
    const { jobId } = atTextGate();
    const a = await app();
    const before = (await publicJob(a, jobId)).review;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    h.review = { decision: "REPAIR", summary: "One disputed fact.", repairFeedback: FEEDBACK, humanReview: [] };
    h.revision.facts = [{ fact: "A new claim NC-1.", source: 3 }]; // the pack has 2 sources
    await qa(jobId);

    expect(names()).toEqual(["text_qa", "story_revision"]); // no audit, no verification, no retry
    const job = await publicJob(a, jobId);
    expect(job.state).toBe("awaiting_text");
    expect(job.review).toEqual(before);
    expect(job.textQa).toMatchObject({
      status: "stopped",
      stage: "revision",
      feedback: FEEDBACK,
      error: "Revision referenced source 3, but valid source numbers are 1-2. The current story is unchanged.",
    });
    expect(logged.mock.calls[0]).toEqual([`Text QA failed job=${jobId} stage=revision error=Revision referenced source 3, but valid source numbers are 1-2. The current story is unchanged.`]);
    for (const secret of [FEEDBACK, "Current long CL-1", "Harbour archive", "test-key"]) expect(String(logged.mock.calls[0][0])).not.toContain(secret);
    logged.mockRestore();
    await a.close();
  });

  test("a final verification failure keeps the revised draft at the gate, unapproved, with no retry", async () => {
    const { jobId } = atTextGate();
    const a = await app();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    h.review = { decision: "REPAIR", summary: "One disputed fact.", repairFeedback: FEEDBACK, humanReview: [] };
    h.failOn = "text_verify";
    await qa(jobId);

    expect(names()).toEqual(["text_qa", "story_revision", "script_audit", "text_verify"]);
    const job = await publicJob(a, jobId);
    expect(job.state).toBe("awaiting_text");
    expect(job.review.longScript).toBe("Audited revised long RL-2.");
    expect(job.textQa).toMatchObject({ status: "stopped", stage: "final_verify", message: "Text repair completed, but final verification failed. Review the current draft manually." });
    expect((getJob(jobId)!.scratch as any).textApproved).toBeUndefined();
    expect(logged.mock.calls[0][0]).toContain("stage=final_verify");

    // A verifier that tries to REPAIR is a failed verification, never a second revision.
    logged.mockClear();
    const other = atTextGate();
    h.calls.length = 0;
    h.failOn = "";
    h.verify = { decision: "REPAIR", summary: "More.", humanReview: [] };
    expect(await qa(other.jobId)).toMatchObject({ status: "stopped", stage: "final_verify", error: expect.stringContaining("Invalid Director text verification") });
    expect(names()).toEqual(["text_qa", "story_revision", "script_audit", "text_verify"]);
    logged.mockRestore();
    await a.close();
  });
});

describe("Automatic Text QA: concurrency", () => {
  test("manual Approve and Revise are refused while Text QA runs, and a second run never starts", async () => {
    const { story, jobId } = atTextGate();
    const a = await app();
    let release!: () => void;
    h.hold = new Promise<void>((r) => (release = r));
    const running = qa(jobId);

    expect((await publicJob(a, jobId)).textQa).toEqual({ status: "running", phase: "review" });
    const approve = await a.inject({ method: "POST", url: `/api/jobs/${jobId}/approve-text` });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error).toBe("Automatic Text QA is running. Wait for it to finish.");
    const revise = await a.inject({ method: "POST", url: `/api/jobs/${jobId}/revise-text`, payload: { feedback: "Fix it." } });
    expect(revise.statusCode).toBe(409);
    expect(await autoTextQaForJob(jobId, advance)).toBeUndefined();
    const generate = await a.inject({ method: "POST", url: `/api/stories/${story.id}/generate`, payload: { approvedMax: 15 } });
    expect(generate.json()).toMatchObject({ duplicate: true, job: { id: jobId } });

    release();
    await running;
    expect(names()).toEqual(["text_qa"]);
    expect(getJob(jobId)!.state).toBe("queued");
    expect(advance).toHaveBeenCalledOnce();
    await a.close();
  });
});

describe("Automatic Text QA: cost", () => {
  test("the spend cap blocks before a prohibited call and stops at the gate", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const noReview = atTextGate({ approvedMax: 1.02 }); // spent 1 + one script call would exceed it
    expect(await qa(noReview.jobId)).toMatchObject({ status: "stopped", stage: "director_review", error: expect.stringContaining("Approved maximum") });
    expect(h.calls).toEqual([]);

    h.review = { decision: "REPAIR", summary: "One disputed fact.", repairFeedback: FEEDBACK, humanReview: [] };
    const noRepair = atTextGate({ approvedMax: 1.03 }); // the review fits; the revision does not
    expect(await qa(noRepair.jobId)).toMatchObject({ status: "stopped", stage: "revision", error: expect.stringContaining("Approved maximum") });
    expect(names()).toEqual(["text_qa"]);
    for (const id of [noReview.jobId, noRepair.jobId]) expect(getJob(id)!.state).toBe("awaiting_text");
    expect(advance).not.toHaveBeenCalled();
    vi.mocked(console.error).mockRestore();
  });

  test("mock mode makes no provider call and passes through the same approval", async () => {
    const { jobId } = atTextGate();
    config.mode = "mock";
    try {
      expect(await qa(jobId)).toEqual({ status: "passed" });
    } finally {
      config.mode = "live";
    }
    expect(h.calls).toEqual([]);
    expect(getJob(jobId)!.state).toBe("queued");
    expect(getJob(jobId)!.spent).toBe(1);
  });

  test("Text QA runs only for a NEW draft reaching the gate", async () => {
    const { jobId } = atTextGate();
    expect(await runJob(jobId)).toBeUndefined(); // an existing draft at the gate
    expect(getJob(jobId)!.state).toBe("awaiting_text");
    expect(h.calls).toEqual([]);
  });
});

describe("Director text answers", () => {
  test("any human issue makes the decision HUMAN_REVIEW; malformed answers are rejected whole", () => {
    expect(readTextQa({ decision: "PASS", summary: "s", repairFeedback: null, humanReview: [{ section: "long", reason: "r" }] }).decision).toBe("HUMAN_REVIEW");
    expect(readTextQa({ decision: "PASS", summary: "s", repairFeedback: "ignored", humanReview: [] })).toEqual({ decision: "PASS", summary: "s", repairFeedback: null, humanReview: [] });
    expect(readTextQa({ decision: "REPAIR", summary: "s", repairFeedback: " Fix it. ", humanReview: [] }).repairFeedback).toBe("Fix it.");
    expect(() => readTextQa({ decision: "REPAIR", summary: "s", repairFeedback: null, humanReview: [] })).toThrow("Invalid Director text review");
    expect(() => readTextQa({ decision: "MAYBE", summary: "s", repairFeedback: null, humanReview: [] })).toThrow("Invalid Director text review");
    expect(() => readTextQa({ decision: "HUMAN_REVIEW", summary: "s", repairFeedback: null, humanReview: [{ section: "visuals", reason: "r" }] })).toThrow("Invalid Director text review");
    expect(readTextVerify({ decision: "PASS", summary: "s", humanReview: [{ section: "facts", reason: "r" }] }).decision).toBe("HUMAN_REVIEW");
    expect(() => readTextVerify({ decision: "REPAIR", summary: "s", humanReview: [] })).toThrow("Invalid Director text verification");
  });

  test("the review asks the Dagen H rubric and only one repair; the verifier may not repair", () => {
    for (const s of ["A. PREMISE", "B. STORY STRUCTURE", "C. FACTUAL LANGUAGE", "D. SPECIFICITY AND WRITING QUALITY", "E. SHORT", "F. LONG VIABILITY", "advisory result into something legally stronger", "collapse different dates or events", "Only one automatic revision will happen", "Never combine REPAIR and HUMAN_REVIEW"])
      expect(TEXT_QA_INSTRUCTIONS).toContain(s);
    expect(TEXT_VERIFY_INSTRUCTIONS).toContain("You may NOT repair");
    expect(TEXT_VERIFY_INSTRUCTIONS).toContain("there will be no second revision");
    for (const text of [TEXT_QA_INSTRUCTIONS, TEXT_VERIFY_INSTRUCTIONS]) expect(text).not.toMatch(/[â€“â€”]/);
  });
});
