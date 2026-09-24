import { writeFile, readFile, rm, rename } from "node:fs/promises";
import { existsSync, statSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { config } from "../server/config.ts";
import { assertPublicUrl } from "../server/security.ts";
import { MOTION_CLIP_SECONDS } from "../server/pricing.ts";

// Live Runway motion via the developer API (api.dev.runwayml.com). Image-to-video
// only; OpenAI owns stills. The local still is sent inline as a data URI, so no
// public asset URL or tunnel is needed.
//   auth  : Authorization: Bearer <RUNWAYML_API_SECRET>, X-Runway-Version
//   submit: POST /v1/image_to_video { model, promptImage, promptText, ratio, duration }
//   poll  : GET /v1/tasks/<id> until SUCCEEDED; output[0] is the clip URL
// A request journal beside the output guarantees an accepted (billable) task is
// never resubmitted: a restart resumes polling the journaled task instead.

const HOST = "https://api.dev.runwayml.com";
const VERSION = "2024-11-06";
const POLL_MS = 5000;
const DEADLINE_MS = 20 * 60 * 1000;
// Runway accepts image data URIs up to 5 MB; larger stills are re-encoded as JPEG.
const MAX_DATA_URI = 5 * 1024 * 1024;

function headers(): Record<string, string> {
  const { apiSecret } = config.runway;
  if (!apiSecret) throw new Error("RUNWAYML_API_SECRET not set. Add it on the Config page or in .env to run live.");
  return { Authorization: `Bearer ${apiSecret}`, "Content-Type": "application/json", "X-Runway-Version": VERSION };
}

// The local still as a data URI. Oversized PNGs are transcoded to a high-quality
// JPEG with ffmpeg so the payload stays inside Runway's data URI limit.
export function imageDataUri(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  const uri = `data:${mime};base64,${readFileSync(imagePath).toString("base64")}`;
  if (uri.length <= MAX_DATA_URI) return uri;
  const tmp = `${imagePath}.runway.tmp.jpg`;
  try {
    execFileSync(config.ffmpeg, ["-v", "error", "-y", "-i", imagePath, "-q:v", "2", tmp], { stdio: "ignore" });
    const jpeg = `data:image/jpeg;base64,${readFileSync(tmp).toString("base64")}`;
    if (jpeg.length > MAX_DATA_URI) throw new Error(`Still ${path.basename(imagePath)} is too large for a Runway data URI.`);
    return jpeg;
  } finally {
    rmSync(tmp, { force: true });
  }
}

interface Journal {
  state: "pending" | "accepted" | "done" | "failed";
  taskId?: string;
  providerUrl?: string;
  message?: string; // provider failure detail, when state is "failed"
}

// A confirmed terminal failure reported by Runway (FAILED / CANCELED). Distinct
// from uncertain outcomes (network/timeout) so only this marks the journal failed.
class RunwayTerminalFailure extends Error {
  constructor(public taskId: string, public status: string, public detail: string) {
    super(`Runway task ${taskId} ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "RunwayTerminalFailure";
  }
}

const journalPath = (out: string) => `${out}.req.json`;

async function readJournal(out: string): Promise<Journal | null> {
  try {
    return JSON.parse(await readFile(journalPath(out), "utf8"));
  } catch {
    return null;
  }
}
const writeJournal = (out: string, j: Journal) => writeFile(journalPath(out), JSON.stringify(j, null, 2));
const fileReady = (p: string) => existsSync(p) && statSync(p).size > 0;

// Poll one task to a terminal state, then download output[0] to outPath at once
// (Runway output URLs expire, so nothing relies on them later).
async function poll(taskId: string, outPath: string, pollMs: number): Promise<string> {
  const deadline = Date.now() + DEADLINE_MS;
  let providerUrl: string | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const res = await fetch(`${HOST}/v1/tasks/${encodeURIComponent(taskId)}`, { headers: headers() });
    if (res.status === 429 || res.status >= 500) continue; // transient: keep waiting
    if (!res.ok) throw new Error(`Runway task status ${res.status}`);
    const task = await res.json();
    const status = String(task.status || "").toUpperCase();
    if (status === "FAILED" || status === "CANCELED" || status === "CANCELLED") {
      const detail = String(task.failure || task.failureCode || task.error || "").slice(0, 300);
      console.warn(`[runway] terminal ${status} for ${taskId}: ${JSON.stringify(task).slice(0, 500)}`);
      throw new RunwayTerminalFailure(taskId, status, detail);
    }
    if (status === "SUCCEEDED") {
      providerUrl = Array.isArray(task.output) && typeof task.output[0] === "string" ? task.output[0] : null;
      if (!providerUrl) throw new RunwayTerminalFailure(taskId, "SUCCEEDED", "no output URL");
      break;
    }
    // PENDING / THROTTLED / RUNNING: keep waiting.
  }
  if (!providerUrl) throw new Error(`Runway task ${taskId} is still running after 20 minutes. Run again to resume polling it.`);
  assertPublicUrl(providerUrl);
  const media = await fetch(providerUrl);
  if (!media.ok) throw new Error(`Runway download ${media.status}`);
  const tmp = `${outPath}.download`;
  await writeFile(tmp, Buffer.from(await media.arrayBuffer()));
  await rename(tmp, outPath);
  return providerUrl;
}

async function pollAndJournal(taskId: string, outPath: string, pollMs: number): Promise<{ taskId: string }> {
  try {
    const providerUrl = await poll(taskId, outPath, pollMs);
    await writeJournal(outPath, { state: "done", taskId, providerUrl });
    return { taskId };
  } catch (e) {
    if (e instanceof RunwayTerminalFailure) await writeJournal(outPath, { state: "failed", taskId, message: e.detail });
    throw e;
  }
}

// Submit (or resume) one 5-second motion clip from a local still. Returns the task id.
export async function generateMotion(opts: {
  prompt: string;
  imagePath: string;
  kind: "long" | "short";
  outPath: string;
  pollMs?: number; // tests only; production polls every 5 seconds
}): Promise<{ taskId: string }> {
  const pollMs = opts.pollMs ?? POLL_MS;
  const prior = await readJournal(opts.outPath);
  // A confirmed "failed" journal may be replaced by a fresh submission below; any
  // other prior either finishes, resumes its accepted task, or blocks resubmission.
  if (prior && prior.state !== "failed") {
    if (prior.state === "done" && fileReady(opts.outPath)) return { taskId: prior.taskId || "runway" };
    if (prior.state === "pending")
      throw new Error(`Runway: a prior submission for ${path.basename(opts.outPath)} has an uncertain outcome. Check the Runway dashboard and delete ${journalPath(opts.outPath)} before retrying.`);
    if (prior.taskId) return pollAndJournal(prior.taskId, opts.outPath, pollMs);
  }

  const body = {
    model: config.runway.videoModel,
    promptImage: imageDataUri(opts.imagePath),
    promptText: opts.prompt,
    ratio: opts.kind === "short" ? "720:1280" : "1280:720",
    duration: MOTION_CLIP_SECONDS,
  };
  const auth = headers();
  await writeJournal(opts.outPath, { state: "pending" });
  // A network failure here leaves the pending marker, so a resume stops rather
  // than risk a second billable task.
  const res = await fetch(`${HOST}/v1/image_to_video`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  if (!res.ok) {
    await rm(journalPath(opts.outPath), { force: true }); // rejected: not billed
    throw new Error(`Runway submit ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const submit = await res.json();
  const taskId: string | undefined = submit?.id;
  if (!taskId) throw new Error("Runway submit returned no task id; the pending journal is kept so it is not resubmitted blindly.");
  await writeJournal(opts.outPath, { state: "accepted", taskId });
  return pollAndJournal(taskId, opts.outPath, pollMs);
}
