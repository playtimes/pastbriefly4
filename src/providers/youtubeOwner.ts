import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { DATA_DIR } from "../server/config.ts";

// Read-only owner analytics for the PastBriefly channel via the official APIs:
//   Data API v3       GET  youtube/v3/channels|playlistItems|videos   (identity, inventory)
//   Analytics API v2  GET  youtubeanalytics/v2/reports                (owner metrics, retention)
//   Reporting API v1  GET  youtubereporting/v1/reportTypes|jobs|reports|media, POST /v1/jobs
// OAuth is the installed-app loopback flow with PKCE, direct REST, no SDK.
// Separate from public discovery (src/production/youtube.ts), which keeps using
// the API key. Nothing here is reachable from the server or the browser.
// Every request goes through request(), which refuses anything outside the
// allowlist below, so no channel mutation endpoint can be called.

export const PASTBRIEFLY_CHANNEL_ID = "UCpAzru3r59YyCJrixIHiMPg";

export const SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
] as const;

const AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const DATA_API = "https://www.googleapis.com/youtube/v3";
const ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2/reports";
const REPORTING_API = "https://youtubereporting.googleapis.com/v1";

// The reporting jobs PB4 wants, and nothing else.
export const REPORT_TYPES = ["channel_basic_a3", "channel_traffic_source_a3", "channel_reach_basic_a1"] as const;

// Local, gitignored (data/) home for credentials and raw analytics.
export function ownerPaths(root = path.join(DATA_DIR, "analytics", "youtube")) {
  return {
    root,
    client: path.join(root, "oauth-client.json"),
    token: path.join(root, "oauth-token.json"),
    snapshots: path.join(root, "snapshots"),
    reports: path.join(root, "reports"),
    jobs: path.join(root, "reporting-jobs.json"),
  };
}
export type OwnerPaths = ReturnType<typeof ownerPaths>;

// ---------- guarded HTTP ----------

// GET is allowed against the three read APIs and the Reporting media host.
// POST is allowed only for the OAuth token exchange and Reporting job creation.
export function assertAllowed(method: string, url: string): void {
  const u = new URL(url);
  const href = `${u.origin}${u.pathname}`;
  const reads = [`${DATA_API}/channels`, `${DATA_API}/playlistItems`, `${DATA_API}/videos`, ANALYTICS_API];
  if (method === "GET" && (reads.includes(href) || (u.origin === REPORTING_API.replace("/v1", "") && u.pathname.startsWith("/v1/")))) return;
  if (method === "POST" && (href === TOKEN_URI || href === `${REPORTING_API}/jobs`)) return;
  throw new Error(`Refusing ${method} ${href}: not a read-only YouTube owner analytics endpoint.`);
}

// Error bodies are clipped and scrubbed of anything token-shaped before surfacing.
export function redact(text: string): string {
  return text
    .replace(/ya29\.[\w.-]+/g, "[redacted]")
    .replace(/1\/\/[\w.-]+/g, "[redacted]")
    .replace(/("?(?:access_token|refresh_token|client_secret|code|id_token)"?\s*[:=]\s*"?)[^"&\s,}]+/gi, "$1[redacted]");
}

export class YouTubeHttpError extends Error {
  constructor(public label: string, public status: number, public body: string) {
    super(`${label} ${status}: ${redact(body).slice(0, 300)}`);
    this.name = "YouTubeHttpError";
  }
}

async function request(method: "GET" | "POST", url: string, init: { token?: string; json?: unknown; form?: Record<string, string>; label: string }): Promise<Response> {
  assertAllowed(method, url);
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  }
  const res = await fetch(url, { method, headers, body });
  if (!res.ok) throw new YouTubeHttpError(init.label, res.status, await res.text().catch(() => ""));
  return res;
}

async function getJson(url: string, token: string, label: string): Promise<any> {
  const res = await request("GET", url, { token, label });
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== "object") throw new Error(`${label}: malformed response (not a JSON object).`);
  return data;
}

// ---------- OAuth client + tokens ----------

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expiry_date: number; // epoch ms
  scope?: string;
  token_type?: string;
}

export type TokenProvider = () => Promise<string>;

// The Desktop-app client JSON downloaded from Google Cloud ({ installed: {...} }).
export function loadClient(p: OwnerPaths = ownerPaths()): OAuthClient {
  if (!existsSync(p.client)) {
    throw new Error(`OAuth client file missing. Download the Desktop-app OAuth client JSON from Google Cloud and save it as ${p.client}`);
  }
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(p.client, "utf8"));
  } catch {
    throw new Error(`OAuth client file ${p.client} is not valid JSON.`);
  }
  const c = raw?.installed;
  if (!c?.client_id || !c?.client_secret) {
    throw new Error(`OAuth client file ${p.client} is not a Desktop-app client (expected an "installed" block with client_id and client_secret).`);
  }
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function buildAuthUrl(o: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  const u = new URL(AUTH_URI);
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", o.state);
  u.searchParams.set("code_challenge", o.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

function toTokenSet(data: any, previous?: TokenSet, now = Date.now()): TokenSet {
  if (!data?.access_token || typeof data.expires_in !== "number") throw new Error("OAuth token response malformed (missing access_token/expires_in).");
  return {
    access_token: data.access_token,
    // Google omits refresh_token on refresh; keep the one we have.
    refresh_token: data.refresh_token ?? previous?.refresh_token,
    expiry_date: now + data.expires_in * 1000,
    scope: data.scope ?? previous?.scope,
    token_type: data.token_type,
  };
}

// The granted scopes must be exactly the two we asked for (the user can untick one).
export function assertGrantedScopes(scope: string | undefined): void {
  const granted = (scope ?? "").split(/\s+/).filter(Boolean).sort();
  const want = [...SCOPES].sort();
  if (granted.join(" ") !== want.join(" ")) {
    throw new Error(`Granted scopes do not match. Expected exactly: ${want.join(", ")}. Got: ${granted.join(", ") || "(none)"}. Re-run npm run youtube:auth and allow both.`);
  }
}

export async function exchangeCode(client: OAuthClient, code: string, redirectUri: string, verifier: string): Promise<TokenSet> {
  const res = await request("POST", TOKEN_URI, {
    label: "OAuth token exchange",
    form: { code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier },
  });
  const tokens = toTokenSet(await res.json().catch(() => null));
  if (!tokens.refresh_token) throw new Error("Google returned no refresh token. Remove PB4 from https://myaccount.google.com/permissions and run npm run youtube:auth again.");
  return tokens;
}

export async function refreshTokens(client: OAuthClient, current: TokenSet): Promise<TokenSet> {
  if (!current.refresh_token) throw new Error("No refresh token stored. Run npm run youtube:auth.");
  try {
    const res = await request("POST", TOKEN_URI, {
      label: "OAuth token refresh",
      form: { client_id: client.clientId, client_secret: client.clientSecret, refresh_token: current.refresh_token, grant_type: "refresh_token" },
    });
    return toTokenSet(await res.json().catch(() => null), current);
  } catch (e) {
    if (e instanceof YouTubeHttpError && /invalid_grant/.test(e.body)) {
      throw new Error("Stored YouTube authorization was revoked or expired (invalid_grant). Run npm run youtube:auth again.");
    }
    throw e;
  }
}

export function saveTokens(tokens: TokenSet, p: OwnerPaths = ownerPaths()): void {
  mkdirSync(p.root, { recursive: true });
  writeFileSync(p.token, JSON.stringify(tokens, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function loadTokens(p: OwnerPaths = ownerPaths()): TokenSet {
  if (!existsSync(p.token)) throw new Error("Not authenticated with YouTube. Run npm run youtube:auth first.");
  try {
    const t = JSON.parse(readFileSync(p.token, "utf8"));
    if (!t?.access_token || typeof t.expiry_date !== "number") throw new Error();
    return t;
  } catch {
    throw new Error(`Token file ${p.token} is malformed. Run npm run youtube:auth again.`);
  }
}

// Access tokens from the stored token file, refreshed (and re-saved) when within
// a minute of expiry.
export function fileTokenProvider(p: OwnerPaths = ownerPaths(), now = () => Date.now()): TokenProvider {
  let tokens: TokenSet | undefined;
  return async () => {
    tokens ??= loadTokens(p);
    if (tokens.expiry_date - 60_000 <= now()) {
      tokens = await refreshTokens(loadClient(p), tokens);
      saveTokens(tokens, p);
    }
    return tokens.access_token;
  };
}

// ---------- Data API: identity + inventory ----------

export interface OwnerChannel {
  id: string;
  title: string;
  uploadsPlaylistId: string;
  publishedAt: string;
}

export async function getMyChannel(auth: TokenProvider): Promise<OwnerChannel> {
  const url = new URL(`${DATA_API}/channels`);
  url.searchParams.set("part", "snippet,contentDetails");
  url.searchParams.set("mine", "true");
  const data = await getJson(url.toString(), await auth(), "YouTube channels.list(mine)");
  const ch = data.items?.[0];
  if (!ch?.id) throw new Error("The authenticated Google account has no YouTube channel.");
  return {
    id: ch.id,
    title: ch.snippet?.title ?? "",
    uploadsPlaylistId: ch.contentDetails?.relatedPlaylists?.uploads ?? "",
    publishedAt: ch.snippet?.publishedAt ?? "",
  };
}

export function verifyChannel(ch: { id: string; title: string }): void {
  if (ch.id !== PASTBRIEFLY_CHANNEL_ID) {
    throw new Error(`Authenticated channel is ${ch.id} ("${ch.title}"), not PastBriefly (${PASTBRIEFLY_CHANNEL_ID}). Stopping: nothing was saved or collected. Re-run npm run youtube:auth and pick the PastBriefly channel.`);
  }
}

export interface OwnerVideo {
  videoId: string;
  title: string;
  publishedAt: string;
  duration: string; // ISO 8601, as returned
  privacyStatus: string;
  url: string;
  publicStats: { viewCount?: number; likeCount?: number; commentCount?: number };
}

export async function listUploads(auth: TokenProvider, uploadsPlaylistId: string): Promise<OwnerVideo[]> {
  const ids: string[] = [];
  let pageToken = "";
  do {
    const url = new URL(`${DATA_API}/playlistItems`);
    url.searchParams.set("part", "contentDetails");
    url.searchParams.set("playlistId", uploadsPlaylistId);
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await getJson(url.toString(), await auth(), "YouTube playlistItems.list(uploads)");
    for (const it of data.items ?? []) if (it?.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);

  const videos: OwnerVideo[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const url = new URL(`${DATA_API}/videos`);
    url.searchParams.set("part", "snippet,contentDetails,status,statistics");
    url.searchParams.set("id", ids.slice(i, i + 50).join(","));
    const data = await getJson(url.toString(), await auth(), "YouTube videos.list");
    for (const v of data.items ?? []) {
      const num = (x: unknown) => (x === undefined ? undefined : Number(x));
      videos.push({
        videoId: v.id,
        title: v.snippet?.title ?? "",
        publishedAt: v.snippet?.publishedAt ?? "",
        duration: v.contentDetails?.duration ?? "",
        privacyStatus: v.status?.privacyStatus ?? "",
        url: `https://www.youtube.com/shorts/${v.id}`,
        publicStats: { viewCount: num(v.statistics?.viewCount), likeCount: num(v.statistics?.likeCount), commentCount: num(v.statistics?.commentCount) },
      });
    }
  }
  return videos;
}

// ---------- Analytics API ----------

export const VIDEO_METRICS = [
  "views",
  "engagedViews",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "likes",
  "comments",
  "shares",
  "subscribersGained",
  "subscribersLost",
] as const;
export const TRAFFIC_METRICS = ["views", "estimatedMinutesWatched"] as const;
export const RETENTION_METRICS = ["audienceWatchRatio", "relativeRetentionPerformance"] as const;

export interface AnalyticsQuery {
  startDate: string;
  endDate: string;
  metrics: readonly string[];
  dimensions?: string;
  filters?: string;
  sort?: string;
  maxResults?: number;
}

export function analyticsUrl(q: AnalyticsQuery): string {
  const url = new URL(ANALYTICS_API);
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", q.startDate);
  url.searchParams.set("endDate", q.endDate);
  url.searchParams.set("metrics", q.metrics.join(","));
  if (q.dimensions) url.searchParams.set("dimensions", q.dimensions);
  if (q.filters) url.searchParams.set("filters", q.filters);
  if (q.sort) url.searchParams.set("sort", q.sort);
  if (q.maxResults) url.searchParams.set("maxResults", String(q.maxResults));
  return url.toString();
}

export type Row = Record<string, string | number | null>;

// Map rows by the response's columnHeaders, never by assumed column order.
export function mapRows(data: any): { columns: string[]; rows: Row[] } {
  if (!Array.isArray(data?.columnHeaders)) throw new Error("YouTube Analytics: malformed response (no columnHeaders).");
  const columns: string[] = data.columnHeaders.map((h: any) => String(h?.name));
  const rows = (Array.isArray(data.rows) ? data.rows : []).map((r: any[]) => Object.fromEntries(columns.map((c, i) => [c, r?.[i] ?? null])));
  return { columns, rows };
}

export async function queryAnalytics(auth: TokenProvider, q: AnalyticsQuery) {
  const data = await getJson(analyticsUrl(q), await auth(), `YouTube Analytics reports.query(${q.dimensions ?? "totals"})`);
  return { query: q, ...mapRows(data) };
}

// engagedViews is a newer metric; if this channel/report rejects it, retry once
// without it and say so rather than failing the whole snapshot.
export async function queryWithOptionalEngaged(auth: TokenProvider, q: AnalyticsQuery) {
  try {
    return { ...(await queryAnalytics(auth, q)), omittedMetrics: [] as string[] };
  } catch (e) {
    if (!(e instanceof YouTubeHttpError) || e.status !== 400 || !q.metrics.includes("engagedViews")) throw e;
    const retry = { ...q, metrics: q.metrics.filter((m) => m !== "engagedViews") };
    return { ...(await queryAnalytics(auth, retry)), omittedMetrics: ["engagedViews"] };
  }
}

// Audience retention for one video (the API allows exactly one per query).
export function retentionQuery(videoId: string, startDate: string, endDate: string): AnalyticsQuery {
  if (!videoId || videoId.includes(",")) throw new Error("Retention queries take exactly one video id.");
  return { startDate, endDate, dimensions: "elapsedVideoTimeRatio", metrics: RETENTION_METRICS, filters: `video==${videoId}`, sort: "elapsedVideoTimeRatio" };
}

export const RETENTION_POINTS = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 1] as const;

// Convenience points: the row whose elapsedVideoTimeRatio is nearest each target,
// with the actual ratio it came from. Values are copied, not interpolated.
export function retentionPoints(rows: Row[]) {
  if (!rows.length) return [];
  return RETENTION_POINTS.map((target) => {
    const nearest = rows.reduce((best, r) => (Math.abs(Number(r.elapsedVideoTimeRatio) - target) < Math.abs(Number(best.elapsedVideoTimeRatio) - target) ? r : best));
    return {
      target,
      elapsedVideoTimeRatio: Number(nearest.elapsedVideoTimeRatio),
      audienceWatchRatio: nearest.audienceWatchRatio ?? null,
      relativeRetentionPerformance: nearest.relativeRetentionPerformance ?? null,
    };
  });
}

// ---------- snapshot ----------

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Default window: the 28 complete days ending yesterday (UTC), like YouTube
// Studio's default. The last 2-3 days can still be provisional.
export function resolveRange(args: { start?: string; end?: string }, today = new Date()): { startDate: string; endDate: string } {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const endDate = args.end ?? day(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1)));
  const startDate = args.start ?? day(new Date(Date.parse(`${endDate}T00:00:00Z`) - 27 * 86_400_000));
  for (const d of [startDate, endDate]) if (!DATE.test(d) || Number.isNaN(Date.parse(d))) throw new Error(`Invalid date ${d}; use YYYY-MM-DD.`);
  if (startDate > endDate) throw new Error(`--start ${startDate} is after --end ${endDate}.`);
  return { startDate, endDate };
}

export interface SnapshotMeta {
  source: string;
  channelId: string;
  startDate?: string;
  endDate?: string;
  retrievedAt: string;
  metrics?: readonly string[];
  dimensions?: string;
  note?: string;
}

export async function takeSnapshot(
  auth: TokenProvider,
  opts: { startDate: string; endDate: string; videoIds?: string[]; paths?: OwnerPaths; now?: () => Date; log?: (s: string) => void },
): Promise<string> {
  const p = opts.paths ?? ownerPaths();
  const log = opts.log ?? (() => {});
  const retrievedAt = (opts.now?.() ?? new Date()).toISOString();
  const { startDate, endDate } = opts;

  const channel = await getMyChannel(auth);
  verifyChannel(channel);
  const meta = (m: Omit<SnapshotMeta, "channelId" | "retrievedAt">): SnapshotMeta => ({ channelId: channel.id, retrievedAt, ...m });

  log(`Channel ${channel.id} (${channel.title})`);
  const videos = await listUploads(auth, channel.uploadsPlaylistId);
  log(`Uploads: ${videos.length}`);

  const totals = await queryWithOptionalEngaged(auth, { startDate, endDate, metrics: VIDEO_METRICS });
  const perVideo = await queryWithOptionalEngaged(auth, { startDate, endDate, metrics: VIDEO_METRICS, dimensions: "video", sort: "-views", maxResults: 200 });
  const traffic = await queryAnalytics(auth, { startDate, endDate, metrics: TRAFFIC_METRICS, dimensions: "insightTrafficSourceType", sort: "-views" });

  const selected = opts.videoIds?.length ? videos.filter((v) => opts.videoIds!.includes(v.videoId)) : videos;
  const retention = [];
  for (const v of selected) {
    const r = await queryAnalytics(auth, retentionQuery(v.videoId, startDate, endDate));
    retention.push({ videoId: v.videoId, title: v.title, columns: r.columns, rows: r.rows, points: retentionPoints(r.rows) });
    log(`Retention ${v.videoId}: ${r.rows.length ? `${r.rows.length} rows` : "no data in range"}`);
  }

  const dir = path.join(p.snapshots, retrievedAt.slice(0, 10), `${startDate}_${endDate}`);
  mkdirSync(dir, { recursive: true });
  const write = (name: string, body: unknown) => writeFileSync(path.join(dir, name), JSON.stringify(body, null, 2), "utf8");
  const range = { startDate, endDate };
  write("channel.json", {
    meta: meta({ source: "YouTube Data API v3 channels.list + Analytics API v2 reports.query (no dimension)", ...range, metrics: totals.query.metrics, note: "channel identity is current as of retrievedAt; totals cover the date range" }),
    channel,
    omittedMetrics: totals.omittedMetrics,
    totals: totals.rows[0] ?? null,
  });
  write("videos.json", {
    meta: meta({ source: "YouTube Data API v3 playlistItems.list + videos.list", note: "inventory and publicStats are current as of retrievedAt, not bound to the date range" }),
    videos,
  });
  write("video-metrics.json", {
    meta: meta({ source: "YouTube Analytics API v2 reports.query", ...range, metrics: perVideo.query.metrics, dimensions: "video" }),
    omittedMetrics: perVideo.omittedMetrics,
    columns: perVideo.columns,
    rows: perVideo.rows,
  });
  write("traffic.json", {
    meta: meta({ source: "YouTube Analytics API v2 reports.query", ...range, metrics: TRAFFIC_METRICS, dimensions: "insightTrafficSourceType" }),
    columns: traffic.columns,
    rows: traffic.rows,
  });
  write("retention.json", {
    meta: meta({ source: "YouTube Analytics API v2 reports.query (one video per query)", ...range, metrics: RETENTION_METRICS, dimensions: "elapsedVideoTimeRatio", note: "rows are the API curve as returned; points are the nearest returned row to each target ratio" }),
    videos: retention,
  });
  return dir;
}

// ---------- Reporting API ----------

export interface ReportingJob {
  id: string;
  reportTypeId: string;
  name?: string;
  createTime?: string;
}

async function listAll(auth: TokenProvider, base: string, key: string, label: string): Promise<any[]> {
  const out: any[] = [];
  let pageToken = "";
  do {
    const url = new URL(base);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await getJson(url.toString(), await auth(), label);
    out.push(...(Array.isArray(data[key]) ? data[key] : []));
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

export async function listReportTypes(auth: TokenProvider): Promise<string[]> {
  const types = await listAll(auth, `${REPORTING_API}/reportTypes`, "reportTypes", "YouTube Reporting reportTypes.list");
  return types.map((t) => t?.id).filter((id): id is string => typeof id === "string");
}

export async function listJobs(auth: TokenProvider): Promise<ReportingJob[]> {
  const jobs = await listAll(auth, `${REPORTING_API}/jobs`, "jobs", "YouTube Reporting jobs.list");
  return jobs.filter((j) => j?.id && j?.reportTypeId);
}

export interface JobsFile {
  channelId: string;
  updatedAt: string;
  jobs: ReportingJob[];
  unsupported: string[];
}

// Idempotent: reuse any existing job for a wanted report type, create only the
// missing ones, and never touch other report types.
export async function initReportingJobs(auth: TokenProvider, opts: { paths?: OwnerPaths; now?: () => Date; log?: (s: string) => void } = {}): Promise<JobsFile> {
  const p = opts.paths ?? ownerPaths();
  const log = opts.log ?? (() => {});
  const channel = await getMyChannel(auth);
  verifyChannel(channel);

  const [types, existing] = [await listReportTypes(auth), await listJobs(auth)];
  const jobs: ReportingJob[] = [];
  const unsupported: string[] = [];
  for (const type of REPORT_TYPES) {
    const have = existing.find((j) => j.reportTypeId === type);
    if (have) {
      jobs.push(have);
      log(`exists   ${type}  job ${have.id}`);
      continue;
    }
    if (!types.includes(type)) {
      unsupported.push(type);
      log(`skipped  ${type}  (not offered for this channel)`);
      continue;
    }
    const res = await request("POST", `${REPORTING_API}/jobs`, { token: await auth(), json: { reportTypeId: type, name: `pb4-${type}` }, label: `YouTube Reporting jobs.create(${type})` });
    const job = (await res.json().catch(() => null)) as ReportingJob | null;
    if (!job?.id) throw new Error(`YouTube Reporting jobs.create(${type}): malformed response (no job id).`);
    jobs.push({ id: job.id, reportTypeId: job.reportTypeId ?? type, name: job.name, createTime: job.createTime });
    log(`created  ${type}  job ${job.id}`);
  }

  const file: JobsFile = { channelId: channel.id, updatedAt: (opts.now?.() ?? new Date()).toISOString(), jobs, unsupported };
  mkdirSync(p.root, { recursive: true });
  writeFileSync(p.jobs, JSON.stringify(file, null, 2), "utf8");
  return file;
}

export interface ReportEntry {
  id: string;
  jobId: string;
  startTime: string;
  endTime: string;
  createTime: string;
  downloadUrl: string;
}

export async function listReports(auth: TokenProvider, jobId: string): Promise<ReportEntry[]> {
  const reports = await listAll(auth, `${REPORTING_API}/jobs/${encodeURIComponent(jobId)}/reports`, "reports", `YouTube Reporting reports.list(${jobId})`);
  return reports.filter((r) => r?.id && r?.downloadUrl && r?.startTime && r?.endTime);
}

// For each data period keep only the report with the newest createTime; YouTube
// publishes backfills/corrections as new reports covering the same period.
export function newestPerPeriod(reports: ReportEntry[]): ReportEntry[] {
  const best = new Map<string, ReportEntry>();
  for (const r of reports) {
    const key = `${r.startTime}|${r.endTime}`;
    const cur = best.get(key);
    if (!cur || r.createTime > cur.createTime) best.set(key, r);
  }
  return [...best.values()].sort((a, b) => a.startTime.localeCompare(b.startTime));
}

export interface ReportIndexEntry {
  reportId: string;
  jobId: string;
  reportTypeId: string;
  startTime: string;
  endTime: string;
  createTime: string;
  file: string; // relative to the reports dir
  downloadedAt: string;
  current: boolean; // false once a newer report for the same period is stored
}

export async function downloadReport(auth: TokenProvider, downloadUrl: string): Promise<string> {
  const res = await request("GET", downloadUrl, { token: await auth(), label: "YouTube Reporting media.download" });
  return res.text();
}

export async function syncReports(auth: TokenProvider, opts: { paths?: OwnerPaths; now?: () => Date; log?: (s: string) => void } = {}) {
  const p = opts.paths ?? ownerPaths();
  const log = opts.log ?? (() => {});
  if (!existsSync(p.jobs)) throw new Error(`No reporting jobs recorded at ${p.jobs}. Run npm run youtube:reporting:init first.`);
  const jobsFile = JSON.parse(readFileSync(p.jobs, "utf8")) as JobsFile;
  const indexPath = path.join(p.reports, "index.json");
  const index: ReportIndexEntry[] = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : [];
  const stored = new Set(index.map((e) => e.reportId));
  let downloaded = 0;

  for (const job of jobsFile.jobs) {
    const available = await listReports(auth, job.id);
    if (!available.length) {
      log(`${job.reportTypeId}: no reports ready yet (new jobs usually take up to 48 hours). Not an error.`);
      continue;
    }
    const wanted = newestPerPeriod(available).filter((r) => !stored.has(r.id));
    log(`${job.reportTypeId}: ${available.length} available, ${wanted.length} new to download`);
    for (const r of wanted) {
      const csv = await downloadReport(auth, r.downloadUrl);
      const rel = path.join(job.reportTypeId, `${r.startTime.slice(0, 10)}_${r.endTime.slice(0, 10)}__${r.id}.csv`);
      mkdirSync(path.join(p.reports, job.reportTypeId), { recursive: true });
      writeFileSync(path.join(p.reports, rel), csv, "utf8");
      for (const e of index) {
        if (e.reportTypeId === job.reportTypeId && e.startTime === r.startTime && e.endTime === r.endTime && e.createTime < r.createTime) e.current = false;
      }
      const newerStored = index.some((e) => e.reportTypeId === job.reportTypeId && e.startTime === r.startTime && e.endTime === r.endTime && e.createTime > r.createTime);
      index.push({
        reportId: r.id,
        jobId: job.id,
        reportTypeId: job.reportTypeId,
        startTime: r.startTime,
        endTime: r.endTime,
        createTime: r.createTime,
        file: rel.replace(/\\/g, "/"),
        downloadedAt: (opts.now?.() ?? new Date()).toISOString(),
        current: !newerStored,
      });
      stored.add(r.id);
      downloaded++;
    }
  }

  mkdirSync(p.reports, { recursive: true });
  writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf8");
  return { downloaded, index };
}
