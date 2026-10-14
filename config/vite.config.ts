import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src/web", import.meta.url));
const outDir = fileURLToPath(new URL("../dist/web", import.meta.url));
const apiPort = process.env.CADENCE_PORT ?? "4317";

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: { outDir, emptyOutDir: true },
  server: {
    port: 5317,
    proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, ws: true } },
  },
});
