import type { Story, Job, Video, CostEstimate, Category, NichesResponse } from "../types.ts";

export interface StoryDetail {
  story: Story;
  videos: Video[];
  estimate: CostEstimate;
  activeJob: Job | null;
  failedJob: Job | null;
}

// Config view: current mode and, per provider, whether its key(s) are configured
// plus non-secret settings. Secret values are never returned to the browser.
export interface SettingsStatus {
  mode: "mock" | "live";
  openai: { apiKeySet: boolean; model: string; imageModel: string };
  elevenlabs: { apiKeySet: boolean; voiceId: string; model: string };
  runway: { apiSecretSet: boolean; videoModel: string };
  youtube: { apiKeySet: boolean };
}

// Credentials submitted from the Config page. A blank field leaves the stored
// value unchanged; a non-empty field replaces it.
export interface SettingsInput {
  openaiApiKey?: string;
  elevenlabsApiKey?: string;
  elevenlabsVoiceId?: string;
  runwayApiSecret?: string;
  youtubeApiKey?: string;
}

export interface DiscoverInput {
  prompt?: string;
  category?: string;
  niche?: boolean; // a niche-card click discovers new stories for that niche only
}

// Prefer Fastify's useful `message` (e.g. "body must be object") over the terse
// `error` label ("Bad Request") when both are present.
async function requestError(res: Response): Promise<Error> {
  const b = await res.json().catch(() => ({} as any));
  return new Error(b.message || b.error || `Request failed (${res.status})`);
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw await requestError(res);
  return res.json();
}

// Only send a JSON body (and its Content-Type) when there is one. An empty POST
// with a JSON Content-Type header is rejected by Fastify as a bad request, which
// is what broke the no-body calls (retry, continue).
async function post<T>(url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) throw await requestError(res);
  return res.json();
}

export const api = {
  config: () => get<{ mode: string; maxSpendUsd: number; categories: Category[] }>("/api/config"),
  settings: () => get<SettingsStatus>("/api/settings"),
  setMode: (mode: "mock" | "live") => post<SettingsStatus>("/api/settings/mode", { mode }),
  saveSettings: (input: SettingsInput) => post<SettingsStatus>("/api/settings", input),
  stories: () => get<{ stories: Story[] }>("/api/stories"),
  story: (slug: string) => get<StoryDetail>(`/api/stories/${slug}`),
  research: (query: string) => post<{ added: string[]; note: string }>("/api/research", { query }),
  recheck: (id: string) => post<{ verdict: "supported" | "rewrite" | "reject"; reason: string; story: Story }>(`/api/stories/${id}/recheck`),
  discover: (input: DiscoverInput) => post<{ stories: Story[]; note: string }>("/api/discover", input),
  setPublished: (id: string, published: boolean) => post<{ story: Story }>(`/api/stories/${id}/publish`, { published }),
  setSaved: (id: string, saved: boolean) => post<{ story: Story }>(`/api/stories/${id}/saved`, { saved }),
  niches: () => get<NichesResponse>("/api/niches"),
  generate: (id: string, approvedMax: number) => post<{ job: Job; duplicate: boolean }>(`/api/stories/${id}/generate`, { approvedMax }),
  approveText: (jobId: string) => post<{ job: Job }>(`/api/jobs/${jobId}/approve-text`),
  continue: (jobId: string) => post<{ job: Job }>(`/api/jobs/${jobId}/continue`),
  rebuildVisuals: (jobId: string) => post<{ job: Job }>(`/api/jobs/${jobId}/rebuild-visuals`),
  retry: (jobId: string) => post<{ job: Job }>(`/api/jobs/${jobId}/retry`),
  approveSpend: (jobId: string, approvedMax: number) => post<{ job: Job }>(`/api/jobs/${jobId}/approve-spend`, { approvedMax }),
  job: (jobId: string) => get<{ job: Job }>(`/api/jobs/${jobId}`),
};

export function mediaUrl(rel: string | null): string {
  return rel ? `/media/${rel}` : "";
}
