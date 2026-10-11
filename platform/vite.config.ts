import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare()],
  build: { chunkSizeWarningLimit: 1500 },   // Plotly 本身约 1MB
});
