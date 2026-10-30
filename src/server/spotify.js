/*
 * spotify-turntable: server side. Talks to the Spotify Web API and returns one small JSON shape.
 *
 * Modes returned to the client:
 *   live        – the account is playing something right now (track or podcast episode)
 *   rotation    – nothing live, so we "broadcast" from SPOTIFY_FALLBACK_PLAYLIST like a radio station
 *   paused      – something is loaded but paused, and no rotation playlist is available
 *   recent      – last played track (no rotation playlist available)
 *   idle        – nothing at all
 *   unconfigured / error
 *
 * Everything is cached in module memory so many visitors share a handful of Spotify calls:
 * player state ~12s, recently-played ~60s, playlist contents ~6h. A 429 puts us into
 * back-off (Retry-After) and we keep serving the last good data meanwhile.
 */

const API = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const NOW_PLAYING_URL = `${API}/me/player/currently-playing?additional_types=track,episode`;
const RECENT_URL = `${API}/me/player/recently-played?limit=1`;

const TIMEOUT_MS = 5000;
const NOW_TTL_MS = 12_000;
const RECENT_TTL_MS = 60_000;
const PLAYLIST_TTL_MS = 6 * 60 * 60 * 1000;
const PLAYLIST_RETRY_MS = 5 * 60 * 1000;
const MAX_PLAYLIST_ITEMS = 500;
const DEFAULT_RETRY_AFTER_S = 30;
// Fixed start of the "broadcast". Rotation position = (now - epoch) mod playlist length.
export const ROTATION_EPOCH = Date.UTC(2024, 0, 1);

class SpotifyError extends Error {
  constructor(message, status = 0, retryAfterMs = 0) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

let tokenCache;
let nowCache;
let recentCache;
let playlistCache;
let backoffUntil;

export function resetSpotifyCache() {
  tokenCache = { key: null, token: null, expiresAt: 0, promise: null };
  nowCache = { key: null, value: null, at: 0, promise: null };
  recentCache = { key: null, value: null, at: 0, promise: null };
  playlistCache = { key: null, value: null, at: 0, failedAt: 0, error: null, promise: null };
  backoffUntil = 0;
}
resetSpotifyCache();

/* ── helpers ─────────────────────────────────────────── */

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") throw new SpotifyError("Spotify request timed out");
    throw new SpotifyError("Spotify request failed");
  } finally {
    clearTimeout(timer);
  }
}

function retryAfterMs(res) {
  const s = Number(res.headers?.get?.("retry-after"));
  return (Number.isFinite(s) && s > 0 ? s : DEFAULT_RETRY_AFTER_S) * 1000;
}

function inBackoff() {
  return Date.now() < backoffUntil;
}

export const LIKED = "liked";

// Accepts a bare ID, a spotify:playlist:ID URI, an open.spotify.com/playlist/ID?si=… URL,
// or "liked" (also "liked songs" / open.spotify.com/collection/tracks) for the account's Liked Songs.
export function parsePlaylistId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^liked(\s*songs)?$/i.test(s) || /collection(\/|:)tracks/i.test(s)) return LIKED;
  const m = s.match(/playlist[/:]([A-Za-z0-9]{16,})/) || s.match(/^([A-Za-z0-9]{16,})$/);
  return m ? m[1] : null;
}

/** Normalises ?demo= values: null (off), "live" or "rotation". */
export function parseDemo(value) {
  if (Array.isArray(value)) value = value[0];
  if (value === undefined || value === null || value === "0" || value === "false") return null;
  return String(value).toLowerCase() === "rotation" ? "rotation" : "live";
}

function credsFrom(env) {
  const clientId = env?.SPOTIFY_CLIENT_ID;
  const clientSecret = env?.SPOTIFY_CLIENT_SECRET;
  const refreshToken = env?.SPOTIFY_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken, key: `${clientId}:${refreshToken}` };
}

/* ── auth ────────────────────────────────────────────── */

async function getAccessToken(creds, { force = false } = {}) {
  if (!force && tokenCache.token && tokenCache.key === creds.key && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  if (tokenCache.promise && tokenCache.key === creds.key) return tokenCache.promise;

  const promise = (async () => {
    const basic = btoa(`${creds.clientId}:${creds.clientSecret}`);
    const res = await fetchWithTimeout(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: creds.refreshToken }).toString(),
    });
    if (res.status === 429) {
      backoffUntil = Date.now() + retryAfterMs(res);
      throw new SpotifyError("Spotify rate limited (token)", 429);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const hint = body?.error === "invalid_grant" ? " – refresh token revoked, run npx spotify-turntable auth again" : "";
      throw new SpotifyError(`Spotify token exchange failed (${res.status})${hint}`, res.status);
    }
    const data = await res.json().catch(() => null);
    if (!data?.access_token) throw new SpotifyError("Spotify token response missing access_token");
    const expiresIn = Number(data.expires_in) || 3600;
    tokenCache = {
      key: creds.key,
      token: data.access_token,
      expiresAt: Date.now() + Math.max(0, expiresIn - 60) * 1000,
      promise: null,
    };
    return data.access_token;
  })();

  tokenCache = { key: creds.key, token: null, expiresAt: 0, promise };
  try {
    return await promise;
  } finally {
    if (tokenCache.promise === promise) tokenCache.promise = null;
  }
}

// GET with bearer token; refreshes once on 401 and enters back-off on 429.
async function spotifyGet(url, creds) {
  if (inBackoff()) throw new SpotifyError("Spotify rate limited", 429);
  let token = await getAccessToken(creds);
  let res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    token = await getAccessToken(creds, { force: true });
    res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (res.status === 429) {
    const wait = retryAfterMs(res);
    backoffUntil = Date.now() + wait;
    throw new SpotifyError("Spotify rate limited", 429, wait);
  }
  return res;
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new SpotifyError("Invalid response from Spotify");
  }
}

// Shared TTL cache with in-flight de-duplication. Serves stale data when the loader fails.
async function cached(cache, key, ttl, loader) {
  const fresh = cache.key === key && cache.value !== null && Date.now() - cache.at < ttl;
  if (fresh) return { value: cache.value, at: cache.at };
  if (cache.promise && cache.key === key) return cache.promise;

  if (cache.key !== key) Object.assign(cache, { key, value: null, at: 0 });
  const promise = (async () => {
    try {
      const value = await loader();
      Object.assign(cache, { key, value, at: Date.now() });
      return { value, at: cache.at };
    } catch (err) {
      if (cache.key === key && cache.value !== null) return { value: cache.value, at: cache.at, stale: true, error: err };
      throw err;
    }
  })();
  cache.promise = promise;
  try {
    return await promise;
  } finally {
    if (cache.promise === promise) cache.promise = null;
  }
}

/* ── mapping ─────────────────────────────────────────── */

function largestImage(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  const sorted = [...images].sort((a, b) => (b?.width || 0) - (a?.width || 0));
  return sorted[0]?.url || null;
}

export function mapItem(item, progressMs = 0) {
  if (!item) return null;
  if (item.type === "episode") {
    return {
      id: item.id || null,
      type: "episode",
      title: item.name || "Unknown episode",
      artist: item.show?.publisher || item.show?.name || "",
      album: item.show?.name || "",
      albumArt: largestImage(item.images) || largestImage(item.show?.images),
      url: item.external_urls?.spotify || item.show?.external_urls?.spotify || "https://open.spotify.com",
      durationMs: item.duration_ms || 0,
      progressMs,
    };
  }
  if (item.type && item.type !== "track") return null;
  return {
    id: item.is_local ? null : item.id || null,
    type: "track",
    title: item.name || "Unknown track",
    artist: (item.artists || []).map((a) => a?.name).filter(Boolean).join(", "),
    album: item.album?.name || "",
    albumArt: largestImage(item.album?.images),
    url: item.external_urls?.spotify || "https://open.spotify.com",
    durationMs: item.duration_ms || 0,
    progressMs,
  };
}

export function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

// Seeded Fisher–Yates (mulberry32), so a shuffle is the same on every server and every visitor.
export function seededShuffle(list, seed) {
  const out = list.slice();
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Deterministic "radio" pick: every visitor at the same instant gets the same track + offset.
 * With `shuffle`, each full pass through the list plays in a fresh (but shared) random order.
 */
export function pickRotation(tracks, now = Date.now(), epoch = ROTATION_EPOCH, { shuffle = false } = {}) {
  let list = (tracks || []).filter((t) => t && t.durationMs > 0);
  const total = list.reduce((sum, t) => sum + t.durationMs, 0);
  if (!total) return null;
  const elapsed = now - epoch;
  if (shuffle) list = seededShuffle(list, Math.floor(elapsed / total) + 1);
  let t = ((elapsed % total) + total) % total;
  for (const track of list) {
    if (t < track.durationMs) return { ...track, progressMs: Math.floor(t) };
    t -= track.durationMs;
  }
  return { ...list[0], progressMs: 0 };
}

/* ── Spotify reads ───────────────────────────────────── */

async function loadPlayer(creds) {
  const res = await spotifyGet(NOW_PLAYING_URL, creds);
  if (res.status === 204) return { track: null, isPlaying: false }; // nothing loaded or private session
  if (!res.ok) throw new SpotifyError(`Spotify currently-playing failed (${res.status})`, res.status);
  const data = await readJson(res);
  if (!data?.item || data.currently_playing_type === "ad") return { track: null, isPlaying: false };
  return { track: mapItem(data.item, data.progress_ms || 0), isPlaying: Boolean(data.is_playing) };
}

async function loadRecent(creds) {
  const res = await spotifyGet(RECENT_URL, creds);
  if (!res.ok) throw new SpotifyError(`Spotify recently-played failed (${res.status})`, res.status);
  const data = await readJson(res);
  const last = data?.items?.[0];
  return {
    track: mapItem(last?.track, 0),
    playedAt: last?.played_at ? new Date(last.played_at).toISOString() : null,
  };
}

// Liked Songs isn't a real playlist: no ID, no public link, no embed. Tracks come from /me/tracks
// (scope user-library-read); visitors get per-track links and embeds instead of a playlist link.
async function loadLiked(creds) {
  const tracks = [];
  let url = `${API}/me/tracks?limit=50`;
  while (url && tracks.length < MAX_PLAYLIST_ITEMS) {
    const res = await spotifyGet(url, creds);
    if (res.status === 401 || res.status === 403) {
      throw new SpotifyError(`Spotify Liked Songs forbidden (${res.status}) – run npx spotify-turntable auth again to grant user-library-read`, res.status);
    }
    if (!res.ok) throw new SpotifyError(`Spotify Liked Songs failed (${res.status})`, res.status);
    const page = await readJson(res);
    for (const entry of page?.items || []) {
      const item = entry?.track ?? entry?.item;
      if (!item || item.is_local) continue;
      const track = mapItem(item, 0);
      if (track && track.durationMs > 0) tracks.push(track);
    }
    url = page?.next || null;
  }
  return { playlist: { id: null, name: "Liked Songs", url: null }, tracks };
}

async function loadPlaylist(creds, id) {
  if (id === LIKED) return loadLiked(creds);
  const metaRes = await spotifyGet(`${API}/playlists/${id}?fields=id,name,external_urls`, creds);
  if (!metaRes.ok) throw new SpotifyError(`Spotify playlist lookup failed (${metaRes.status})`, metaRes.status);
  const meta = (await readJson(metaRes)) || {};

  const tracks = [];
  // Feb 2026 API: /items with entries under `item`; extended-quota apps may still answer /tracks with `track`.
  let url = `${API}/playlists/${id}/items?limit=50&additional_types=track`;
  let triedLegacy = false;
  while (url && tracks.length < MAX_PLAYLIST_ITEMS) {
    const res = await spotifyGet(url, creds);
    if (res.status === 404 && !triedLegacy && tracks.length === 0) {
      triedLegacy = true;
      url = `${API}/playlists/${id}/tracks?limit=50`;
      continue;
    }
    if (res.status === 403) {
      throw new SpotifyError("Spotify playlist items forbidden (403) – the playlist must be owned by the connected account", 403);
    }
    if (!res.ok) throw new SpotifyError(`Spotify playlist items failed (${res.status})`, res.status);
    const page = await readJson(res);
    for (const entry of page?.items || []) {
      const item = entry?.item ?? entry?.track;
      if (!item || entry?.is_local || item.is_local) continue;
      const track = mapItem(item, 0);
      if (track && track.durationMs > 0) tracks.push(track);
    }
    url = page?.next || null;
  }

  return {
    playlist: {
      id,
      name: meta.name || "Rotation",
      url: meta.external_urls?.spotify || `https://open.spotify.com/playlist/${id}`,
    },
    tracks,
  };
}

async function getRotation(creds, id, shuffle) {
  const key = `${creds.key}:${id}`;
  const hasValue = playlistCache.key === key && playlistCache.value;
  // After a failure with nothing cached, wait a few minutes before asking Spotify again.
  if (!hasValue && playlistCache.key === key && Date.now() - playlistCache.failedAt < PLAYLIST_RETRY_MS) {
    throw playlistCache.error || new SpotifyError("Spotify playlist unavailable");
  }
  try {
    const { value } = await cached(playlistCache, key, PLAYLIST_TTL_MS, () => loadPlaylist(creds, id));
    const track = pickRotation(value.tracks, Date.now(), ROTATION_EPOCH, { shuffle });
    return track ? { track, playlist: value.playlist } : null;
  } catch (err) {
    Object.assign(playlistCache, { key, failedAt: Date.now(), error: err });
    throw err;
  }
}

/* ── responses ───────────────────────────────────────── */

function respond(mode, { track = null, playedAt = null, playlist = null, error, stale, demo } = {}) {
  return {
    configured: mode !== "unconfigured",
    mode,
    isPlaying: mode === "live",
    ...(demo ? { demo: true } : {}),
    track,
    playedAt,
    playlist,
    fetchedAt: Date.now(),
    ...(error ? { error } : {}),
    ...(stale ? { stale: true } : {}),
  };
}

const DEMO_TRACKS = [
  { title: "Demo Track", artist: "Not a real song", album: "Preview mode", durationMs: 214000 },
  { title: "Slow Sunday", artist: "House Rotation", album: "Preview mode", durationMs: 187000 },
  { title: "Night Drive", artist: "Placeholder Band", album: "Preview mode", durationMs: 243000 },
  { title: "Garage Hours", artist: "The Wrenches", album: "Preview mode", durationMs: 201000 },
].map((t) => ({ id: null, type: "track", albumArt: null, url: "https://open.spotify.com", progressMs: 0, ...t }));

function demoResult(kind) {
  if (kind === "rotation") {
    return respond("rotation", {
      demo: true,
      track: pickRotation(DEMO_TRACKS),
      // A public Spotify editorial playlist so the embed has something real to load in demo mode.
      playlist: {
        id: "37i9dQZF1DXcBWIGoYBM5M",
        name: "Demo rotation",
        url: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
      },
    });
  }
  const t = DEMO_TRACKS[0];
  return respond("live", { demo: true, track: { ...t, progressMs: Date.now() % t.durationMs } });
}

export async function getNowPlaying(env = process.env, { demo = null } = {}) {
  const demoKind = demo === true ? "live" : typeof demo === "string" ? parseDemo(demo) : null;
  if (demoKind) return demoResult(demoKind);

  const creds = credsFrom(env);
  if (!creds) return respond("unconfigured");
  const playlistId = parsePlaylistId(env?.SPOTIFY_FALLBACK_PLAYLIST);

  let player = null;
  let playerError = null;
  let stale = false;
  try {
    const r = await cached(nowCache, creds.key, NOW_TTL_MS, () => loadPlayer(creds));
    stale = !!r.stale;
    const t = r.value.track;
    // Advance progress by the cache age so cached responses stay in sync with real playback.
    const progressMs = t && r.value.isPlaying ? Math.min(t.durationMs, t.progressMs + (Date.now() - r.at)) : t?.progressMs || 0;
    player = { ...r.value, track: t ? { ...t, progressMs } : null };
  } catch (err) {
    playerError = err;
  }

  if (player?.isPlaying && player.track) return respond("live", { track: player.track, stale });

  let rotationError = null;
  if (playlistId) {
    try {
      const rotation = await getRotation(creds, playlistId, isTruthy(env?.SPOTIFY_SHUFFLE));
      if (rotation) return respond("rotation", { ...rotation, stale });
    } catch (err) {
      rotationError = err;
    }
  }

  if (player?.track) return respond("paused", { track: player.track, stale });

  const firstError = playerError || rotationError;
  try {
    const r = await cached(recentCache, creds.key, RECENT_TTL_MS, () => loadRecent(creds));
    return respond(r.value.track ? "recent" : "idle", {
      ...r.value,
      stale: stale || r.stale,
      error: firstError?.message,
    });
  } catch (err) {
    return respond("error", { error: (firstError || err)?.message || "Unknown error" });
  }
}
