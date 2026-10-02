import { describe, test, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import type { Story } from "../src/types.ts";

// Research more at the human text gate: the Director's "the story is good, the
// evidence is too thin". One targeted research refresh of the CURRENT verified
// package (expansion, the integrity audit, the final verification), a new draft
// written from it by the normal writer and fidelity audit, saved only when all of
// it succeeded, then the old Text QA result cleared and the new draft checked.
// The job stays awaiting_text and unapproved throughout. Every provider is a
// stub that records what it was asked; nothing live runs.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-research-more-"));
process.env.PROVIDER_MODE = "live";
process.env.OPENAI_API_KEY = "test-key";
process.env.ELEVENLABS_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const h = vi.hoisted(() => ({
  calls: [] as { schemaName: string; input: string; instructions: string; webSearch?: boolean }[],
  failOn: "" as string,
  hold: null as Promise<void> | null,
  narration: 0,
  images: 0,
}));

const pkg = (tag: string) => ({
  summary: `${tag} summary of the escape.`,
  moments: [
    { title: `${tag} moment one`, detail: `${tag} detail one` },
    { title: `${tag} moment two`, detail: `${tag} detail two` },
  ],
  sources: [{ title: `${tag} institutional source`, url: `https://example.org/${tag}`, note: `${tag} supports the route` }],
  facts: [{ fact: `${tag} fact: the ship left on 6 March.`, sourceTitle: `${tag} institutional source`, sourceUrl: `https://example.org/${tag}` }],
  productionNote: `${tag} production note`,
  world: { period: "1942", place: "Java", palette: "p", visualDirection: "v", recurringPeople: [], recurringLocations: [], referenceImages: [] },
});
const OLD = pkg("OLD-0");

vi.mock("../src/providers/openai.ts", () => ({
  respondJson: vi.fn(async (o: { schemaName: string; input: string; instructions: string; webSearch?: boolean }) => {
    h.calls.push(o);
    if (o.schemaName === "research_more" && h.hold) await h.hold;
    if (h.failOn === o.schemaName) throw new Error(`OpenAI responses 500: ${o.schemaName} boom`);
    switch (o.schemaName) {
      case "research_more":
        return pkg("EXPANDED-1");
      case "research_audit":
        return pkg("AUDITED-2");
      case "research_verify":
        return pkg("VERIFIED-3");
      case "script":
        return { script: /SHORT/i.test(o.instructions.slice(0, 60)) ? "New short draft NS-1." : "New long draft NL-1." };
      case "long_script_audit":
        return { long: "Audited new long NL-2." };
      case "script_audit":
        return { long: "Audited new long NL-2.", short: "Audited new short NS-2." };
      case "long_text_qa":
      case "text_qa":
        return { decision: "PASS", summary: "Clear.", repairFeedback: null, humanReview: [] };
      default:
        throw new Error(`unexpected provider call ${o.schemaName}`);
    }
  }),
  imageMimeType: () => "image/png",
  generateImageFile: vi.fn(async () => void h.images++),
}));
vi.mock("../src/production/narration.ts", () => ({ recordNarration: vi.fn(async () => (h.narration++, Promise.reject(new Error("narration reached")))) }));
vi.mock("../src/server/worker.ts", () => ({ enqueueJob: vi.fn() }));
vi.mock("../src/production/wikimedia.ts", () => ({ fetchArchive: vi.fn(async () => null) }));
vi.mock("../src/providers/runway.ts", () => ({ generateMotion: vi.fn(async () => {}) }));

const g = await import("../src/production/generate.ts");
const { createJob, getJob, updateJob, upsertStory, getStory, getScripts, setScripts } = await import("../src/server/store.ts");
const { registerRoutes } = await import("../src/server/routes.ts");
const { enqueueJob } = await import("../src/server/worker.ts");
const { PRICING, round } = await import("../src/server/pricing.ts");
const { researchStoryMore } = await import("../src/production/research.ts");

const FEEDBACK = "Expand the escape chronology: the evacuation order, the other minesweepers' failed escapes, crew composition and the route, from institutional sources.";
const OLD_LONG = "Old long OL-1 about the island disguise.";
const OLD_SHORT = "Old short OS-1.";

let n = 0;
// A job at the text gate with the old draft, its old research and a settled
// (passed) Text QA result, as the Director finds it.
async function atTextGate(flow: boolean, opts: { spent?: number; approvedMax?: number } = {}) {
  const slug = `research-more-${n++}`;
  const story: Story = {
    id: slug,
    slug,
    title: "The Warship That Disguised Itself as an Island",
    hook: "Director hook DH-1.",
    category: "Escapes & Operations",
    year: "1942",
    place: "Java",
    summary: OLD.summary,
    heroImage: null,
    moments: OLD.moments,
    sources: OLD.sources,
    productionNote: OLD.productionNote,
    createdAt: new Date().toISOString(),
  };
  upsertStory(story);
  const job = createJob({ id: g.newJobId(), storyId: story.id, mock: false, estimatedCost: 9.39, approvedMax: opts.approvedMax ?? 9.39, ...(flow ? { scratch: { flow: "long-first" } } : {}) });
  const scripts = flow ? { long: OLD_LONG } : { long: OLD_LONG, short: OLD_SHORT };
  const spent = opts.spent ?? 0.45;
  updateJob(job.id, { state: "awaiting_text", step: "scripts", message: "Ready for story review", spent, scratch: { ...job.scratch, research: structuredClone(OLD), scriptParts: { ...scripts }, scripts: { ...scripts }, spent } as any });
  setScripts(story.id, scripts);
  expect(await g.autoTextQaForJob(job.id)).toEqual({ status: "passed" }); // the settled result the Director saw
  h.calls.length = 0;
  return { story, jobId: job.id, base: getJob(job.id)!.spent }; // the spend before Research more (that QA review included)
}

async function app() {
  const a = Fastify();
  await registerRoutes(a);
  return a;
}
const researchMore = (a: any, jobId: string, feedback: unknown = FEEDBACK) => a.inject({ method: "POST", url: `/api/jobs/${jobId}/research-more`, payload: { feedback } });
const publicJob = async (a: any, jobId: string) => (await a.inject({ method: "GET", url: `/api/jobs/${jobId}` })).json().job;
const names = () => h.calls.map((c) => c.schemaName);
const scratchOf = (id: string) => getJob(id)!.scratch as any;
const settled = async (jobId: string) => {
  for (let i = 0; i < 200 && (g.textQaState(jobId)?.status === "running" || g.isResearchingMore(jobId)); i++) await new Promise((r) => setTimeout(r, 5));
};

beforeEach(() => {
  h.calls.length = 0;
  h.failOn = "";
  h.hold = null;
  h.narration = h.images = 0;
  vi.mocked(enqueueJob).mockClear();
});

describe("Research more: a Long-first job", () => {
  test("1, 3, 6. the same job gets verified new research and a new Long written from it, the old QA result is cleared and the new draft checked; nothing advances", async () => {
    const { story, jobId, base } = await atTextGate(true);
    const a = await app();
    const res = await researchMore(a, jobId);
    expect(res.statusCode).toBe(200);
    expect(res.json().job).toMatchObject({ id: jobId, flow: "long-first", state: "awaiting_text", textQa: { status: "running", phase: "review" } });
    await settled(jobId);

    // Three research passes BEFORE any script work, then the Long-only write and
    // audit, then the fresh Long-only Text QA.
    expect(names()).toEqual(["research_more", "research_audit", "research_verify", "script", "long_script_audit", "long_text_qa"]);
    const [, audit, verify, write, longAudit, qa] = h.calls;
    expect(audit.input).toContain("EXPANDED-1 summary"); // the audit checks the expansion
    expect(verify.input).toContain("AUDITED-2 summary"); // the verification checks the audit
    expect(write.instructions).toContain("long-form script director");
    expect(write.input).toContain("VERIFIED-3 summary");
    expect(write.input).toContain("VERIFIED-3 fact: the ship left on 6 March.");
    expect(write.input).not.toContain("OLD-0");
    expect(longAudit.input).toContain("DRAFT LONG SCRIPT:\nNew long draft NL-1.");
    expect(longAudit.input).not.toMatch(/SHORT/);
    // The fresh Text QA sees the NEW research and the NEW Long, never the old ones.
    expect(qa.input).toContain("VERIFIED-3 summary");
    expect(qa.input).toContain("LONG SCRIPT:\nAudited new long NL-2.");
    for (const old of ["OLD-0", OLD_LONG]) expect(qa.input).not.toContain(old);

    // Saved together: the job's research, draft parts and scripts; the story.
    const s = scratchOf(jobId);
    expect(s.flow).toBe("long-first");
    expect(s.research).toEqual(pkg("VERIFIED-3"));
    expect(s.scripts).toEqual({ long: "Audited new long NL-2." });
    expect(s.scriptParts).toEqual({ long: "New long draft NL-1." }); // the old draft parts are gone
    expect(JSON.stringify(s)).not.toMatch(/"short|Short"|OLD-0|Old long/);
    expect(getScripts(story.id)).toEqual({ long: "Audited new long NL-2." });
    const st = getStory(story.id)!;
    expect(st).toMatchObject({ summary: "VERIFIED-3 summary of the escape.", moments: pkg("VERIFIED-3").moments, sources: pkg("VERIFIED-3").sources, productionNote: "VERIFIED-3 production note" });
    expect(st).toMatchObject({ id: story.id, slug: story.slug, title: "The Warship That Disguised Itself as an Island", hook: "Director hook DH-1.", category: story.category, year: "1942", place: "Java" });

    // Still the human gate: passed, unapproved, not requeued, no narration or media.
    const job = await publicJob(a, jobId);
    expect(job).toMatchObject({ id: jobId, state: "awaiting_text", textQa: { status: "passed" }, review: { title: "The Warship That Disguised Itself as an Island", longScript: "Audited new long NL-2." } });
    expect("shortScript" in job.review).toBe(false);
    expect(s.textApproved).toBeUndefined();
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(h.narration + h.images).toBe(0);
    // The existing prices: one research package, the Long write, its audit, the fresh Text QA review.
    expect(getJob(jobId)!.spent).toBe(round(base + PRICING.openai.research + 3 * PRICING.openai.script));
    await a.close();
  });

  test("2. the targeted search gets the CURRENT verified package and the Director's request, with web search, as a research question rather than evidence", async () => {
    const { story } = await atTextGate(true);
    const out = await researchStoryMore(getStory(story.id)!, structuredClone(OLD), FEEDBACK);
    expect(out).toEqual(pkg("VERIFIED-3"));
    const [first, audit, verify] = h.calls;
    expect([first.schemaName, audit.schemaName, verify.schemaName]).toEqual(["research_more", "research_audit", "research_verify"]);
    expect(h.calls.every((c) => c.webSearch === true)).toBe(true);
    expect(first.input).toContain("CURRENT VERIFIED RESEARCH PACKAGE:");
    for (const s of ["OLD-0 summary of the escape.", "OLD-0 moment one", "OLD-0 fact: the ship left on 6 March.", "https://example.org/OLD-0", "OLD-0 production note"]) expect(first.input).toContain(s);
    expect(first.input).toContain(`DIRECTOR RESEARCH REQUEST (a research question and priority - NOT evidence):\n${FEEDBACK}`);
    expect(first.input).toContain("STORY: The Warship That Disguised Itself as an Island");
    expect(first.instructions).toContain("expanding an existing VERIFIED PastBriefly research package");
    expect(first.instructions).toContain("never evidence");
    // researchStoryMore saves nothing: the caller decides.
    expect(getStory(story.id)!.summary).toBe(OLD.summary);
  });
});

describe("Research more: failures leave the current draft authoritative", () => {
  test("4. a failure inside the research (here the audit) changes nothing: research, draft, story and Text QA result stay; no script work; nothing charged", async () => {
    const { story, jobId, base } = await atTextGate(true);
    const a = await app();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    h.failOn = "research_audit";
    const res = await researchMore(a, jobId);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("research_audit boom");
    await settled(jobId);
    expect(names()).toEqual(["research_more", "research_audit"]); // no verification, no script work
    const s = scratchOf(jobId);
    expect(s.research).toEqual(OLD);
    expect(s.scripts).toEqual({ long: OLD_LONG });
    expect(s.scriptParts).toEqual({ long: OLD_LONG });
    expect(getScripts(story.id)).toEqual({ long: OLD_LONG });
    expect(getStory(story.id)!.summary).toBe(OLD.summary);
    expect(await publicJob(a, jobId)).toMatchObject({ state: "awaiting_text", textQa: { status: "passed" }, review: { longScript: OLD_LONG } });
    expect(getJob(jobId)!.spent).toBe(base); // the research package never completed: not charged
    expect(h.narration + h.images).toBe(0);
    expect(logged.mock.calls[0][0]).toBe(`Research more failed job=${jobId} feedbackLength=${FEEDBACK.length} error=OpenAI responses 500: research_audit boom`);
    logged.mockRestore();
    await a.close();
  });

  test("5. a failure after the research (the Long audit) saves no mixture: the old research and draft stay; completed calls stay charged", async () => {
    const { story, jobId, base } = await atTextGate(true);
    const a = await app();
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.failOn = "long_script_audit";
    expect((await researchMore(a, jobId)).statusCode).toBe(400);
    await settled(jobId);
    expect(names()).toEqual(["research_more", "research_audit", "research_verify", "script", "long_script_audit"]); // no Text QA
    const s = scratchOf(jobId);
    expect(s.research).toEqual(OLD); // not the new research with the old script
    expect(s.scripts).toEqual({ long: OLD_LONG });
    expect(s.scriptParts).toEqual({ long: OLD_LONG });
    expect(getScripts(story.id)).toEqual({ long: OLD_LONG });
    expect(getStory(story.id)).toMatchObject({ summary: OLD.summary, productionNote: OLD.productionNote });
    expect(await publicJob(a, jobId)).toMatchObject({ state: "awaiting_text", textQa: { status: "passed" } });
    expect(getJob(jobId)!.spent).toBe(round(base + PRICING.openai.research + PRICING.openai.script)); // the completed research and write
    expect(h.narration + h.images).toBe(0);
    vi.mocked(console.error).mockRestore();
    await a.close();
  });
});

describe("Research more: one text-gate action at a time", () => {
  test("7. while it runs, Approve, Revise, another Research more and Text QA are all refused; afterwards the gate works as usual", async () => {
    const { jobId } = await atTextGate(true);
    const a = await app();
    let release!: () => void;
    h.hold = new Promise<void>((r) => (release = r));
    const running = researchMore(a, jobId);
    for (let i = 0; i < 100 && !g.isResearchingMore(jobId); i++) await new Promise((r) => setTimeout(r, 5));
    expect(g.isResearchingMore(jobId)).toBe(true);

    const busy = "More research is running for this story. Wait for it to finish.";
    const approve = await a.inject({ method: "POST", url: `/api/jobs/${jobId}/approve-text` });
    expect([approve.statusCode, approve.json().error]).toEqual([409, busy]);
    const revise = await a.inject({ method: "POST", url: `/api/jobs/${jobId}/revise-text`, payload: { feedback: "Fix it." } });
    expect([revise.statusCode, revise.json().error]).toEqual([409, busy]);
    const again = await researchMore(a, jobId);
    expect([again.statusCode, again.json().error]).toEqual([409, busy]);
    expect(await g.autoTextQaForJob(jobId)).toBeUndefined(); // never on the draft being replaced
    expect(scratchOf(jobId).textApproved).toBeUndefined();

    release();
    expect((await running).statusCode).toBe(200);
    await settled(jobId);
    expect(names().filter((s) => s === "research_more")).toHaveLength(1);
    expect((await a.inject({ method: "POST", url: `/api/jobs/${jobId}/approve-text` })).json().job.state).toBe("queued"); // the human approval still works
    expect(enqueueJob).toHaveBeenCalledOnce();
    await a.close();
  });

  test("feedback is validated like a revision, and only an unapproved job at the text gate can ask", async () => {
    const { jobId } = await atTextGate(true);
    const a = await app();
    for (const f of ["", "   ", 7]) expect((await researchMore(a, jobId, f)).statusCode).toBe(400);
    updateJob(jobId, { state: "awaiting_preview" });
    expect((await researchMore(a, jobId)).statusCode).toBe(409);
    expect(h.calls).toEqual([]);
    await a.close();
  });
});

describe("Research more: a legacy pair-first job", () => {
  test("8. no flow: new research, the Long AND the Short written again, the pair audit and the pair Text QA; still at the gate", async () => {
    const { story, jobId } = await atTextGate(false);
    const a = await app();
    expect((await researchMore(a, jobId)).statusCode).toBe(200);
    await settled(jobId);
    expect(names()).toEqual(["research_more", "research_audit", "research_verify", "script", "script", "script_audit", "text_qa"]);
    expect(h.calls[5].input).toContain("DRAFT SHORT SCRIPT:\nNew short draft NS-1.");
    expect(h.calls[6].input).toContain("SHORT SCRIPT:\nAudited new short NS-2.");
    const s = scratchOf(jobId);
    expect(s.flow).toBeUndefined();
    expect(s.research).toEqual(pkg("VERIFIED-3"));
    expect(s.scripts).toEqual({ long: "Audited new long NL-2.", short: "Audited new short NS-2." });
    expect(s.scriptParts).toEqual({ long: "New long draft NL-1.", short: "New short draft NS-1." });
    expect(getScripts(story.id)).toEqual({ long: "Audited new long NL-2.", short: "Audited new short NS-2." });
    expect(await publicJob(a, jobId)).toMatchObject({ state: "awaiting_text", textQa: { status: "passed" } });
    expect(s.textApproved).toBeUndefined();
    expect(enqueueJob).not.toHaveBeenCalled();
    await a.close();
  });
});

describe("Research more: budget", () => {
  test("9. the approved maximum is preflighted before the research package: no call, nothing changed", async () => {
    const { jobId, base } = await atTextGate(true, { spent: 0.45, approvedMax: 0.5 }); // the research package would exceed it
    const a = await app();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await researchMore(a, jobId);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Approved maximum");
    expect(h.calls).toEqual([]);
    expect(scratchOf(jobId).research).toEqual(OLD);
    expect(getJob(jobId)!.spent).toBe(base);
    vi.mocked(console.error).mockRestore();
    await a.close();
  });
});
