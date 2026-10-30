import { getNowPlaying, parseDemo } from "./spotify.js";

export { getNowPlaying, parseDemo, parsePlaylistId, pickRotation, mapItem, resetSpotifyCache, LIKED, ROTATION_EPOCH } from "./spotify.js";

const getEnv = () => (typeof process !== "undefined" ? process.env : {});

/** Cache-Control that lets a CDN absorb traffic without making the turntable feel stale. */
export function cacheControlFor(data, demo) {
  if (demo) return "no-store";
  if (data.mode === "error") return "public, max-age=0, s-maxage=5";
  return "public, max-age=0, s-maxage=10, stale-while-revalidate=20";
}

async function load(env, demoValue) {
  const demo = parseDemo(demoValue);
  let data;
  try {
    data = await getNowPlaying(env, { demo });
  } catch (err) {
    data = { configured: true, mode: "error", isPlaying: false, track: null, playedAt: null, playlist: null, fetchedAt: Date.now(), error: err?.message };
  }
  return { data, demo };
}

/**
 * Node-style handler: `(req, res) => void`.
 * Works as a Vercel function, an Express / Connect route, or plain `http.createServer`.
 *   export default nowPlayingHandler();            // api/now-playing.js on Vercel
 *   app.get("/api/now-playing", nowPlayingHandler()); // Express
 */
export function nowPlayingHandler({ env, cacheControl = cacheControlFor } = {}) {
  return async function handler(req, res) {
    if (req.method && req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end();
      return;
    }
    let value = req.query?.demo;
    if (value === undefined && req.url) value = new URL(req.url, "http://x").searchParams.get("demo") ?? undefined;
    const { data, demo } = await load(env || getEnv(), value);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", cacheControl(data, demo));
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(data));
  };
}

/**
 * Web-standard handler: `(Request) => Response`.
 * For Next.js route handlers, Netlify / Cloudflare / Deno / Bun.
 *   export const GET = nowPlayingFetchHandler();   // app/api/now-playing/route.js
 */
export function nowPlayingFetchHandler({ env, cacheControl = cacheControlFor } = {}) {
  return async function handler(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const value = new URL(request.url).searchParams.get("demo") ?? undefined;
    const { data, demo } = await load(env || getEnv(), value);
    return new Response(request.method === "HEAD" ? null : JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cacheControl(data, demo) },
    });
  };
}
