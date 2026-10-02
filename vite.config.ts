import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// One dev server for both halves: the React dashboard (src/web) and the Worker
// (src/worker, running in workerd with a local D1).
export default defineConfig({
  plugins: [react(), cloudflare()],
  build: { sourcemap: false },
});
