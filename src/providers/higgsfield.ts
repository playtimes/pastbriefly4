import { writeFile, readFile, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "../server/config.ts";
import { assertPublicUrl } from "../server/security.ts";

// Live Higgsfield motion via the prepaid USD REST API (api.higgsfield.ai).
// Adapted from the proven PB3 client. Image-to-video only; OpenAI owns stills.
//   auth : Authorization: Key <keyId>:<secret>
//   video: POST /<HIGGSFIELD_VIDEO_MODEL>  { image_url, prompt, duration, cfg_scale }
//   poll : status_url until completed; output on video.url / images[].url
// image_url must be a PROVIDER-REACHABLE public still URL (not a local path).
// A request journal guarantees an accepted (billable) request is never resubmitted.
// PENDING LIVE VERIFICATION of the endpoint path before any paid run.

const HOST = "https://api.higgsfield.ai";
const OK = new Set(["completed", "succeeded", "success", "done"]);
const FAIL = new Set(["failed", "error", "canceled", "cancelled", "nsfw"]);

function headers(): Record<string, string> {
  const { apiKey, apiSecret } = config.higgsfield;
  if (!apiKey || !apiSecret) throw new Error("HIGGSFIELD_API_KEY / HIGGSFIELD_API_SECRET not set. Add them to .env to run live.");
  return { Authorization: `Key ${apiKey}:${apiSecret}`, "Content-Type": "application/json" };
}

function abs(url: string): string {
  return url.startsWith("http") ? url : `${HOST}${url.startsWith("/") ? "" : "/"}${url}`;
}

function findOutputUrl(obj: any): string | null {
  const keys = ["url", "image_url", "video_url", "download_url", "result_url", "output_url"];
  const stack = [obj];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object") continue;
    for (const k of keys) if (typeof v[k] === "string" && v[k].startsWith("http")) return v[k];
    for (const val of Object.values(v)) if (val && typeof val === "object") stack.push(val);
  }
  return null;
}

interface Journal {
  state: "pending" | "accepted" | "done";
  requestId?: string;
  statusUrl?: string;
  providerUrl?: string;
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

async function poll(statusUrl: string, requestId: string, outPath: string): Promise<string> {
  const deadline = Date.now() + 5 * 60 * 1000;
  let providerUrl: string | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const res = await fetch(statusUrl, { headers: headers() });
    if (!res.ok) throw new Error(`Higgsfield status ${res.status}`);
    const st = await res.json();
    const status = String(st.status || "").toLowerCase();
    if (FAIL.has(status)) throw new Error(`Higgsfield job ${requestId} ${status}`);
    if (OK.has(status) || st.status === undefined) {
      providerUrl = findOutputUrl(st);
      if (providerUrl) break;
    }
  }
  if (!providerUrl) throw new Error(`Higgsfield job ${requestId} produced no output in time.`);
  assertPublicUrl(providerUrl);
  const media = await fetch(providerUrl);
  if (!media.ok) throw new Error(`Higgsfield download ${media.status}`);
  await writeFile(outPath, Buffer.from(await media.arrayBuffer()));
  return providerUrl;
}

// Submit (or recover) one motion clip. Returns the provider request id.
export async function generateMotion(opts: { prompt: string; imageUrl: string; outPath: string }): Promise<{ requestId: string }> {
  const prior = await readJournal(opts.outPath);
  if (prior) {
    if (prior.state === "done" && fileReady(opts.outPath)) return { requestId: prior.requestId || "higgsfield" };
    if (prior.state === "pending")
      throw new Error(`Higgsfield: a prior submission for ${path.basename(opts.outPath)} has an uncertain outcome. Check the console and delete ${journalPath(opts.outPath)} before retrying.`);
    if (prior.requestId && prior.statusUrl) {
      const providerUrl = await poll(prior.statusUrl, prior.requestId, opts.outPath);
      await writeJournal(opts.outPath, { ...prior, state: "done", providerUrl });
      return { requestId: prior.requestId };
    }
  }

  assertPublicUrl(opts.imageUrl);
  await writeJournal(opts.outPath, { state: "pending" });
  let submit: any;
  try {
    const res = await fetch(`${HOST}/${config.higgsfield.videoModel}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ image_url: opts.imageUrl, prompt: opts.prompt, duration: 5, cfg_scale: 0.5 }),
    });
    if (!res.ok) {
      await rm(journalPath(opts.outPath), { force: true }); // rejected: not billed
      throw new Error(`Higgsfield submit ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    submit = await res.json();
  } catch (e) {
    throw e; // network failure keeps the pending marker so a resume stops
  }
  const requestId: string = submit.request_id || submit.id || "higgsfield";
  const statusUrl = abs(submit.status_url || `/requests/${requestId}/status`);
  await writeJournal(opts.outPath, { state: "accepted", requestId, statusUrl });
  const providerUrl = await poll(statusUrl, requestId, opts.outPath);
  await writeJournal(opts.outPath, { state: "done", requestId, statusUrl, providerUrl });
  return { requestId };
}
