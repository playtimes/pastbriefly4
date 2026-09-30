import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config, settingsStatus, setMode, saveSettings } from "./config.ts";
import { CATEGORIES, directorFeedbackError, stillFeedbackError, sequenceFeedbackError, type Job, type StoryReview } from "../types.ts";
import type { ResearchPackage } from "../production/pipelineTypes.ts";
import type { Scripts } from "./store.ts";
import {
  listStories,
  getStory,
  getStoryBySlug,
  setStoryPublished,
  setStorySaved,
  activeJobForStory,
  latestJobForStory,
  videosForStory,
  createJob,
  getJob,
  updateJob,
  type JobRecord,
} from "./store.ts";
import { estimateJob } from "../production/estimate.ts";
import { findStories, recheckStory } from "../production/research.ts";
import { discover } from "../production/discover.ts";
import { getNiches } from "../production/niches.ts";
import { enqueueJob } from "./worker.ts";
import { newJobId, clearVisualsForRebuild, raiseApprovedMax, approveTextForJob, reviseTextForJob, isRevisingText, isTextQaRunning, textQaState, isAssetQaRunning, assetQaState, clearAssetQaIssue, isDirectorQaRunning, directorQaState, startDirectorQaForJob, approveVisualsForJob, visualAutopilotState, jobProgress, regenerateStill, isRegeneratingStill, reviseSequenceForJob, isRevisingSequence, directorReviewForJob, directorRepairForJob, directorCleanupForJob, directorCoordinateForJob, directorVerifyForJob, finalQaState, acceptFinalForJob, resumeFinalVisualRepairForJob } from "../production/generate.ts";

const TEXT_QA_BUSY = "Automatic Text QA is running. Wait for it to finish.";
const ASSET_QA_BUSY = "Automatic Asset QA is running. Wait for it to finish.";
const DIRECTOR_QA_BUSY = "Director QA is running. Wait for it to finish.";

// The editorial review data for the text gate, read straight from the job's
// private scratch. Only the useful fields are exposed - never the whole scratch.
function reviewFromJob(j: JobRecord): StoryReview | null {
  const scratch = j.scratch as { research?: ResearchPackage; scripts?: Scripts };
  const research = scratch.research;
  const scripts = scratch.scripts;
  if (!research || !scripts) return null;
  const story = getStory(j.storyId);
  return {
    title: story?.title ?? "",
    hook: story?.hook ?? "",
    facts: research.facts ?? [],
    moments: research.moments,
    sources: research.sources,
    longScript: scripts.long,
    shortScript: scripts.short,
  };
}

function toPublic(j: JobRecord): Job {
  const { previewApproved, scratch, ...pub } = j;
  const progress = jobProgress(j);
  const withProgress = progress ? { ...pub, progress } : pub;
  // Text QA status: its phase or stop reason at the text gate, and "passed" while
  // the approved job heads for the visuals. Server memory only.
  const qa = textQaState(j.id);
  const shown = qa && (j.state === "awaiting_text" ? qa.status !== "passed" : qa.status === "passed" && (j.state === "queued" || j.state === "running"));
  const withTextQa = shown ? { ...withProgress, textQa: qa } : withProgress;
  // Asset QA at the visual preview: its running phase, then its latest result
  // (only the exceptions for assets the film still shows).
  const assetQa = j.state === "awaiting_preview" ? assetQaState(j.id, scratch) : undefined;
  const withAssetQa = assetQa ? { ...withTextQa, assetQa } : withTextQa;
  // Run Director QA per film at the visual preview: its phase, then its result.
  const directorQa = j.state === "awaiting_preview" ? directorQaState(j.id, scratch) : undefined;
  const withDirectorQa = directorQa ? { ...withAssetQa, directorQa } : withAssetQa;
  // Visual Autopilot (server memory): running or failed at the visual gate, and
  // "passed" while the approved job continues, like Text QA's "passed".
  const pilot = visualAutopilotState(j.id);
  const showPilot = pilot && (j.state === "awaiting_preview" ? pilot.status !== "passed" : pilot.status === "passed" && (j.state === "queued" || j.state === "running"));
  const withPilot = showPilot ? { ...withDirectorQa, visualAutopilot: pilot } : withDirectorQa;
  // The finished-film gate: only each concern's film, area, reason and fragment.
  const finalQa = j.state === "awaiting_final" ? finalQaState(scratch) : undefined;
  const withQa = finalQa ? { ...withPilot, finalQa } : withPilot;
  // Attach the review only at the text gate, so no other response leaks scratch.
  return j.state === "awaiting_text" ? { ...withQa, review: reviewFromJob(j) } : withQa;
}

// State-changing requests must come from our own localhost origin.
function localOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const h = new URL(origin).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD" && !localOrigin(req.headers.origin)) {
      reply.code(403).send({ error: "Cross-origin writes are not allowed." });
    }
  });

  app.get("/api/config", async () => ({ mode: config.mode, maxSpendUsd: config.maxSpendUsd, categories: CATEGORIES }));

  // Config page: key status (configured or not - never the values), the mock/live
  // toggle, and saving provider credentials.
  app.get("/api/settings", async () => settingsStatus());

  const modeBody = z.object({ mode: z.enum(["mock", "live"]) }).strict();
  app.post("/api/settings/mode", async (req, reply) => {
    const parsed = modeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "mode must be 'mock' or 'live'." });
    setMode(parsed.data.mode);
    return settingsStatus();
  });

  // Save provider credentials. A blank field leaves the stored value unchanged.
  const settingsBody = z
    .object({
      openaiApiKey: z.string().max(400).optional(),
      elevenlabsApiKey: z.string().max(400).optional(),
      elevenlabsVoiceId: z.string().max(200).optional(),
      runwayApiSecret: z.string().max(400).optional(),
      youtubeApiKey: z.string().max(400).optional(),
    })
    .strict();
  app.post("/api/settings", async (req, reply) => {
    const parsed = settingsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid settings payload." });
    saveSettings(parsed.data);
    return settingsStatus();
  });

  app.get("/api/stories", async () => ({ stories: listStories() }));

  app.get("/api/stories/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const story = getStoryBySlug(slug);
    if (!story) return reply.code(404).send({ error: "Story not found" });
    const active = activeJobForStory(story.id);
    // Surface a failed generation only when nothing is active (active takes priority).
    const latest = active ? null : latestJobForStory(story.id);
    const failed = latest?.state === "failed" ? latest : null;
    return {
      story,
      videos: videosForStory(story.id),
      estimate: estimateJob(story),
      activeJob: active ? toPublic(active) : null,
      failedJob: failed ? toPublic(failed) : null,
    };
  });

  // Mark a story's finished films published / unpublished.
  const publish = z.object({ published: z.boolean() });
  app.post("/api/stories/:id/publish", async (req, reply) => {
    const { id } = req.params as { id: string };
    const story = getStory(id);
    if (!story) return reply.code(404).send({ error: "Story not found" });
    const parsed = publish.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "published (boolean) is required." });
    setStoryPublished(id, parsed.data.published);
    return { story: getStory(id) };
  });

  // Toggle whether a story appears on the Stories page.
  const savedBody = z.object({ saved: z.boolean() });
  app.post("/api/stories/:id/saved", async (req, reply) => {
    const { id } = req.params as { id: string };
    const story = getStory(id);
    if (!story) return reply.code(404).send({ error: "Story not found" });
    const parsed = savedBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "saved (boolean) is required." });
    setStorySaved(id, parsed.data.saved);
    return { story: getStory(id) };
  });

  // Re-run a saved story through the candidate verifier. A "rewrite" is saved.
  app.post("/api/stories/:id/recheck", async (req, reply) => {
    const { id } = req.params as { id: string };
    const story = getStory(id);
    if (!story) return reply.code(404).send({ error: "Story not found" });
    try {
      return await recheckStory(story);
    } catch (e: any) {
      return reply.code(500).send({ error: e?.message || "Recheck failed." });
    }
  });

  const research = z.object({ query: z.string().min(2).max(200) });
  app.post("/api/research", async (req, reply) => {
    const parsed = research.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "A search query (2-200 chars) is required." });
    try {
      return await findStories(parsed.data.query);
    } catch (e: any) {
      return reply.code(500).send({ error: e?.message || "Research failed." });
    }
  });

  // Create dashboard: prompt and/or category discovery. At least one is required.
  const discoverBody = z.object({ prompt: z.string().max(200).optional(), category: z.string().max(60).optional(), niche: z.boolean().optional() }).strict();
  app.post("/api/discover", async (req, reply) => {
    const parsed = discoverBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid discovery payload." });
    const prompt = parsed.data.prompt?.trim() || undefined;
    const category = (CATEGORIES as readonly string[]).includes(parsed.data.category?.trim() ?? "") ? parsed.data.category!.trim() : undefined;
    if (!prompt && !category) return reply.code(400).send({ error: "Enter a prompt or choose a category." });
    try {
      return await discover({ prompt, category, niche: parsed.data.niche });
    } catch (e: any) {
      return reply.code(500).send({ error: e?.message || "Discovery failed." });
    }
  });

  // Real, cached discovery niches (trending / popular / recommended).
  app.get("/api/niches", async (_req, reply) => {
    try {
      return await getNiches();
    } catch (e: any) {
      return reply.code(500).send({ error: e?.message || "Could not load niches." });
    }
  });

  const generate = z.object({ approvedMax: z.number().positive() });
  app.post("/api/stories/:id/generate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const story = getStory(id);
    if (!story) return reply.code(404).send({ error: "Story not found" });

    // A story with a production is durable work: Generate always saves it to the
    // Stories library, whether it starts a job or returns the active one.
    const existing = activeJobForStory(story.id);
    if (existing) {
      setStorySaved(story.id, true);
      return { job: toPublic(existing), duplicate: true }; // one job per story
    }

    const parsed = generate.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "approvedMax (a positive number) is required." });
    const approvedMax = parsed.data.approvedMax;

    const estimate = estimateJob(story);
    if (approvedMax > config.maxSpendUsd) return reply.code(400).send({ error: `Approved max $${approvedMax} exceeds the ceiling $${config.maxSpendUsd}.` });
    if (approvedMax + 1e-9 < estimate.total) return reply.code(400).send({ error: `Approved max $${approvedMax} is below the estimate $${estimate.total}.` });

    const job = createJob({ id: newJobId(), storyId: story.id, mock: config.mode === "mock", estimatedCost: estimate.total, approvedMax });
    setStorySaved(story.id, true);
    enqueueJob(job.id);
    return { job: toPublic(job), duplicate: false };
  });

  // Approve the story text (the editorial review gate) and resume the SAME job
  // from narration. Only valid for an awaiting_text job; research/scripts/spend
  // are preserved, and no new generation is started.
  app.post("/api/jobs/:id/approve-text", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (job.state !== "awaiting_text") return { job: toPublic(job) };
    if (isTextQaRunning(id)) return reply.code(409).send({ error: TEXT_QA_BUSY });
    if (isRevisingText(id)) return reply.code(409).send({ error: "The story is being revised. Wait for it to finish." });
    const updated = approveTextForJob(id);
    enqueueJob(id);
    return { job: toPublic(updated) };
  });

  // Revise the story text at the text gate from pasted Director feedback. The
  // job stays awaiting_text and unapproved; nothing is requeued. On failure the
  // current draft is unchanged and the error is returned for the review screen.
  const reviseBody = z.object({ feedback: z.string() }).strict();
  app.post("/api/jobs/:id/revise-text", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    const parsed = reviseBody.safeParse(req.body);
    const invalid = parsed.success ? directorFeedbackError(parsed.data.feedback) : "Director feedback is required.";
    if (invalid || !parsed.success) return reply.code(400).send({ error: invalid });
    const feedback = parsed.data.feedback.trim();
    if (job.state !== "awaiting_text") return reply.code(409).send({ error: "The story can only be revised at the story review." });
    if (isTextQaRunning(id)) return reply.code(409).send({ error: TEXT_QA_BUSY });
    if (isRevisingText(id)) return reply.code(409).send({ error: "A revision is already running for this story." });
    try {
      return { job: toPublic(await reviseTextForJob(id, feedback)) };
    } catch (e: any) {
      const error = e?.message || "Could not revise the story.";
      // The server runs without a request logger, so this is the one trail a
      // failed revision leaves. Never the feedback text, scripts or payloads.
      console.error(`Director revision failed job=${id} feedbackLength=${feedback.length} error=${error}`);
      return reply.code(400).send({ error });
    }
  });

  app.post("/api/jobs/:id/continue", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (job.state !== "awaiting_preview") return { job: toPublic(job) };
    if (isDirectorQaRunning(id)) return reply.code(409).send({ error: DIRECTOR_QA_BUSY });
    if (isRegeneratingStill(id)) return reply.code(409).send({ error: "A still is being regenerated. Wait for it to finish." });
    if (isRevisingSequence(id)) return reply.code(409).send({ error: "The sequence is being revised. Wait for it to finish." });
    if (isAssetQaRunning(id)) return reply.code(409).send({ error: ASSET_QA_BUSY });
    // The same approval the Visual Autopilot uses, then the same requeue.
    const approved = approveVisualsForJob(id);
    enqueueJob(id);
    return { job: toPublic(approved) };
  });

  // Reject the previewed visuals and rebuild them under the SAME job: discard the
  // shot plans and their files, keep research/scripts/narration/master/spend, and
  // requeue so the updated planner produces a fresh preview.
  app.post("/api/jobs/:id/rebuild-visuals", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (job.state !== "awaiting_preview") return { job: toPublic(job) };
    if (isDirectorQaRunning(id)) return reply.code(409).send({ error: DIRECTOR_QA_BUSY });
    if (isRegeneratingStill(id)) return reply.code(409).send({ error: "A still is being regenerated. Wait for it to finish." });
    if (isRevisingSequence(id)) return reply.code(409).send({ error: "The sequence is being revised. Wait for it to finish." });
    if (isAssetQaRunning(id)) return reply.code(409).send({ error: ASSET_QA_BUSY });
    clearVisualsForRebuild(id);
    enqueueJob(id);
    return { job: toPublic(getJob(id)!) };
  });

  // Regenerate ONE generated owner still at the visual preview gate from its exact
  // stored plan. The job stays awaiting_preview and unapproved; nothing is requeued.
  const regenBody = z.object({ kind: z.enum(["long", "short"]), slot: z.number().int().min(0), directorFeedback: z.string().optional() }).strict();
  app.post("/api/jobs/:id/regenerate-still", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    const parsed = regenBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "kind ('long' or 'short') and slot (an integer) are required." });
    const tooLong = stillFeedbackError(parsed.data.directorFeedback ?? "");
    if (tooLong) return reply.code(400).send({ error: tooLong });
    if (job.state !== "awaiting_preview") return reply.code(409).send({ error: "A still can only be regenerated at the visual preview." });
    if (isDirectorQaRunning(id)) return reply.code(409).send({ error: DIRECTOR_QA_BUSY });
    if (isRevisingSequence(id)) return reply.code(409).send({ error: "The sequence is being revised. Wait for it to finish." });
    if (isAssetQaRunning(id)) return reply.code(409).send({ error: ASSET_QA_BUSY });
    try {
      const { kind, slot } = parsed.data;
      const updated = await regenerateStill(id, kind, slot, parsed.data.directorFeedback);
      // A person replaced this still: its Asset QA exception described the old bytes.
      const assetId = (updated.scratch as { longShots?: { assetId: string }[]; shortShots?: { assetId: string }[] })[kind === "long" ? "longShots" : "shortShots"]?.[slot]?.assetId;
      if (assetId) clearAssetQaIssue(id, kind, assetId);
      return { job: toPublic(getJob(id)!) };
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message || "Could not regenerate the still." });
    }
  });

  // Revise ONE film's edit from Director feedback at the visual preview gate. Only
  // presentations the film already shows can move; the job stays awaiting_preview
  // and unapproved; nothing is requeued. On failure the edit is unchanged. An
  // optional targetSlot (an issue's slot) is the only slot that may change.
  const sequenceBody = z.object({ kind: z.enum(["long", "short"]), directorFeedback: z.string(), targetSlot: z.number().int().nonnegative().optional() }).strict();
  app.post("/api/jobs/:id/revise-sequence", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    const parsed = sequenceBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "kind ('long' or 'short') and directorFeedback are required; targetSlot, when given, is a slot number." });
    const invalid = sequenceFeedbackError(parsed.data.directorFeedback);
    if (invalid) return reply.code(400).send({ error: invalid });
    const { kind, targetSlot } = parsed.data;
    const feedback = parsed.data.directorFeedback.trim();
    if (job.state !== "awaiting_preview") return reply.code(409).send({ error: "The sequence can only be revised at the visual preview." });
    if (isDirectorQaRunning(id)) return reply.code(409).send({ error: DIRECTOR_QA_BUSY });
    if (isRegeneratingStill(id)) return reply.code(409).send({ error: "A still is being regenerated. Wait for it to finish." });
    if (isRevisingSequence(id)) return reply.code(409).send({ error: "A sequence revision is already running for this job." });
    if (isAssetQaRunning(id)) return reply.code(409).send({ error: ASSET_QA_BUSY });
    try {
      const r = await reviseSequenceForJob(id, kind, feedback, undefined, targetSlot);
      return { job: toPublic(r.job), revision: { changed: r.changed, unresolved: r.unresolved } };
    } catch (e: any) {
      const error = e?.message || "Could not revise the sequence.";
      // Same single diagnostic line as a failed story revision: never the feedback text.
      console.error(`Director sequence revision failed job=${id} kind=${kind} feedbackLength=${feedback.length} error=${error}`);
      return reply.code(400).send({ error });
    }
  });

  // Run Director QA for ONE film on the server: the whole existing chain (review,
  // Director repair, cleanup, coordinated repair, final verification) runs there,
  // whatever the page does. Returns at once with the job showing the running
  // phase; the page follows the persisted state. The step routes below remain
  // for tests and debugging; the page no longer calls them.
  app.post("/api/jobs/:id/director-qa/:kind/run", async (req, reply) => {
    const { id, kind } = req.params as { id: string; kind: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (kind !== "long" && kind !== "short") return reply.code(400).send({ error: "kind must be 'long' or 'short'." });
    if (job.state !== "awaiting_preview") return reply.code(409).send({ error: "Director QA runs only at the visual preview." });
    if (isDirectorQaRunning(id)) return reply.code(409).send({ error: DIRECTOR_QA_BUSY });
    if (isRegeneratingStill(id)) return reply.code(409).send({ error: "A still is being regenerated. Wait for it to finish." });
    if (isRevisingSequence(id)) return reply.code(409).send({ error: "A sequence revision is already running for this job." });
    if (isAssetQaRunning(id)) return reply.code(409).send({ error: ASSET_QA_BUSY });
    try {
      return { job: toPublic(startDirectorQaForJob(id, kind).job) };
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message || "Could not start Director QA." });
    }
  });

  // Director QA, step 1: one editorial review of ONE film's stored edit. It never
  // changes the edit; the findings go back to the Director board.
  const qaBody = z.object({ kind: z.enum(["long", "short"]) }).strict();
  app.post("/api/jobs/:id/director-qa", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    const parsed = qaBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "kind ('long' or 'short') is required." });
    const { kind } = parsed.data;
    if (job.state !== "awaiting_preview") return reply.code(409).send({ error: "Director QA runs only at the visual preview." });
    if (isDirectorQaRunning(id)) return reply.code(409).send({ error: DIRECTOR_QA_BUSY });
    if (isRegeneratingStill(id)) return reply.code(409).send({ error: "A still is being regenerated. Wait for it to finish." });
    if (isRevisingSequence(id)) return reply.code(409).send({ error: "A sequence revision is already running for this job." });
    if (isAssetQaRunning(id)) return reply.code(409).send({ error: ASSET_QA_BUSY });
    try {
      const r = await directorReviewForJob(id, kind);
      return { job: toPublic(r.job), qa: r.qa };
    } catch (e: any) {
      const error = e?.message || "Director QA failed.";
      console.error(`Director QA review failed job=${id} kind=${kind} error=${error}`);
      return reply.code(400).send({ error });
    }
  });

  // Director QA, step 2: apply its repairs once through the bounded sequence
  // revision, with exactly those slots as targets and every other slot locked.
  const qaRepairBody = z
    .object({
      kind: z.enum(["long", "short"]),
      repairs: z.array(z.object({ slotId: z.number().int().min(0), reason: z.string().min(1).max(2000), instruction: z.string().min(1).max(2000) }).strict()).min(1).max(200),
    })
    .strict();
  app.post("/api/jobs/:id/director-qa/repair", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    const parsed = qaRepairBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "kind and at least one repair { slotId, reason, instruction } are required." });
    const { kind, repairs } = parsed.data;
    if (job.state !== "awaiting_preview") return reply.code(409).send({ error: "The sequence can only be revised at the visual preview." });
    if (isDirectorQaRunning(id)) return reply.code(409).send({ error: DIRECTOR_QA_BUSY });
    if (isRegeneratingStill(id)) return reply.code(409).send({ error: "A still is being regenerated. Wait for it to finish." });
    if (isRevisingSequence(id)) return reply.code(409).send({ error: "A sequence revision is already running for this job." });
    if (isAssetQaRunning(id)) return reply.code(409).send({ error: ASSET_QA_BUSY });
    try {
      const r = await directorRepairForJob(id, kind, repairs);
      return { job: toPublic(r.job), revision: { changed: r.changed, unresolved: r.unresolved } };
    } catch (e: any) {
      const error = e?.message || "The automatic repair failed.";
      console.error(`Director QA repair failed job=${id} kind=${kind} repairs=${repairs.length} error=${error}`);
      return reply.code(400).send({ error });
    }
  });

  // Director QA, step 3: the deterministic repetition cleanup, at most one more
  // bounded sequence revision. A failed cleanup revision is reported inside the
  // result (with the remaining patterns); the edit before it stays saved.
  app.post("/api/jobs/:id/director-qa/cleanup", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    const parsed = qaBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "kind ('long' or 'short') is required." });
    const { kind } = parsed.data;
    if (job.state !== "awaiting_preview") return reply.code(409).send({ error: "The sequence can only be revised at the visual preview." });
    if (isDirectorQaRunning(id)) return reply.code(409).send({ error: DIRECTOR_QA_BUSY });
    if (isRegeneratingStill(id)) return reply.code(409).send({ error: "A still is being regenerated. Wait for it to finish." });
    if (isRevisingSequence(id)) return reply.code(409).send({ error: "A sequence revision is already running for this job." });
    if (isAssetQaRunning(id)) return reply.code(409).send({ error: ASSET_QA_BUSY });
    try {
      const r = await directorCleanupForJob(id, kind);
      if (r.cleanup.error) console.error(`Director QA cleanup failed job=${id} kind=${kind} error=${r.cleanup.error}`);
      return { job: toPublic(r.job), cleanup: r.cleanup };
    } catch (e: any) {
      const error = e?.message || "The automatic cleanup failed.";
      console.error(`Director QA cleanup failed job=${id} kind=${kind} error=${error}`);
      return reply.code(400).send({ error });
    }
  });

  // Director QA, step 4 (the last): one coordinated repair of the small window
  // around one unresolved slot, from existing media only. A failed coordinated
  // revision is reported inside the result; the edit before it stays saved.
  // `intent`: the original Director finding, when the target was a Director QA repair.
  const intentBody = z.object({ reason: z.string().min(1).max(2000), instruction: z.string().min(1).max(2000) }).strict();
  const coordinateBody = z.object({ kind: z.enum(["long", "short"]), slotId: z.number().int().min(0), reason: z.string().max(2000), intent: intentBody.optional() }).strict();
  app.post("/api/jobs/:id/director-qa/coordinate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    const parsed = coordinateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "kind, slotId and reason are required." });
    const { kind, slotId, reason, intent } = parsed.data;
    if (job.state !== "awaiting_preview") return reply.code(409).send({ error: "The sequence can only be revised at the visual preview." });
    if (isDirectorQaRunning(id)) return reply.code(409).send({ error: DIRECTOR_QA_BUSY });
    if (isRegeneratingStill(id)) return reply.code(409).send({ error: "A still is being regenerated. Wait for it to finish." });
    if (isRevisingSequence(id)) return reply.code(409).send({ error: "A sequence revision is already running for this job." });
    if (isAssetQaRunning(id)) return reply.code(409).send({ error: ASSET_QA_BUSY });
    try {
      const r = await directorCoordinateForJob(id, kind, slotId, reason, undefined, intent);
      if (r.report.error) console.error(`Director QA coordinated repair failed job=${id} kind=${kind} slot=${slotId} error=${r.report.error}`);
      return { job: toPublic(r.job), coordinated: r.report };
    } catch (e: any) {
      const error = e?.message || "The coordinated repair failed.";
      console.error(`Director QA coordinated repair failed job=${id} kind=${kind} slot=${slotId} error=${error}`);
      return reply.code(400).send({ error });
    }
  });

  // Director QA, the final and terminal step: one read-only Director verification
  // of the saved film. It changes nothing; a failed verification is reported
  // inside the result, with the current deterministic patterns.
  app.post("/api/jobs/:id/director-qa/verify", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    const parsed = qaBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "kind ('long' or 'short') is required." });
    const { kind } = parsed.data;
    if (job.state !== "awaiting_preview") return reply.code(409).send({ error: "Director QA runs only at the visual preview." });
    if (isDirectorQaRunning(id)) return reply.code(409).send({ error: DIRECTOR_QA_BUSY });
    if (isRegeneratingStill(id)) return reply.code(409).send({ error: "A still is being regenerated. Wait for it to finish." });
    if (isRevisingSequence(id)) return reply.code(409).send({ error: "A sequence revision is already running for this job." });
    if (isAssetQaRunning(id)) return reply.code(409).send({ error: ASSET_QA_BUSY });
    try {
      const r = await directorVerifyForJob(id, kind);
      if (r.verify.error) console.error(`Director QA final verification failed job=${id} kind=${kind} error=${r.verify.error}`);
      return { job: toPublic(r.job), verify: r.verify };
    } catch (e: any) {
      const error = e?.message || "The final Director verification failed.";
      console.error(`Director QA final verification failed job=${id} kind=${kind} error=${error}`);
      return reply.code(400).send({ error });
    }
  });

  // Continue anyway at the finished-film gate: accept the films as they are and
  // resume the SAME job, which checks the finished files again and registers
  // both videos. No provider call, no motion, no render. Only valid for an
  // awaiting_final job; any other state gets the job back unchanged.
  app.post("/api/jobs/:id/accept-final", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (job.state !== "awaiting_final") return { job: toPublic(job) };
    const accepted = acceptFinalForJob(id);
    enqueueJob(id);
    return { job: toPublic(accepted) };
  });

  // Run the ONE automatic final visual archive repair on a job that reached the
  // finished-film gate before that repair existed. No UI: an explicit, authorized
  // call only. Optional approvedMax raises the ceiling first (never past the max);
  // optional kind repairs that one film and leaves the other untouched.
  const finalVisualRepair = z.object({ approvedMax: z.number().positive().optional(), kind: z.enum(["long", "short"]).optional() });
  app.post("/api/jobs/:id/final-visual-repair", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getJob(id)) return reply.code(404).send({ error: "Job not found" });
    const parsed = finalVisualRepair.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'approvedMax must be a positive number and kind "long" or "short".' });
    try {
      const job = resumeFinalVisualRepairForJob(id, parsed.data.approvedMax, parsed.data.kind);
      enqueueJob(id);
      return { job: toPublic(job) };
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message || "This job cannot be repaired." });
    }
  });

  // Retry a failed job in place: reuse the same job id so completed (and paid)
  // work in scratch is preserved and runJob resumes from the first unfinished step.
  app.post("/api/jobs/:id/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (job.state !== "failed") return { job: toPublic(job) };
    updateJob(id, { state: "queued", error: null, message: "Queued" });
    enqueueJob(id);
    return { job: toPublic(getJob(id)!) };
  });

  // Increase the approved maximum on a job that failed because the next paid call
  // would exceed it, then requeue the SAME job so it resumes. Spend and completed
  // work are preserved; the budget guard is unchanged and still enforced.
  const approveSpend = z.object({ approvedMax: z.number().positive() });
  app.post("/api/jobs/:id/approve-spend", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (job.state !== "failed") return { job: toPublic(job) };
    const parsed = approveSpend.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "approvedMax (a positive number) is required." });
    try {
      const updated = raiseApprovedMax(id, parsed.data.approvedMax);
      enqueueJob(id);
      return { job: toPublic(updated) };
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message || "Could not increase the approved maximum." });
    }
  });

  app.get("/api/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return { job: toPublic(job) };
  });
}
