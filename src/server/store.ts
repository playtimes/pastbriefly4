import { db, now } from "./db.ts";
import type { Story, StoryMoment, Source, Job, JobState, JobStep, Video, VisualPreview, NicheItem } from "../types.ts";

const J = JSON.stringify;

// The product uses plain hyphens everywhere. Model-written story text sometimes
// slips in a long dash (— – ―); normalize it as stories leave the store so none
// ever reaches the UI or the narration.
const LONG_DASH = /[‒–—―]/g;
const deDash = (s: string): string => s.replace(LONG_DASH, "-");
function P<T>(s: string | null | undefined, dflt: T): T {
  if (!s) return dflt;
  try {
    return JSON.parse(s) as T;
  } catch {
    return dflt;
  }
}

// ---- Stories ----

export interface Scripts {
  long: string;
  short: string;
}

export function upsertStory(s: Story): void {
  db.prepare(
    `INSERT INTO stories (id,slug,title,hook,category,year,place,summary,hero_image,moments,sources,production_note,created_at)
     VALUES (@id,@slug,@title,@hook,@category,@year,@place,@summary,@hero_image,@moments,@sources,@production_note,@created_at)
     ON CONFLICT(id) DO UPDATE SET
       title=@title, hook=@hook, category=@category, year=@year, place=@place, summary=@summary,
       hero_image=@hero_image, moments=@moments, sources=@sources, production_note=@production_note`
  ).run({
    id: s.id,
    slug: s.slug,
    title: s.title,
    hook: s.hook,
    category: s.category,
    year: s.year,
    place: s.place,
    summary: s.summary,
    hero_image: s.heroImage,
    moments: J(s.moments),
    sources: J(s.sources),
    production_note: s.productionNote,
    created_at: s.createdAt,
  });
}

function rowToStory(r: any): Story {
  const active = activeJobForStory(r.id); // fetched once for both fields below
  return {
    id: r.id,
    slug: r.slug,
    title: deDash(r.title),
    hook: deDash(r.hook),
    category: r.category,
    year: deDash(r.year),
    place: deDash(r.place),
    summary: deDash(r.summary),
    heroImage: r.hero_image ?? null,
    moments: P<StoryMoment[]>(r.moments, []).map((m) => ({ title: deDash(m.title), detail: deDash(m.detail) })),
    sources: P<Source[]>(r.sources, []).map((s) => ({ ...s, title: deDash(s.title), note: deDash(s.note) })),
    productionNote: deDash(r.production_note),
    createdAt: r.created_at,
    published: !!r.published,
    saved: !!r.saved,
    hasVideos: videosForStory(r.id).length > 0,
    activeJobId: active?.id ?? null,
    activeJobStep: active?.step ?? null,
  };
}

export function getStory(id: string): Story | null {
  const r = db.prepare(`SELECT * FROM stories WHERE id=?`).get(id);
  return r ? rowToStory(r) : null;
}

export function getStoryBySlug(slug: string): Story | null {
  const r = db.prepare(`SELECT * FROM stories WHERE slug=?`).get(slug);
  return r ? rowToStory(r) : null;
}

export function listStories(): Story[] {
  const rows = db.prepare(`SELECT * FROM stories ORDER BY created_at ASC`).all() as any[];
  return rows.map(rowToStory);
}

export function storyExistsByTitle(title: string): boolean {
  return !!db.prepare(`SELECT 1 FROM stories WHERE lower(title)=lower(?)`).get(title);
}

export function setStoryPublished(storyId: string, published: boolean): void {
  db.prepare(`UPDATE stories SET published=? WHERE id=?`).run(published ? 1 : 0, storyId);
}

export function setStorySaved(storyId: string, saved: boolean): void {
  db.prepare(`UPDATE stories SET saved=? WHERE id=?`).run(saved ? 1 : 0, storyId);
}

export function setScripts(storyId: string, scripts: Scripts): void {
  db.prepare(`UPDATE stories SET scripts=? WHERE id=?`).run(J(scripts), storyId);
}

export function getScripts(storyId: string): Scripts | null {
  const r = db.prepare(`SELECT scripts FROM stories WHERE id=?`).get(storyId) as any;
  return r?.scripts ? P<Scripts | null>(r.scripts, null) : null;
}

// ---- Jobs ----

export interface JobRecord extends Job {
  previewApproved: boolean;
  scratch: Record<string, any>;
}

function rowToJob(r: any): JobRecord {
  return {
    id: r.id,
    storyId: r.story_id,
    state: r.state as JobState,
    step: r.step as JobStep,
    message: r.message,
    error: r.error ?? null,
    mock: !!r.mock,
    estimatedCost: r.estimated_cost,
    approvedMax: r.approved_max,
    spent: r.spent,
    preview: P<VisualPreview | null>(r.preview, null),
    previewApproved: !!r.preview_approved,
    scratch: P<Record<string, any>>(r.scratch, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createJob(input: {
  id: string;
  storyId: string;
  mock: boolean;
  estimatedCost: number;
  approvedMax: number;
}): JobRecord {
  const ts = now();
  db.prepare(
    `INSERT INTO jobs (id,story_id,state,step,message,mock,estimated_cost,approved_max,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(input.id, input.storyId, "queued", "queued", "Queued", input.mock ? 1 : 0, input.estimatedCost, input.approvedMax, ts, ts);
  return getJob(input.id)!;
}

export function getJob(id: string): JobRecord | null {
  const r = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id);
  return r ? rowToJob(r) : null;
}

export function activeJobForStory(storyId: string): JobRecord | null {
  const r = db
    .prepare(`SELECT * FROM jobs WHERE story_id=? AND state IN ('queued','running','awaiting_text','awaiting_preview') ORDER BY created_at DESC LIMIT 1`)
    .get(storyId);
  return r ? rowToJob(r) : null;
}

// The most recent job for a story, regardless of state. Used to surface a
// failed generation on the Story page (activeJobForStory excludes failed).
export function latestJobForStory(storyId: string): JobRecord | null {
  const r = db.prepare(`SELECT * FROM jobs WHERE story_id=? ORDER BY created_at DESC LIMIT 1`).get(storyId);
  return r ? rowToJob(r) : null;
}

export function resumableJobIds(): string[] {
  const rows = db
    .prepare(`SELECT id FROM jobs WHERE state IN ('queued','running') ORDER BY created_at ASC`)
    .all() as any[];
  return rows.map((r) => r.id);
}

export function updateJob(id: string, patch: Partial<JobRecord>): void {
  const cur = getJob(id);
  if (!cur) return;
  const m = { ...cur, ...patch };
  db.prepare(
    `UPDATE jobs SET state=?, step=?, message=?, error=?, estimated_cost=?, approved_max=?, spent=?,
       preview=?, preview_approved=?, scratch=?, updated_at=? WHERE id=?`
  ).run(
    m.state,
    m.step,
    m.message,
    m.error ?? null,
    m.estimatedCost,
    m.approvedMax,
    m.spent,
    m.preview ? JSON.stringify(m.preview) : null,
    m.previewApproved ? 1 : 0,
    JSON.stringify(m.scratch),
    now(),
    id
  );
}

export function approvePreview(id: string): void {
  db.prepare(`UPDATE jobs SET preview_approved=1, updated_at=? WHERE id=?`).run(now(), id);
}

// ---- Videos ----

export function addVideo(v: Video): void {
  db.prepare(
    `INSERT INTO videos (id,story_id,job_id,kind,path,width,height,duration_sec,fps,has_audio,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET path=excluded.path, width=excluded.width, height=excluded.height,
       duration_sec=excluded.duration_sec, fps=excluded.fps, has_audio=excluded.has_audio`
  ).run(v.id, v.storyId, v.jobId, v.kind, v.path, v.width, v.height, v.durationSec, v.fps, v.hasAudio ? 1 : 0, v.createdAt);
}

function rowToVideo(r: any): Video {
  return {
    id: r.id,
    storyId: r.story_id,
    jobId: r.job_id,
    kind: r.kind,
    path: r.path,
    width: r.width,
    height: r.height,
    durationSec: r.duration_sec,
    fps: r.fps,
    hasAudio: !!r.has_audio,
    createdAt: r.created_at,
  };
}

export function videosForStory(storyId: string): Video[] {
  const rows = db.prepare(`SELECT * FROM videos WHERE story_id=? ORDER BY created_at DESC`).all(storyId) as any[];
  return rows.map(rowToVideo);
}

// ---- Niche cache ----

export interface NicheCacheRow {
  computedAt: string;
  niches: NicheItem[];
}

export function readNiche(kind: string): NicheCacheRow | null {
  const r = db.prepare(`SELECT payload, computed_at FROM niche_cache WHERE kind=?`).get(kind) as any;
  if (!r) return null;
  return { computedAt: r.computed_at, niches: P<{ niches: NicheItem[] }>(r.payload, { niches: [] }).niches };
}

export function writeNiche(kind: string, data: { niches: NicheItem[]; computedAt: string }): void {
  db.prepare(
    `INSERT INTO niche_cache (kind,payload,computed_at) VALUES (?,?,?)
     ON CONFLICT(kind) DO UPDATE SET payload=excluded.payload, computed_at=excluded.computed_at`
  ).run(kind, J({ niches: data.niches }), data.computedAt);
}

export function clearNicheCache(): void {
  db.prepare(`DELETE FROM niche_cache`).run();
}
