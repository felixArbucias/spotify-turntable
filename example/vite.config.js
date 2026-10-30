import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { spotifyTurntable } from "../src/vite.js";

// Reads SPOTIFY_* from the package root's .env.local (where `npm run auth` writes them).
export default defineConfig({
  envDir: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [react(), spotifyTurntable()],
});
