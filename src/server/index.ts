import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { config, MEDIA_DIR, ROOT } from "./config.ts";
import { registerRoutes } from "./routes.ts";
import { ensureSeed } from "../production/seed.ts";
import { resumeInterrupted } from "./worker.ts";

async function main(): Promise<void> {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  await registerRoutes(app);

  // Serve generated media (with range support for video playback).
  await app.register(fastifyStatic, { root: MEDIA_DIR, prefix: "/media/" });

  // Serve the built client in production (dev uses the Vite server).
  const clientDist = path.join(ROOT, "dist", "app");
  if (existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist, prefix: "/", decorateReply: false });
  }

  ensureSeed();

  await app.listen({ port: config.port, host: "127.0.0.1" });
  console.log(`PastBriefly 4 server on http://localhost:${config.port}  (mode: ${config.mode})`);

  resumeInterrupted();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
