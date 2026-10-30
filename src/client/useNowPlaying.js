import { useEffect, useRef, useState } from "react";

const POLL_MS = 15000;
const MAX_AGE_MS = 30000;

function stateOf(data, error) {
  if (!data) return error ? "offline" : "loading";
  if (!data.configured) return "unconfigured";
  const mode = data.mode || (data.isPlaying ? "live" : data.track ? "recent" : "idle");
  if (mode === "live") return data.track ? "playing" : "idle";
  if (mode === "error") return "offline";
  if (["rotation", "paused", "recent"].includes(mode)) return data.track ? mode : "idle";
  return "idle";
}

function demoQuery(demo) {
  if (!demo) return "";
  return demo === "rotation" ? "?demo=rotation" : "?demo=1";
}

/**
 * Polls the now-playing endpoint. Progress is extrapolated locally between polls so the record
 * and bar move smoothly, and the next poll is scheduled for when the current track ends.
 *
 * Returns { state, track, playedAt, playlist, progressMs, demo } where state is one of
 * loading | playing | rotation | paused | recent | idle | unconfigured | offline.
 */
export function useNowPlaying({ endpoint = "/api/now-playing", demo = null, pollMs = POLL_MS, enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const base = useRef({ at: 0, progress: 0 });
  const url = `${endpoint}${demoQuery(demo)}`;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer;

    const load = async () => {
      let next = pollMs;
      try {
        const res = await fetch(url, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(String(res.status));
        const json = await res.json();
        if (!alive) return;
        const now = Date.now();
        const moving = json.mode === "rotation" || json.isPlaying;
        // Responses can sit in a CDN for a few seconds; catch up using the server timestamp.
        const age = moving && json.fetchedAt ? Math.min(MAX_AGE_MS, Math.max(0, now - json.fetchedAt)) : 0;
        base.current = { at: now, progress: (json.track?.progressMs || 0) + age };
        if (moving && json.track?.durationMs) {
          const remaining = json.track.durationMs - base.current.progress;
          next = Math.max(2000, Math.min(pollMs, remaining + 1500));
        }
        setData(json);
        setError(false);
      } catch {
        if (alive) setError(true);
      }
      if (alive) timer = setTimeout(load, document.hidden ? pollMs * 4 : next);
    };

    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        load();
      }
    };

    load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, pollMs, enabled]);

  const state = stateOf(data, error);
  const moving = state === "playing" || state === "rotation";

  const [, tick] = useState(0);
  useEffect(() => {
    if (!moving) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [moving]);

  const track = data?.track || null;
  let progressMs = track?.progressMs || 0;
  if (moving && track) {
    progressMs = Math.min(track.durationMs, base.current.progress + (Date.now() - base.current.at));
  }

  return {
    state,
    track,
    playedAt: data?.playedAt || null,
    playlist: data?.playlist || null,
    progressMs,
    demo: !!data?.demo,
  };
}
