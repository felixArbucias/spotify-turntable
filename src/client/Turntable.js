"use client";
/* global process -- read only inside try; bundlers inline process.env.NODE_ENV */
import { createElement as h, Fragment, useEffect, useId, useRef, useState } from "react";
import { useNowPlaying } from "./useNowPlaying.js";
import { formatMs, timeAgo } from "./format.js";

export const DEFAULT_LABELS = {
  loading: "Warming up the needle",
  playing: "Now spinning",
  rotation: "House rotation",
  paused: "On pause",
  recent: "Last spun",
  idle: "Nothing on the platter",
  unconfigured: "Not connected",
  offline: "Turntable offline",
};

const IS_DEV = (() => {
  try {
    if (import.meta.env) return !!import.meta.env.DEV;
  } catch {
    /* not Vite */
  }
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return false;
  }
})();

function embedFor(track, playlist) {
  if (track?.id && (track.type === "track" || track.type === "episode")) {
    return { src: `https://open.spotify.com/embed/${track.type}/${track.id}?utm_source=generator`, what: track.title };
  }
  if (playlist?.id) return { src: `https://open.spotify.com/embed/playlist/${playlist.id}?utm_source=generator`, what: playlist.name };
  return null;
}

const svg = (props, ...children) => h("svg", { "aria-hidden": "true", focusable: "false", ...props }, ...children);
const cross = (width) => h("path", { d: "M4 4l8 8M12 4l-8 8", stroke: "currentColor", strokeWidth: width, strokeLinecap: "round" });

function Vinyl({ track, empty }) {
  const id = useId().replace(/:/g, "");
  const grooves = [45, 41, 37, 33.5, 30, 26.5, 23].map((r) =>
    h("circle", { key: r, cx: 52, cy: 52, r, fill: "none", stroke: "#fff", strokeOpacity: 0.06, strokeWidth: 0.5 }),
  );
  return svg(
    { className: "deck-svg", viewBox: "0 0 120 104" },
    h(
      "defs",
      null,
      h("radialGradient", { id: `${id}-v` }, h("stop", { offset: 0.35, stopColor: "#1d1d1d" }), h("stop", { offset: 1, stopColor: "#090909" })),
      h("clipPath", { id: `${id}-l` }, h("circle", { cx: 52, cy: 52, r: 16 })),
    ),
    h(
      "g",
      { className: `deck-record${empty ? " is-empty" : ""}` },
      h("circle", { cx: 52, cy: 52, r: 50, fill: `url(#${id}-v)` }),
      ...grooves,
      h("circle", { cx: 52, cy: 52, r: 16, fill: "var(--deck-label, #e9dfcf)" }),
      track?.albumArt &&
        h("image", { href: track.albumArt, x: 36, y: 36, width: 32, height: 32, clipPath: `url(#${id}-l)`, preserveAspectRatio: "xMidYMid slice" }),
      h("circle", { cx: 52, cy: 52, r: 1.6, fill: "#f5f1ea" }),
    ),
    // Static sheen so the spin reads as light moving over grooves.
    h("path", { d: "M17 32 A41 41 0 0 1 36 14", stroke: "#fff", strokeOpacity: 0.14, strokeWidth: 3, fill: "none", strokeLinecap: "round" }),
    h("path", { d: "M87 72 A41 41 0 0 1 68 90", stroke: "#fff", strokeOpacity: 0.08, strokeWidth: 3, fill: "none", strokeLinecap: "round" }),
    h(
      "g",
      { className: "deck-arm" },
      h("circle", { cx: 108, cy: 12, r: 6, fill: "#d9d3c8" }),
      h("circle", { cx: 108, cy: 12, r: 2.5, fill: "#8f877a" }),
      h("path", { d: "M108 12 L108 58 L95 74", fill: "none", stroke: "#bdb5a8", strokeWidth: 2.4, strokeLinecap: "round", strokeLinejoin: "round" }),
      h("rect", { x: 88, y: 70, width: 10, height: 7, rx: 1.5, transform: "rotate(-48 93 73.5)", fill: "#2b2b2b" }),
    ),
  );
}

/**
 * A record-player card for whatever your Spotify account is playing.
 *
 *   <Turntable floating />                       // polls /api/now-playing, pinned top-right
 *   <Turntable endpoint="/api/np" labels={{ rotation: "Felix's rotation" }} />
 *   <Turntable np={useNowPlaying()} />           // share one poller with other widgets
 */
export function Turntable({
  np: external,
  endpoint,
  demo = null,
  pollMs,
  labels,
  fallbackUrl = "https://open.spotify.com",
  setupHint = "Run npx spotify-turntable auth",
  floating = false,
  className = "",
}) {
  const own = useNowPlaying({ endpoint, demo, pollMs, enabled: !external });
  const { state, track, playedAt, playlist, progressMs, demo: isDemo } = external || own;
  const text = { ...DEFAULT_LABELS, ...labels };

  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const playRef = useRef(null);
  const closeRef = useRef(null);
  const popId = useId();

  const moving = state === "playing" || state === "rotation";
  const pct = track?.durationMs ? Math.min(1, progressMs / track.durationMs) : 0;
  const href = track?.url || playlist?.url || fallbackUrl;
  const embed = embedFor(track, state === "rotation" ? playlist : null);
  const playlistName = state === "rotation" && playlist?.name ? playlist.name : null;

  let status = text[state] || text.idle;
  if (state === "recent" && playedAt) status = `${text.recent} · ${timeAgo(playedAt)}`;
  const aria = track
    ? `${status}${playlistName ? ` from ${playlistName}` : ""}: ${track.title} by ${track.artist}. Open in Spotify.`
    : `${status}. Open Spotify.`;

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        playRef.current?.focus();
      }
    };
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const hasEmbed = !!embed;
  useEffect(() => {
    if (!hasEmbed) setOpen(false);
  }, [hasEmbed]);

  const close = () => {
    setOpen(false);
    playRef.current?.focus();
  };

  const ticket = h(
    "span",
    { className: "deck-ticket", "aria-hidden": "true" },
    h(
      "span",
      { className: "deck-status", title: playlistName || undefined },
      h("i", { className: "deck-led" }),
      h("span", { className: "deck-status-text" }, status, isDemo && " (demo)"),
    ),
    track
      ? h(
          Fragment,
          null,
          h("span", { className: "deck-title" }, track.title),
          h("span", { className: "deck-artist" }, track.artist),
          moving &&
            track.durationMs > 0 &&
            h(
              "span",
              { className: "deck-time" },
              h("span", { className: "deck-bar" }, h("span", { style: { transform: `scaleX(${pct})` } })),
              h("span", { className: "deck-clock" }, `${formatMs(progressMs)} / ${formatMs(track.durationMs)}`),
            ),
        )
      : h("span", { className: "deck-artist deck-note" }, state === "unconfigured" && IS_DEV && setupHint ? setupHint : "Check back soon"),
  );

  const card = h(
    "div",
    {
      ref: rootRef,
      className: `deck is-${state}${moving ? " is-moving" : ""}${embed ? " has-play" : ""}${className ? ` ${className}` : ""}`,
    },
    h("a", { className: "deck-link", href, target: "_blank", rel: "noreferrer", "aria-label": aria }, h(Vinyl, { track, empty: !track }), ticket),
    embed &&
      h(
        "button",
        {
          ref: playRef,
          type: "button",
          className: "deck-play",
          "aria-expanded": open,
          "aria-controls": open ? popId : undefined,
          "aria-label": open ? "Close Spotify player" : `Listen to ${embed.what} here`,
          onClick: () => setOpen((v) => !v),
        },
        svg({ viewBox: "0 0 16 16" }, open ? cross(1.8) : h("path", { d: "M5 3.2v9.6L13 8z", fill: "currentColor" })),
      ),
    open &&
      embed &&
      h(
        "div",
        { id: popId, className: "deck-pop", role: "dialog", "aria-label": "Spotify player" },
        h(
          "div",
          { className: "deck-pop-head" },
          h("span", { className: "deck-pop-title" }, playlistName || "Listen on Spotify"),
          h(
            "button",
            { ref: closeRef, type: "button", className: "deck-pop-close", onClick: close, "aria-label": "Close player" },
            svg({ viewBox: "0 0 16 16" }, cross(1.6)),
          ),
        ),
        h("iframe", {
          className: "deck-embed",
          title: `Spotify player: ${embed.what}`,
          src: embed.src,
          width: "100%",
          height: 152,
          loading: "lazy",
          allow: "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture",
        }),
        state === "rotation" &&
          playlist?.url &&
          h("a", { className: "deck-pop-link", href: playlist.url, target: "_blank", rel: "noreferrer" }, "Open the whole rotation ↗"),
      ),
  );

  return floating ? h("div", { className: "deck-slot" }, card) : card;
}

export default Turntable;
