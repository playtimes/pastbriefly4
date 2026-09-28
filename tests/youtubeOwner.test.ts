import { describe, test, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// YouTube owner analytics: OAuth scopes/tokens, channel verification, Analytics
// and Reporting request shapes, snapshot output, and the read-only guard.
// fetch is stubbed throughout; any unexpected URL throws. No Google calls.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-ytowner-"));
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const yt = await import("../src/providers/youtubeOwner.ts");
const { ROOT } = await import("../src/server/config.ts");

const PB = yt.PASTBRIEFLY_CHANNEL_ID;
const ACCESS = "ya29.test-access-token";
const REFRESH = "1//test-refresh-token";
const SECRET = "GOCSPX-test-client-secret";

let n = 0;
const freshPaths = () => yt.ownerPaths(path.join(tmp, `yt-${++n}`));
const staticAuth = async () => ACCESS;

function res(body: any, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status < 400, status, json: async () => JSON.parse(text), text: async () => text } as any;
}

type Handler = (u: URL, init: any) => any;
function stubFetch(routes: [RegExp, Handler][]) {
  const calls: { method: string; url: string; init: any }[] = [];
  global.fetch = vi.fn(async (url: any, init: any = {}) => {
    const u = new URL(String(url));
    calls.push({ method: init.method ?? "GET", url: u.toString(), init });
    for (const [re, h] of routes) if (re.test(`${init.method ?? "GET"} ${u.origin}${u.pathname}`)) return h(u, init);
    throw new Error(`unexpected fetch ${init.method} ${u}`);
  }) as any;
  return calls;
}

const channelRoute = (id = PB): [RegExp, Handler] => [
  /GET https:\/\/www\.googleapis\.com\/youtube\/v3\/channels$/,
  () => res({ items: [{ id, snippet: { title: id === PB ? "PastBriefly" : "Someone Else", publishedAt: "2026-07-01T00:00:00Z" }, contentDetails: { relatedPlaylists: { uploads: "UUpl" } } }] }),
];

afterEach(() => vi.restoreAllMocks());

describe("auth", () => {
  test("requests exactly the two read-only scopes, offline, with PKCE", () => {
    expect([...yt.SCOPES]).toEqual(["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"]);
    const url = new URL(yt.buildAuthUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:5555", state: "st", codeChallenge: "ch" }));
    expect(url.searchParams.get("scope")!.split(" ")).toEqual([...yt.SCOPES]);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5555");
    expect(url.searchParams.get("include_granted_scopes")).toBeNull();
    const src = readFileSync(path.join(ROOT, "src/providers/youtubeOwner.ts"), "utf8");
    for (const bad of ["auth/youtube\"", "youtube.force-ssl", "youtube.upload", "monetary", "youtubepartner", "urn:ietf:wg:oauth:2.0:oob"]) expect(src).not.toContain(bad);
  });

  test("granted scopes must match exactly", () => {
    expect(() => yt.assertGrantedScopes(yt.SCOPES.join(" "))).not.toThrow();
    expect(() => yt.assertGrantedScopes(yt.SCOPES[0])).toThrow(/Granted scopes/);
    expect(() => yt.assertGrantedScopes(`${yt.SCOPES.join(" ")} https://www.googleapis.com/auth/youtube`)).toThrow(/Granted scopes/);
  });

  test("credential and token files live under the gitignored data/ tree", () => {
    const def = yt.ownerPaths();
    for (const f of [def.client, def.token, def.jobs, def.snapshots, def.reports]) {
      expect(path.relative(process.env.PB4_DATA_DIR!, f).startsWith("..")).toBe(false);
    }
    // With the default data dir, that is <repo>/data/analytics/youtube, ignored by `data/`.
    expect(readFileSync(path.join(ROOT, ".gitignore"), "utf8")).toMatch(/^data\/$/m);
    expect(path.relative(process.env.PB4_DATA_DIR!, def.token).replace(/\\/g, "/")).toBe("analytics/youtube/oauth-token.json");
  });

  test("missing and non-Desktop client files fail clearly", () => {
    const p = freshPaths();
    expect(() => yt.loadClient(p)).toThrow(/OAuth client file missing.*oauth-client\.json/);
    yt.saveTokens({ access_token: "x", expiry_date: 0 }, p); // creates the dir
    writeFileSync(p.client, JSON.stringify({ web: { client_id: "a", client_secret: "b" } }));
    expect(() => yt.loadClient(p)).toThrow(/not a Desktop-app client/);
  });

  test("unauthenticated state fails clearly", async () => {
    const p = freshPaths();
    await expect(yt.fileTokenProvider(p)()).rejects.toThrow(/Not authenticated.*youtube:auth/);
  });

  test("exchange persists refresh token to the token path", async () => {
    const p = freshPaths();
    const calls = stubFetch([[/POST https:\/\/oauth2\.googleapis\.com\/token$/, () => res({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: yt.SCOPES.join(" ") })]]);
    const t = await yt.exchangeCode({ clientId: "cid", clientSecret: SECRET }, "auth-code-123", "http://127.0.0.1:1", "verifier");
    const body = new URLSearchParams(calls[0].init.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("verifier");
    yt.saveTokens(t, p);
    expect(JSON.parse(readFileSync(p.token, "utf8")).refresh_token).toBe(REFRESH);
  });

  test("expired access token is refreshed, keeps the refresh token, and leaks nothing", async () => {
    const p = freshPaths();
    yt.saveTokens({ access_token: "ya29.old", refresh_token: REFRESH, expiry_date: 1000 }, p);
    writeFileSync(p.client, JSON.stringify({ installed: { client_id: "cid", client_secret: SECRET } }));
    const log = vi.spyOn(console, "log");
    const err = vi.spyOn(console, "error");
    const calls = stubFetch([[/POST https:\/\/oauth2\.googleapis\.com\/token$/, () => res({ access_token: "ya29.new", expires_in: 3600 })]]);
    const token = await yt.fileTokenProvider(p, () => 2000)();
    expect(token).toBe("ya29.new");
    expect(new URLSearchParams(calls[0].init.body).get("grant_type")).toBe("refresh_token");
    const saved = JSON.parse(readFileSync(p.token, "utf8"));
    expect(saved.refresh_token).toBe(REFRESH);
    expect(saved.access_token).toBe("ya29.new");
    const printed = [...log.mock.calls, ...err.mock.calls].flat().join(" ");
    for (const s of [REFRESH, SECRET, "ya29"]) expect(printed).not.toContain(s);
  });

  test("revoked refresh token gives a re-auth message without the token", async () => {
    const p = freshPaths();
    yt.saveTokens({ access_token: "ya29.old", refresh_token: REFRESH, expiry_date: 0 }, p);
    writeFileSync(p.client, JSON.stringify({ installed: { client_id: "cid", client_secret: SECRET } }));
    stubFetch([[/POST https:\/\/oauth2\.googleapis\.com\/token$/, () => res({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400)]]);
    const e = await yt.fileTokenProvider(p)().catch((x) => x);
    expect(e.message).toMatch(/revoked or expired.*youtube:auth/);
    expect(e.message).not.toContain(REFRESH);
  });

  test("HTTP errors carry endpoint/status context and redact tokens", async () => {
    stubFetch([[/GET https:\/\/www\.googleapis\.com\/youtube\/v3\/channels$/, () => res(`{"error":"bad","access_token":"${ACCESS}"}`, 403)]]);
    const e = await yt.getMyChannel(staticAuth).catch((x) => x);
    expect(e.message).toMatch(/channels\.list\(mine\) 403/);
    expect(e.message).not.toContain(ACCESS);
  });

  test("channel identity: PastBriefly passes, another channel is rejected", async () => {
    stubFetch([channelRoute()]);
    const ch = await yt.getMyChannel(staticAuth);
    expect(ch).toMatchObject({ id: PB, uploadsPlaylistId: "UUpl" });
    expect(() => yt.verifyChannel(ch)).not.toThrow();
    expect(() => yt.verifyChannel({ id: "UCother", title: "Other" })).toThrow(/not PastBriefly/);
  });

  test("wrong channel stops a snapshot before anything is written", async () => {
    const p = freshPaths();
    const calls = stubFetch([channelRoute("UCother")]);
    await expect(yt.takeSnapshot(staticAuth, { startDate: "2026-08-01", endDate: "2026-09-26", paths: p })).rejects.toThrow(/not PastBriefly/);
    expect(calls).toHaveLength(1);
    expect(existsSync(p.snapshots)).toBe(false);
  });
});

describe("analytics", () => {
  test("query URL carries the owner channel, range and metrics", () => {
    const u = new URL(yt.analyticsUrl({ startDate: "2026-08-01", endDate: "2026-09-26", metrics: yt.VIDEO_METRICS, dimensions: "video", sort: "-views", maxResults: 200 }));
    expect(u.origin + u.pathname).toBe("https://youtubeanalytics.googleapis.com/v2/reports");
    expect(u.searchParams.get("ids")).toBe("channel==MINE");
    expect(u.searchParams.get("startDate")).toBe("2026-08-01");
    expect(u.searchParams.get("endDate")).toBe("2026-09-26");
    expect(u.searchParams.get("metrics")!.split(",")).toEqual([...yt.VIDEO_METRICS]);
    expect(u.searchParams.get("dimensions")).toBe("video");
  });

  test("retention query is exactly one video", () => {
    const q = yt.retentionQuery("vid1", "2026-08-01", "2026-09-26");
    expect(q).toMatchObject({ dimensions: "elapsedVideoTimeRatio", filters: "video==vid1", metrics: ["audienceWatchRatio", "relativeRetentionPerformance"] });
    expect(() => yt.retentionQuery("a,b", "2026-08-01", "2026-09-26")).toThrow(/exactly one/);
    expect(() => yt.retentionQuery("", "2026-08-01", "2026-09-26")).toThrow(/exactly one/);
  });

  test("rows map by columnHeaders, not assumed order", () => {
    const out = yt.mapRows({ columnHeaders: [{ name: "likes" }, { name: "video" }, { name: "views" }], rows: [[3, "v1", 100]] });
    expect(out.rows).toEqual([{ likes: 3, video: "v1", views: 100 }]);
  });

  test("empty and malformed responses", () => {
    expect(yt.mapRows({ columnHeaders: [{ name: "views" }] }).rows).toEqual([]);
    expect(() => yt.mapRows({ rows: [[1]] })).toThrow(/malformed/);
    expect(yt.retentionPoints([])).toEqual([]);
  });

  test("retention points copy the nearest returned rows", () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({ elapsedVideoTimeRatio: i / 100, audienceWatchRatio: 1 - i / 200, relativeRetentionPerformance: 0.5 }));
    const pts = yt.retentionPoints(rows);
    expect(pts.map((p) => p.target)).toEqual([0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 1]);
    expect(pts[3]).toEqual({ target: 0.5, elapsedVideoTimeRatio: 0.5, audienceWatchRatio: 0.75, relativeRetentionPerformance: 0.5 });
  });

  test("default and explicit date ranges", () => {
    expect(yt.resolveRange({}, new Date("2026-09-27T12:00:00Z"))).toEqual({ startDate: "2026-08-30", endDate: "2026-09-26" });
    expect(yt.resolveRange({ start: "2026-08-01", end: "2026-09-26" })).toEqual({ startDate: "2026-08-01", endDate: "2026-09-26" });
    expect(() => yt.resolveRange({ start: "2026-09-30", end: "2026-09-01" })).toThrow(/after/);
    expect(() => yt.resolveRange({ start: "Aug 1" })).toThrow(/YYYY-MM-DD/);
  });

  test("snapshot writes labelled files for one range, with retention per video", async () => {
    const p = freshPaths();
    const analyticsCalls: URLSearchParams[] = [];
    const calls = stubFetch([
      channelRoute(),
      [/GET .*\/youtube\/v3\/playlistItems$/, () => res({ items: [{ contentDetails: { videoId: "v1" } }, { contentDetails: { videoId: "v2" } }] })],
      [
        /GET .*\/youtube\/v3\/videos$/,
        () => res({ items: ["v1", "v2"].map((id) => ({ id, snippet: { title: `T ${id}`, publishedAt: "2026-08-06T10:00:00Z" }, contentDetails: { duration: "PT45S" }, status: { privacyStatus: "public" }, statistics: { viewCount: "10" } })) }),
      ],
      [
        /GET https:\/\/youtubeanalytics\.googleapis\.com\/v2\/reports$/,
        (u) => {
          analyticsCalls.push(u.searchParams);
          const dim = u.searchParams.get("dimensions");
          const metrics = u.searchParams.get("metrics")!.split(",");
          if (metrics.includes("engagedViews")) return res({ error: { message: "Unknown identifier (engagedViews)" } }, 400);
          if (dim === "elapsedVideoTimeRatio") {
            if (u.searchParams.get("filters") === "video==v2") return res({ columnHeaders: [{ name: "elapsedVideoTimeRatio" }, { name: "audienceWatchRatio" }, { name: "relativeRetentionPerformance" }] });
            return res({ columnHeaders: [{ name: "elapsedVideoTimeRatio" }, { name: "audienceWatchRatio" }, { name: "relativeRetentionPerformance" }], rows: [[0.01, 1.2, 0.6], [1, 0.4, 0.5]] });
          }
          if (dim === "insightTrafficSourceType") return res({ columnHeaders: [{ name: "insightTrafficSourceType" }, { name: "views" }, { name: "estimatedMinutesWatched" }], rows: [["SHORTS", 900, 300]] });
          const headers = [...(dim ? [dim] : []), ...metrics].map((name) => ({ name }));
          return res({ columnHeaders: headers, rows: [[...(dim ? ["v1"] : []), ...metrics.map(() => 1)]] });
        },
      ],
    ]);
    const dir = await yt.takeSnapshot(staticAuth, { startDate: "2026-08-01", endDate: "2026-09-26", paths: p, now: () => new Date("2026-09-27T09:00:00Z") });

    expect(dir).toBe(path.join(p.snapshots, "2026-09-27", "2026-08-01_2026-09-26"));
    expect(readdirSync(dir).sort()).toEqual(["channel.json", "retention.json", "traffic.json", "video-metrics.json", "videos.json"]);
    const metrics = JSON.parse(readFileSync(path.join(dir, "video-metrics.json"), "utf8"));
    expect(metrics.meta).toMatchObject({ channelId: PB, startDate: "2026-08-01", endDate: "2026-09-26", retrievedAt: "2026-09-27T09:00:00.000Z", dimensions: "video" });
    expect(metrics.omittedMetrics).toEqual(["engagedViews"]);
    expect(metrics.meta.metrics).not.toContain("engagedViews");
    const videos = JSON.parse(readFileSync(path.join(dir, "videos.json"), "utf8"));
    expect(videos.meta.startDate).toBeUndefined(); // inventory is not range-bound
    expect(videos.videos[0]).toMatchObject({ videoId: "v1", duration: "PT45S", privacyStatus: "public" });
    const retention = JSON.parse(readFileSync(path.join(dir, "retention.json"), "utf8"));
    expect(retention.videos.map((v: any) => v.rows.length)).toEqual([2, 0]);
    expect(retention.videos[0].rows[0]).toEqual({ elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1.2, relativeRetentionPerformance: 0.6 });
    expect(retention.videos[1].points).toEqual([]);

    const retentionCalls = analyticsCalls.filter((q) => q.get("dimensions") === "elapsedVideoTimeRatio");
    expect(retentionCalls.map((q) => q.get("filters"))).toEqual(["video==v1", "video==v2"]);
    for (const q of analyticsCalls) expect([q.get("startDate"), q.get("endDate")]).toEqual(["2026-08-01", "2026-09-26"]);
    for (const c of calls) expect(c.method).toBe("GET");
    expect(JSON.stringify(readdirSync(dir).map((f) => readFileSync(path.join(dir, f), "utf8")))).not.toContain(ACCESS);
  });
});

describe("reporting", () => {
  const typesRoute = (ids: string[]): [RegExp, Handler] => [/GET https:\/\/youtubereporting\.googleapis\.com\/v1\/reportTypes$/, () => res({ reportTypes: ids.map((id) => ({ id, name: id })) })];

  test("reportTypes parsing follows pages", async () => {
    stubFetch([
      [
        /GET .*\/v1\/reportTypes$/,
        (u) => (u.searchParams.get("pageToken") ? res({ reportTypes: [{ id: "channel_reach_basic_a1" }] }) : res({ reportTypes: [{ id: "channel_basic_a3" }, {}], nextPageToken: "p2" })),
      ],
    ]);
    expect(await yt.listReportTypes(staticAuth)).toEqual(["channel_basic_a3", "channel_reach_basic_a1"]);
  });

  function stubJobs(existing: any[], offered: string[]) {
    const created: any[] = [];
    const calls = stubFetch([
      channelRoute(),
      typesRoute(offered),
      [/GET .*\/v1\/jobs$/, () => res({ jobs: [...existing, ...created] })],
      [
        /POST https:\/\/youtubereporting\.googleapis\.com\/v1\/jobs$/,
        (_u, init) => {
          const body = JSON.parse(init.body);
          const job = { id: `job-${body.reportTypeId}`, reportTypeId: body.reportTypeId, name: body.name, createTime: "2026-09-27T00:00:00Z" };
          created.push(job);
          return res(job);
        },
      ],
    ]);
    return { calls, created };
  }

  test("init creates only the three intended jobs, skipping unsupported and unrelated types", async () => {
    const p = freshPaths();
    const offered = ["channel_basic_a3", "channel_traffic_source_a3", "channel_demographics_a1", "channel_combined_a2"];
    const { created } = stubJobs([], offered);
    const file = await yt.initReportingJobs(staticAuth, { paths: p });
    expect(created.map((j) => j.reportTypeId)).toEqual(["channel_basic_a3", "channel_traffic_source_a3"]);
    expect(file.unsupported).toEqual(["channel_reach_basic_a1"]);
    expect(JSON.parse(readFileSync(p.jobs, "utf8")).jobs.map((j: any) => j.id)).toEqual(["job-channel_basic_a3", "job-channel_traffic_source_a3"]);
  });

  test("init is idempotent", async () => {
    const p = freshPaths();
    const { calls } = stubJobs([{ id: "old-1", reportTypeId: "channel_basic_a3" }, { id: "other", reportTypeId: "channel_demographics_a1" }], [...yt.REPORT_TYPES]);
    await yt.initReportingJobs(staticAuth, { paths: p });
    await yt.initReportingJobs(staticAuth, { paths: p });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => JSON.parse(c.init.body).reportTypeId)).toEqual(["channel_traffic_source_a3", "channel_reach_basic_a1"]);
    const file = JSON.parse(readFileSync(p.jobs, "utf8"));
    expect(file.jobs.map((j: any) => j.reportTypeId)).toEqual([...yt.REPORT_TYPES]);
    expect(file.jobs[0].id).toBe("old-1");
  });

  test("init refuses the wrong channel before touching jobs", async () => {
    const p = freshPaths();
    const calls = stubFetch([channelRoute("UCother")]);
    await expect(yt.initReportingJobs(staticAuth, { paths: p })).rejects.toThrow(/not PastBriefly/);
    expect(calls).toHaveLength(1);
  });

  function writeJobs(p: ReturnType<typeof yt.ownerPaths>, jobs: any[]) {
    yt.saveTokens({ access_token: ACCESS, expiry_date: Date.now() + 3_600_000 }, p);
    writeFileSync(p.jobs, JSON.stringify({ channelId: PB, updatedAt: "", jobs, unsupported: [] }));
  }

  test("sync prints nothing-ready-yet without failing", async () => {
    const p = freshPaths();
    writeJobs(p, [{ id: "j1", reportTypeId: "channel_reach_basic_a1" }]);
    stubFetch([[/GET .*\/v1\/jobs\/j1\/reports$/, () => res({})]]);
    const lines: string[] = [];
    const out = await yt.syncReports(staticAuth, { paths: p, log: (s) => lines.push(s) });
    expect(out.downloaded).toBe(0);
    expect(lines.join("\n")).toMatch(/no reports ready yet.*Not an error/);
  });

  test("sync without init fails clearly", async () => {
    await expect(yt.syncReports(staticAuth, { paths: freshPaths() })).rejects.toThrow(/reporting:init/);
  });

  const rep = (id: string, day: string, createTime: string) => ({
    id,
    jobId: "j1",
    startTime: `${day}T07:00:00Z`,
    endTime: `${day}T07:00:00Z`.replace(day, nextDay(day)),
    createTime,
    downloadUrl: `https://youtubereporting.googleapis.com/v1/media/CHANNEL/${id}?alt=media`,
  });
  const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

  test("newest createTime wins for the same period", () => {
    const picked = yt.newestPerPeriod([rep("a", "2026-09-20", "2026-09-22T00:00:00Z"), rep("b", "2026-09-20", "2026-09-25T00:00:00Z"), rep("c", "2026-09-21", "2026-09-23T00:00:00Z")]);
    expect(picked.map((r) => r.id)).toEqual(["b", "c"]);
  });

  test("sync downloads raw CSV once, keeps metadata, and a later backfill supersedes", async () => {
    const p = freshPaths();
    writeJobs(p, [{ id: "j1", reportTypeId: "channel_reach_basic_a1" }]);
    let available = [rep("r1", "2026-09-20", "2026-09-22T00:00:00Z")];
    const csv = (id: string) => `date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr\n20260920,${PB},v1,100,0.05 ${id}\n`;
    const calls = stubFetch([
      [/GET .*\/v1\/jobs\/j1\/reports$/, () => res({ reports: available })],
      [/GET https:\/\/youtubereporting\.googleapis\.com\/v1\/media\//, (u) => res(csv(u.pathname.split("/").pop()!))],
    ]);

    expect((await yt.syncReports(staticAuth, { paths: p })).downloaded).toBe(1);
    expect((await yt.syncReports(staticAuth, { paths: p })).downloaded).toBe(0); // already stored
    const media = () => calls.filter((c) => c.url.includes("/v1/media/"));
    expect(media()).toHaveLength(1);
    expect(media()[0].init.headers.Authorization).toBe(`Bearer ${ACCESS}`);

    available = [...available, rep("r2", "2026-09-20", "2026-09-26T00:00:00Z")];
    expect((await yt.syncReports(staticAuth, { paths: p })).downloaded).toBe(1);

    const index = JSON.parse(readFileSync(path.join(p.reports, "index.json"), "utf8"));
    expect(index.map((e: any) => [e.reportId, e.current])).toEqual([
      ["r1", false],
      ["r2", true],
    ]);
    expect(index[1]).toMatchObject({ reportTypeId: "channel_reach_basic_a1", startTime: "2026-09-20T07:00:00Z", endTime: "2026-09-21T07:00:00Z", createTime: "2026-09-26T00:00:00Z" });
    const stored = readFileSync(path.join(p.reports, index[1].file), "utf8");
    expect(stored).toContain("video_thumbnail_impressions_ctr");
    expect(stored).toContain("r2");
  });

  test("download refuses non-Reporting hosts so the token is never sent elsewhere", async () => {
    const calls = stubFetch([]);
    await expect(yt.downloadReport(staticAuth, "https://evil.example.com/v1/media/x")).rejects.toThrow(/Refusing GET/);
    expect(calls).toHaveLength(0);
  });
});

describe("read-only guard", () => {
  test("no YouTube mutation endpoints are reachable", () => {
    const refused = [
      ["POST", "https://www.googleapis.com/youtube/v3/videos"],
      ["PUT", "https://www.googleapis.com/youtube/v3/videos"],
      ["DELETE", "https://www.googleapis.com/youtube/v3/videos"],
      ["POST", "https://www.googleapis.com/upload/youtube/v3/videos"],
      ["POST", "https://www.googleapis.com/youtube/v3/thumbnails/set"],
      ["POST", "https://www.googleapis.com/youtube/v3/playlistItems"],
      ["DELETE", "https://youtubereporting.googleapis.com/v1/jobs/j1"],
      ["GET", "https://www.googleapis.com/youtube/v3/search"],
    ];
    for (const [m, u] of refused) expect(() => yt.assertAllowed(m, u), `${m} ${u}`).toThrow(/Refusing/);
    for (const [m, u] of [
      ["GET", "https://www.googleapis.com/youtube/v3/channels?mine=true"],
      ["GET", "https://youtubeanalytics.googleapis.com/v2/reports"],
      ["GET", "https://youtubereporting.googleapis.com/v1/jobs/j1/reports"],
      ["POST", "https://youtubereporting.googleapis.com/v1/jobs"],
      ["POST", "https://oauth2.googleapis.com/token"],
    ]) expect(() => yt.assertAllowed(m, u)).not.toThrow();
    const src = readFileSync(path.join(ROOT, "src/providers/youtubeOwner.ts"), "utf8");
    expect(src.match(/fetch\(/g)).toHaveLength(1); // the single guarded call in request()
    expect(src).not.toMatch(/"(PUT|DELETE|PATCH)"/);
  });

  test("owner analytics and tokens are not reachable from the server or frontend", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : [path.join(dir, d.name)]));
    for (const f of [...files(path.join(ROOT, "src/server")), ...files(path.join(ROOT, "src/app")), ...files(path.join(ROOT, "src/production"))]) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/youtubeOwner|oauth-token|oauth-client|yt-analytics/);
    }
  });
});
