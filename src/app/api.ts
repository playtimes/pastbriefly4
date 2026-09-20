import type { Story, Job, Video, CostEstimate, Category, NichesResponse } from "../types.ts";

export interface StoryDetail {
  story: Story;
  videos: Video[];
  estimate: CostEstimate;
  activeJob: Job | null;
}

// Config view: current mode and, per provider, whether its key(s) are configured
// plus non-secret settings. Secret values are never returned to the browser.
export interface SettingsStatus {
  mode: "mock" | "live";
  openai: { apiKeySet: boolean; model: string; imageModel: string };
  elevenlabs: { apiKeySet: boolean; voiceId: string; model: string };
  higgsfield: { apiKeySet: boolean; apiSecretSet: boolean; videoModel: string; publicAssetBase: string };
  youtube: { apiKeySet: boolean };
}

// Credentials submitted from the Config page. A blank field leaves the stored
// value unchanged; a non-empty field replaces it.
export interface SettingsInput {
  openaiApiKey?: string;
  elevenlabsApiKey?: string;
  elevenlabsVoiceId?: string;
  higgsfieldApiKey?: string;
  higgsfieldApiSecret?: string;
  youtubeApiKey?: string;
}

export interface DiscoverInput {
  prompt?: string;
  category?: string;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
  return res.json();
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
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
  discover: (input: DiscoverInput) => post<{ stories: Story[]; note: string }>("/api/discover", input),
  setPublished: (id: string, published: boolean) => post<{ story: Story }>(`/api/stories/${id}/publish`, { published }),
  niches: () => get<NichesResponse>("/api/niches"),
  generate: (id: string, approvedMax: number) => post<{ job: Job; duplicate: boolean }>(`/api/stories/${id}/generate`, { approvedMax }),
  continue: (jobId: string) => post<{ job: Job }>(`/api/jobs/${jobId}/continue`),
  job: (jobId: string) => get<{ job: Job }>(`/api/jobs/${jobId}`),
};

export function mediaUrl(rel: string | null): string {
  return rel ? `/media/${rel}` : "";
}
