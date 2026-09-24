import { describe, test, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-settings-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");
// An env-provided secret stands in for a pre-existing credential.
process.env.OPENAI_API_KEY = "sk-env-openai-SECRET-value";

const Fastify = (await import("fastify")).default;
const { registerRoutes } = await import("../src/server/routes.ts");
const { config } = await import("../src/server/config.ts");

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await registerRoutes(app);
  await app.ready();
});

describe("the config API never exposes secret values", () => {
  test("GET /api/settings reports only whether a key is configured", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.openai.apiKeySet).toBe(true);
    expect(body.openai).not.toHaveProperty("apiKey");
    // The raw secret and any suffix of it are absent from the payload.
    expect(res.payload).not.toContain("sk-env-openai-SECRET-value");
    expect(res.payload).not.toContain("SECRET-value");
  });
});

describe("saving provider credentials", () => {
  test("a new value updates the configuration", async () => {
    const res = await app.inject({ method: "POST", url: "/api/settings", payload: { youtubeApiKey: "yt-new-key-123" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().youtube.apiKeySet).toBe(true);
    expect(config.youtube.apiKey).toBe("yt-new-key-123");
    // The saved secret is not echoed back to the browser.
    expect(res.payload).not.toContain("yt-new-key-123");
  });

  test("a blank field leaves the existing value unchanged", async () => {
    await app.inject({ method: "POST", url: "/api/settings", payload: { elevenlabsApiKey: "eleven-original" } });
    expect(config.elevenlabs.apiKey).toBe("eleven-original");

    // A later save that blanks the ElevenLabs key must preserve it while still
    // applying the field that was actually provided.
    const res = await app.inject({ method: "POST", url: "/api/settings", payload: { elevenlabsApiKey: "", youtubeApiKey: "yt-second" } });
    expect(res.statusCode).toBe(200);
    expect(config.elevenlabs.apiKey).toBe("eleven-original");
    expect(config.youtube.apiKey).toBe("yt-second");
  });
});

describe("the Runway API secret", () => {
  test("is write-only: saved and applied, but never returned to the browser", async () => {
    const res = await app.inject({ method: "POST", url: "/api/settings", payload: { runwayApiSecret: "key_runway-SECRET-abc123" } });
    expect(res.statusCode).toBe(200);
    expect(config.runway.apiSecret).toBe("key_runway-SECRET-abc123");
    expect(res.json().runway).toEqual({ apiSecretSet: true, videoModel: "gen4.5" });
    expect(res.payload).not.toContain("runway-SECRET");

    const get = await app.inject({ method: "GET", url: "/api/settings" });
    expect(get.json().runway.apiSecretSet).toBe(true);
    expect(get.payload).not.toContain("runway-SECRET");
    expect(get.json()).not.toHaveProperty("higgsfield");
  });

  test("a blank Runway secret keeps the current value", async () => {
    await app.inject({ method: "POST", url: "/api/settings", payload: { runwayApiSecret: "key_keep-me" } });
    await app.inject({ method: "POST", url: "/api/settings", payload: { runwayApiSecret: "" } });
    expect(config.runway.apiSecret).toBe("key_keep-me");
  });

  test("the retired Higgsfield fields are rejected", async () => {
    const res = await app.inject({ method: "POST", url: "/api/settings", payload: { higgsfieldApiKey: "x" } });
    expect(res.statusCode).toBe(400);
  });
});
