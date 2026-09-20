import "dotenv/config";
import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", "..");

export const DATA_DIR = process.env.PB4_DATA_DIR || path.join(ROOT, "data");
export const MEDIA_DIR = process.env.PB4_MEDIA_DIR || path.join(ROOT, "media");
export const DB_PATH = path.join(DATA_DIR, "pastbriefly4.sqlite");

// The mock/live toggle can be flipped at runtime from the config page.
// PROVIDER_MODE is the default when no toggle has been saved.
export const MODE_PATH = path.join(DATA_DIR, "mode.json");

// Provider credentials saved from the Config page live in this local file. It is
// read only by the server and takes precedence over the .env defaults; secret
// values are never sent back to the browser.
export const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

export type ProviderMode = "mock" | "live";

// Keys and settings come from the environment (.env). Copy .env.example to .env
// and fill it in for a live run.
function pick(env: string | undefined, dflt = ""): string {
  return env ?? dflt;
}

function num(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// A saved mock/live toggle, if any, wins over the PROVIDER_MODE default.
function loadMode(): ProviderMode | undefined {
  try {
    if (existsSync(MODE_PATH)) {
      const m = (JSON.parse(readFileSync(MODE_PATH, "utf8")) as { mode?: string }).mode;
      if (m === "mock" || m === "live") return m;
    }
  } catch {
    /* malformed mode file — fall back to env */
  }
  return undefined;
}

// Provider credentials saved from the Config page. Only fields the user has set
// are stored; everything else falls back to .env. Blank values are never stored.
interface SavedSettings {
  openaiApiKey?: string;
  elevenlabsApiKey?: string;
  elevenlabsVoiceId?: string;
  higgsfieldApiKey?: string;
  higgsfieldApiSecret?: string;
  youtubeApiKey?: string;
}

function loadSaved(): SavedSettings {
  try {
    if (existsSync(SETTINGS_PATH)) return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as SavedSettings;
  } catch {
    /* malformed settings file — fall back to env */
  }
  return {};
}

const saved = loadSaved();

// Resolve ffmpeg/ffprobe: explicit env, then PATH, then the Windows winget path.
function resolveFf(kind: "ffmpeg" | "ffprobe"): string {
  const env = kind === "ffmpeg" ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH;
  if (env && existsSync(env)) return env;
  const exe = process.platform === "win32" ? `${kind}.exe` : kind;
  try {
    execFileSync(exe, ["-version"], { stdio: "ignore" });
    return exe;
  } catch {
    /* not on PATH */
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const base = path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
    if (existsSync(base)) {
      const hits = globSync(path.join(base, `Gyan.FFmpeg*/**/bin/${exe}`).replace(/\\/g, "/"));
      if (hits.length) return hits[0];
    }
  }
  return exe;
}

export const config = {
  mode: (loadMode() ?? (process.env.PROVIDER_MODE === "live" ? "live" : "mock")) as ProviderMode,
  port: num(process.env.PORT, 8787),
  maxSpendUsd: num(process.env.MAX_SPEND_USD, 15),

  openai: {
    apiKey: pick(saved.openaiApiKey || process.env.OPENAI_API_KEY),
    model: pick(process.env.OPENAI_MODEL, "gpt-4.1"),
    imageModel: pick(process.env.OPENAI_IMAGE_MODEL, "gpt-image-1"),
  },
  elevenlabs: {
    apiKey: pick(saved.elevenlabsApiKey || process.env.ELEVENLABS_API_KEY),
    voiceId: pick(saved.elevenlabsVoiceId || process.env.ELEVENLABS_VOICE_ID),
    model: pick(process.env.ELEVENLABS_MODEL, "eleven_multilingual_v2"),
  },
  higgsfield: {
    apiKey: pick(saved.higgsfieldApiKey || process.env.HIGGSFIELD_API_KEY),
    apiSecret: pick(saved.higgsfieldApiSecret || process.env.HIGGSFIELD_API_SECRET),
    videoModel: pick(process.env.HIGGSFIELD_VIDEO_MODEL, "kling-video/v2.5-turbo/pro/image-to-video"),
    publicAssetBase: pick(process.env.HIGGSFIELD_PUBLIC_ASSET_BASE),
  },
  youtube: {
    apiKey: pick(saved.youtubeApiKey || process.env.YOUTUBE_API_KEY),
  },

  ffmpeg: resolveFf("ffmpeg"),
  ffprobe: resolveFf("ffprobe"),
};

export function isMock(): boolean {
  return config.mode === "mock";
}

// Flip the mock/live toggle at runtime and persist it so it survives a restart.
export function setMode(mode: ProviderMode): void {
  config.mode = mode;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(MODE_PATH, JSON.stringify({ mode }, null, 2), "utf8");
  } catch {
    /* couldn't persist — the runtime change still applies for this session */
  }
}

// A view for the config page: the current mode and, for each provider, whether
// its key(s) are configured plus the non-secret settings. Secret values (and any
// suffix of them) are never sent to the client. The Voice ID is an identifier,
// not a secret, so its value is returned to prefill the field.
export interface SettingsStatus {
  mode: ProviderMode;
  openai: { apiKeySet: boolean; model: string; imageModel: string };
  elevenlabs: { apiKeySet: boolean; voiceId: string; model: string };
  higgsfield: { apiKeySet: boolean; apiSecretSet: boolean; videoModel: string; publicAssetBase: string };
  youtube: { apiKeySet: boolean };
}

export function settingsStatus(): SettingsStatus {
  return {
    mode: config.mode,
    openai: { apiKeySet: !!config.openai.apiKey, model: config.openai.model, imageModel: config.openai.imageModel },
    elevenlabs: { apiKeySet: !!config.elevenlabs.apiKey, voiceId: config.elevenlabs.voiceId, model: config.elevenlabs.model },
    higgsfield: {
      apiKeySet: !!config.higgsfield.apiKey,
      apiSecretSet: !!config.higgsfield.apiSecret,
      videoModel: config.higgsfield.videoModel,
      publicAssetBase: config.higgsfield.publicAssetBase,
    },
    youtube: { apiKeySet: !!config.youtube.apiKey },
  };
}

// Credentials submitted from the Config page. A blank/absent field leaves the
// current value unchanged; a non-empty field replaces it.
export interface SettingsInput {
  openaiApiKey?: string;
  elevenlabsApiKey?: string;
  elevenlabsVoiceId?: string;
  higgsfieldApiKey?: string;
  higgsfieldApiSecret?: string;
  youtubeApiKey?: string;
}

// Save provider credentials locally and apply them to the running config so the
// providers pick them up without a restart. Only non-empty fields are written.
export function saveSettings(input: SettingsInput): void {
  const next = loadSaved();
  const set = (key: keyof SavedSettings, value: string | undefined) => {
    const v = (value ?? "").trim();
    if (v) next[key] = v;
  };
  set("openaiApiKey", input.openaiApiKey);
  set("elevenlabsApiKey", input.elevenlabsApiKey);
  set("elevenlabsVoiceId", input.elevenlabsVoiceId);
  set("higgsfieldApiKey", input.higgsfieldApiKey);
  set("higgsfieldApiSecret", input.higgsfieldApiSecret);
  set("youtubeApiKey", input.youtubeApiKey);

  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf8");
  } catch {
    /* couldn't persist — the runtime change still applies for this session */
  }

  if (next.openaiApiKey) config.openai.apiKey = next.openaiApiKey;
  if (next.elevenlabsApiKey) config.elevenlabs.apiKey = next.elevenlabsApiKey;
  if (next.elevenlabsVoiceId) config.elevenlabs.voiceId = next.elevenlabsVoiceId;
  if (next.higgsfieldApiKey) config.higgsfield.apiKey = next.higgsfieldApiKey;
  if (next.higgsfieldApiSecret) config.higgsfield.apiSecret = next.higgsfieldApiSecret;
  if (next.youtubeApiKey) config.youtube.apiKey = next.youtubeApiKey;
}
