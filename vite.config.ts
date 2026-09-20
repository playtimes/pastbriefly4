import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

// The app UI. The Fastify server owns /api and /media; Vite proxies to it in dev.
export default defineConfig({
  root: "src/app",
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    // Anchored so only real API/media paths proxy to Fastify. A bare prefix
    // ("/api") would also swallow the app's own /api.ts source module (root is
    // src/app), forwarding it to the backend and 404ing the app.
    proxy: {
      "^/api/": "http://localhost:8787",
      "^/media/": "http://localhost:8787",
    },
  },
  build: {
    outDir: "../../dist/app",
    emptyOutDir: true,
  },
});
