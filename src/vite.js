import { loadEnv } from "vite";
import { nowPlayingHandler } from "./server/index.js";

/**
 * Serves the now-playing endpoint from `vite` and `vite preview`, reading SPOTIFY_* from .env / .env.local.
 *   plugins: [react(), spotifyTurntable()]
 */
export function spotifyTurntable({ path = "/api/now-playing" } = {}) {
  let handler = nowPlayingHandler();

  function setup(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url || "/", "http://x");
      if (url.pathname !== path) return next();
      handler(req, res).catch(next);
    });
  }

  return {
    name: "spotify-turntable",
    configResolved(config) {
      const env = { ...process.env, ...loadEnv(config.mode, config.envDir || process.cwd(), "") };
      handler = nowPlayingHandler({ env, cacheControl: () => "no-store" });
    },
    configureServer: setup,
    configurePreviewServer: setup,
  };
}

export default spotifyTurntable;
