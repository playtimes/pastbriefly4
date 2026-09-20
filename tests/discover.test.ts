import { describe, test, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-discover-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const Fastify = (await import("fastify")).default;
const { registerRoutes } = await import("../src/server/routes.ts");
const { ensureSeed } = await import("../src/production/seed.ts");
const { composeDiscoveryQuery } = await import("../src/production/discover.ts");

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await registerRoutes(app);
  ensureSeed();
  await app.ready();
});

async function discover(payload: unknown) {
  return app.inject({ method: "POST", url: "/api/discover", payload });
}

describe("prompt / category discovery", () => {
  test("neither prompt nor category is rejected (Search stays disabled)", async () => {
    expect((await discover({})).statusCode).toBe(400);
    expect((await discover({ prompt: "   ", category: "" })).statusCode).toBe(400);
  });

  test("category-only discovery returns real stories of that category", async () => {
    const res = await discover({ category: "Disasters" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stories.length).toBeGreaterThan(0);
    expect(body.stories.every((s: any) => s.category === "Disasters")).toBe(true);
  });

  test("prompt-only discovery returns matching real stories", async () => {
    const res = await discover({ prompt: "war" });
    expect(res.statusCode).toBe(200);
    expect(res.json().stories.length).toBeGreaterThan(0);
  });

  test("an unknown category alone is treated as no filter and rejected", async () => {
    expect((await discover({ category: "Not A Category" })).statusCode).toBe(400);
  });

  test("composeDiscoveryQuery merges prompt and category", () => {
    expect(composeDiscoveryQuery({ prompt: "cold war", category: "Conflicts & Standoffs" })).toBe("cold war Conflicts & Standoffs");
    expect(composeDiscoveryQuery({ prompt: "escapes" })).toBe("escapes");
    expect(composeDiscoveryQuery({ category: "Disasters" })).toBe("Disasters");
  });
});

describe("niche click triggers discovery", () => {
  test("running discovery with a niche name as the prompt returns results", async () => {
    // A niche card click calls the same discovery flow with the niche as prompt.
    const res = await discover({ prompt: "Money & Deception" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().stories)).toBe(true);
  });
});
