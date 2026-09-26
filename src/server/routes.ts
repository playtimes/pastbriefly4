import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config, settingsStatus, setMode, saveSettings } from "./config.ts";
import { CATEGORIES, type Job, type StoryReview } from "../types.ts";
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
  approvePreview,
  updateJob,
  type JobRecord,
} from "./store.ts";
import { estimateJob } from "../production/estimate.ts";
import { findStories, recheckStory } from "../production/research.ts";
import { discover } from "../production/discover.ts";
import { getNiches } from "../production/niches.ts";
import { enqueueJob } from "./worker.ts";
import { newJobId, clearVisualsForRebuild, raiseApprovedMax, approveTextForJob, jobProgress, regenerateStill, isRegeneratingStill } from "../production/generate.ts";

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
  // Attach the review only at the text gate, so no other response leaks scratch.
  return j.state === "awaiting_text" ? { ...withProgress, review: reviewFromJob(j) } : withProgress;
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

    const existing = activeJobForStory(story.id);
    if (existing) return { job: toPublic(existing), duplicate: true }; // one job per story

    const parsed = generate.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "approvedMax (a positive number) is required." });
    const approvedMax = parsed.data.approvedMax;

    const estimate = estimateJob(story);
    if (approvedMax > config.maxSpendUsd) return reply.code(400).send({ error: `Approved max $${approvedMax} exceeds the ceiling $${config.maxSpendUsd}.` });
    if (approvedMax + 1e-9 < estimate.total) return reply.code(400).send({ error: `Approved max $${approvedMax} is below the estimate $${estimate.total}.` });

    const job = createJob({ id: newJobId(), storyId: story.id, mock: config.mode === "mock", estimatedCost: estimate.total, approvedMax });
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
    const updated = approveTextForJob(id);
    enqueueJob(id);
    return { job: toPublic(updated) };
  });

  app.post("/api/jobs/:id/continue", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (job.state !== "awaiting_preview") return { job: toPublic(job) };
    if (isRegeneratingStill(id)) return reply.code(409).send({ error: "A still is being regenerated. Wait for it to finish." });
    approvePreview(id);
    enqueueJob(id);
    return { job: toPublic(getJob(id)!) };
  });

  // Reject the previewed visuals and rebuild them under the SAME job: discard the
  // shot plans and their files, keep research/scripts/narration/master/spend, and
  // requeue so the updated planner produces a fresh preview.
  app.post("/api/jobs/:id/rebuild-visuals", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (job.state !== "awaiting_preview") return { job: toPublic(job) };
    if (isRegeneratingStill(id)) return reply.code(409).send({ error: "A still is being regenerated. Wait for it to finish." });
    clearVisualsForRebuild(id);
    enqueueJob(id);
    return { job: toPublic(getJob(id)!) };
  });

  // Regenerate ONE generated owner still at the visual preview gate from its exact
  // stored plan. The job stays awaiting_preview and unapproved; nothing is requeued.
  const regenBody = z.object({ kind: z.enum(["long", "short"]), slot: z.number().int().min(0) }).strict();
  app.post("/api/jobs/:id/regenerate-still", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    const parsed = regenBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "kind ('long' or 'short') and slot (an integer) are required." });
    if (job.state !== "awaiting_preview") return reply.code(409).send({ error: "A still can only be regenerated at the visual preview." });
    try {
      return { job: toPublic(await regenerateStill(id, parsed.data.kind, parsed.data.slot)) };
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message || "Could not regenerate the still." });
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
