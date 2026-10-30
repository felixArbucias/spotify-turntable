// Run with: npm test  (mocks fetch; never talks to Spotify)
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getNowPlaying, pickRotation, parsePlaylistId, parseDemo, resetSpotifyCache, ROTATION_EPOCH, isTruthy } from "../src/server/spotify.js";

const ENV = { SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret", SPOTIFY_REFRESH_TOKEN: "refresh" };
const PLAYLIST = "37i9dQZF1DXcBWIGoYBM5M";
const ENV_ROT = { ...ENV, SPOTIFY_FALLBACK_PLAYLIST: `https://open.spotify.com/playlist/${PLAYLIST}?si=abc` };

const track = (id, ms, extra = {}) => ({
  type: "track",
  id,
  name: `Song ${id}`,
  duration_ms: ms,
  artists: [{ name: "Artist" }],
  album: { name: "Album", images: [{ url: `https://img/${id}`, width: 640 }] },
  external_urls: { spotify: `https://open.spotify.com/track/${id}` },
  ...extra,
});

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let calls;
let routes;
const realFetch = globalThis.fetch;

function mock(map) {
  routes = map;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const key = Object.keys(routes).find((k) => u.includes(k));
    calls.push(key || u);
    if (!key) throw new Error(`unexpected fetch ${u}`);
    const r = routes[key];
    return typeof r === "function" ? r(u) : r.clone();
  };
}

const token = () => json({ access_token: "tok", expires_in: 3600 });
const playlistMeta = () => json({ id: PLAYLIST, name: "House Rotation", external_urls: { spotify: `https://open.spotify.com/playlist/${PLAYLIST}` } });
const playlistItems = () =>
  json({ items: [{ item: track("a", 100_000) }, { item: track("b", 200_000) }, { is_local: true, item: track("local", 5000) }], next: null });
const recent = () => json({ items: [{ track: track("r", 180_000), played_at: "2026-10-29T10:00:00Z" }] });
const count = (k) => calls.filter((c) => c === k).length;

beforeEach(() => {
  resetSpotifyCache();
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("unconfigured", async () => {
  mock({});
  const r = await getNowPlaying({});
  assert.equal(r.configured, false);
  assert.equal(r.mode, "unconfigured");
  assert.equal(calls.length, 0);
});

test("live track wins over rotation", async () => {
  mock({
    "/api/token": token,
    "currently-playing": () => json({ is_playing: true, progress_ms: 5000, currently_playing_type: "track", item: track("live", 200_000) }),
  });
  const r = await getNowPlaying(ENV_ROT);
  assert.equal(r.mode, "live");
  assert.equal(r.isPlaying, true);
  assert.equal(r.track.id, "live");
  assert.equal(r.track.albumArt, "https://img/live");
  assert.ok(r.track.progressMs >= 5000);
  assert.equal(count("/playlists/"), 0);
});

test("podcast episode plays live", async () => {
  mock({
    "/api/token": token,
    "currently-playing": () =>
      json({ is_playing: true, progress_ms: 1, currently_playing_type: "episode", item: { type: "episode", id: "ep", name: "Ep 1", duration_ms: 60_000, images: [], show: { name: "Show", images: [{ url: "x", width: 1 }] } } }),
  });
  const r = await getNowPlaying(ENV);
  assert.equal(r.mode, "live");
  assert.equal(r.track.type, "episode");
  assert.equal(r.track.artist, "Show");
});

test("204 (nothing / private session) → rotation", async () => {
  mock({
    "/api/token": token,
    "currently-playing": () => new Response(null, { status: 204 }),
    [`/playlists/${PLAYLIST}/items`]: playlistItems,
    [`/playlists/${PLAYLIST}?`]: playlistMeta,
  });
  const r = await getNowPlaying(ENV_ROT);
  assert.equal(r.mode, "rotation");
  assert.equal(r.isPlaying, false);
  assert.deepEqual(r.playlist, { id: PLAYLIST, name: "House Rotation", url: `https://open.spotify.com/playlist/${PLAYLIST}` });
  assert.ok(["a", "b"].includes(r.track.id));
  // Second request: player + playlist both served from cache.
  const before = calls.length;
  await getNowPlaying(ENV_ROT);
  assert.equal(calls.length, before);
});

test("liked songs rotation reads /me/tracks", async () => {
  mock({
    "/api/token": token,
    "currently-playing": () => new Response(null, { status: 204 }),
    "/me/tracks": () => json({ items: [{ track: track("l1", 100_000) }, { track: track("l2", 150_000) }], next: null }),
  });
  const r = await getNowPlaying({ ...ENV, SPOTIFY_FALLBACK_PLAYLIST: "liked" });
  assert.equal(r.mode, "rotation");
  assert.deepEqual(r.playlist, { id: null, name: "Liked Songs", url: null });
  assert.ok(["l1", "l2"].includes(r.track.id));
  assert.equal(count("/playlists/"), 0);
});

test("liked songs without user-library-read → recent with a hint", async () => {
  mock({
    "/api/token": token,
    "currently-playing": () => new Response(null, { status: 204 }),
    "/me/tracks": () => json({}, 403),
    "recently-played": recent,
  });
  const r = await getNowPlaying({ ...ENV, SPOTIFY_FALLBACK_PLAYLIST: "Liked Songs" });
  assert.equal(r.mode, "recent");
  assert.match(r.error, /user-library-read/);
});

test("paused / ad → rotation; paused without playlist → paused", async () => {
  mock({
    "/api/token": token,
    "currently-playing": () => json({ is_playing: false, progress_ms: 9, currently_playing_type: "track", item: track("p", 100_000) }),
    [`/playlists/${PLAYLIST}/items`]: playlistItems,
    [`/playlists/${PLAYLIST}?`]: playlistMeta,
  });
  assert.equal((await getNowPlaying(ENV_ROT)).mode, "rotation");
  resetSpotifyCache();
  const r = await getNowPlaying(ENV);
  assert.equal(r.mode, "paused");
  assert.equal(r.track.id, "p");

  resetSpotifyCache();
  mock({ ...routes, "currently-playing": () => json({ is_playing: true, currently_playing_type: "ad", item: null }) });
  assert.equal((await getNowPlaying(ENV_ROT)).mode, "rotation");
});

test("legacy /tracks fallback when /items 404s", async () => {
  mock({
    "/api/token": token,
    "currently-playing": () => new Response(null, { status: 204 }),
    [`/playlists/${PLAYLIST}/items`]: () => json({ error: { status: 404 } }, 404),
    [`/playlists/${PLAYLIST}/tracks`]: () => json({ items: [{ track: track("old", 120_000) }], next: null }),
    [`/playlists/${PLAYLIST}?`]: playlistMeta,
  });
  const r = await getNowPlaying(ENV_ROT);
  assert.equal(r.mode, "rotation");
  assert.equal(r.track.id, "old");
});

test("no playlist configured → recent", async () => {
  mock({ "/api/token": token, "currently-playing": () => new Response(null, { status: 204 }), "recently-played": recent });
  const r = await getNowPlaying(ENV);
  assert.equal(r.mode, "recent");
  assert.equal(r.track.id, "r");
  assert.equal(r.playedAt, "2026-10-29T10:00:00.000Z");
  assert.equal(r.playlist, null);
});

test("no playlist, nothing recent → idle", async () => {
  mock({ "/api/token": token, "currently-playing": () => new Response(null, { status: 204 }), "recently-played": () => json({ items: [] }) });
  const r = await getNowPlaying(ENV);
  assert.equal(r.mode, "idle");
  assert.equal(r.track, null);
});

test("playlist forbidden → falls back to recent with error", async () => {
  mock({
    "/api/token": token,
    "currently-playing": () => new Response(null, { status: 204 }),
    [`/playlists/${PLAYLIST}?`]: playlistMeta,
    [`/playlists/${PLAYLIST}/items`]: () => json({}, 403),
    "recently-played": recent,
  });
  const r = await getNowPlaying(ENV_ROT);
  assert.equal(r.mode, "recent");
  assert.match(r.error, /403/);
});

test("401 → token refreshed and request retried", async () => {
  let n = 0;
  let tokens = 0;
  mock({
    "/api/token": () => json({ access_token: `tok${++tokens}`, expires_in: 3600 }),
    "currently-playing": () => (++n === 1 ? json({ error: { status: 401 } }, 401) : json({ is_playing: true, progress_ms: 0, item: track("x", 100_000) })),
  });
  const r = await getNowPlaying(ENV);
  assert.equal(r.mode, "live");
  assert.equal(tokens, 2);
  assert.equal(n, 2);
});

test("revoked refresh token → helpful error", async () => {
  mock({ "/api/token": () => json({ error: "invalid_grant" }, 400) });
  const r = await getNowPlaying(ENV);
  assert.equal(r.mode, "error");
  assert.match(r.error, /spotify-turntable auth/);
});

test("429 → serves cached data and backs off", async () => {
  let n = 0;
  mock({
    "/api/token": token,
    "currently-playing": () => (++n === 1 ? json({ is_playing: true, progress_ms: 0, item: track("c", 600_000) }) : new Response(null, { status: 429, headers: { "retry-after": "60" } })),
  });
  const first = await getNowPlaying(ENV);
  assert.equal(first.mode, "live");

  // Expire the 12s player cache.
  const realNow = Date.now;
  Date.now = () => realNow() + 13_000;
  try {
    const second = await getNowPlaying(ENV);
    assert.equal(second.mode, "live");
    assert.equal(second.track.id, "c");
    assert.equal(second.stale, true);
    assert.equal(n, 2);
    Date.now = () => realNow() + 26_000;
    const third = await getNowPlaying(ENV);
    assert.equal(third.track.id, "c");
    assert.equal(n, 2, "no new Spotify call during Retry-After back-off");
  } finally {
    Date.now = realNow;
  }
});

test("429 with no cache but cached playlist → rotation still served", async () => {
  mock({
    "/api/token": token,
    "currently-playing": () => new Response(null, { status: 204 }),
    [`/playlists/${PLAYLIST}/items`]: playlistItems,
    [`/playlists/${PLAYLIST}?`]: playlistMeta,
  });
  await getNowPlaying(ENV_ROT);
  routes["currently-playing"] = () => new Response(null, { status: 429, headers: { "retry-after": "5" } });
  const realNow = Date.now;
  Date.now = () => realNow() + 13_000;
  try {
    const r = await getNowPlaying(ENV_ROT);
    assert.equal(r.mode, "rotation");
  } finally {
    Date.now = realNow;
  }
});

test("concurrent requests share one Spotify call", async () => {
  mock({ "/api/token": token, "currently-playing": () => json({ is_playing: true, progress_ms: 0, item: track("x", 100_000) }) });
  await Promise.all(Array.from({ length: 10 }, () => getNowPlaying(ENV)));
  assert.equal(count("currently-playing"), 1);
  assert.equal(count("/api/token"), 1);
});

test("pickRotation is deterministic and wraps like a radio", () => {
  const list = [
    { id: "a", durationMs: 100 },
    { id: "b", durationMs: 200 },
  ];
  assert.deepEqual(pickRotation(list, ROTATION_EPOCH + 50), { id: "a", durationMs: 100, progressMs: 50 });
  assert.deepEqual(pickRotation(list, ROTATION_EPOCH + 150), { id: "b", durationMs: 200, progressMs: 50 });
  assert.deepEqual(pickRotation(list, ROTATION_EPOCH + 300 * 7 + 120), { id: "b", durationMs: 200, progressMs: 20 });
  assert.equal(pickRotation([], Date.now()), null);
});

test("shuffled rotation plays every track once per pass, in a shared order that changes each pass", () => {
  const list = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, durationMs: 100 }));
  const pass = (n) => list.map((_, i) => pickRotation(list, ROTATION_EPOCH + n * 1200 + i * 100 + 5, ROTATION_EPOCH, { shuffle: true }).id);
  const first = pass(0);
  assert.deepEqual([...first].sort(), list.map((t) => t.id).sort());
  assert.notDeepEqual(first, list.map((t) => t.id));
  assert.deepEqual(pass(0), first);
  assert.notDeepEqual(pass(1), first);
  assert.equal(isTruthy("true"), true);
  assert.equal(isTruthy("1"), true);
  assert.equal(isTruthy(""), false);
  assert.equal(isTruthy(undefined), false);
});

test("parsers", () => {
  assert.equal(parsePlaylistId(PLAYLIST), PLAYLIST);
  assert.equal(parsePlaylistId(`spotify:playlist:${PLAYLIST}`), PLAYLIST);
  assert.equal(parsePlaylistId(`https://open.spotify.com/intl-es/playlist/${PLAYLIST}?si=x`), PLAYLIST);
  assert.equal(parsePlaylistId("nope"), null);
  assert.equal(parsePlaylistId("liked"), "liked");
  assert.equal(parsePlaylistId("https://open.spotify.com/collection/tracks"), "liked");
  assert.equal(parseDemo(undefined), null);
  assert.equal(parseDemo("0"), null);
  assert.equal(parseDemo("1"), "live");
  assert.equal(parseDemo("rotation"), "rotation");
});

test("demo modes need no credentials", async () => {
  mock({});
  assert.equal((await getNowPlaying({}, { demo: "1" })).mode, "live");
  const rot = await getNowPlaying({}, { demo: "rotation" });
  assert.equal(rot.mode, "rotation");
  assert.equal(rot.demo, true);
  assert.ok(rot.playlist.id);
  assert.equal(calls.length, 0);
});
