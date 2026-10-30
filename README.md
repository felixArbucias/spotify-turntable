# spotify-turntable

A little record player that shows what you're playing on Spotify, live. The record spins and the tonearm drops while music plays. When you're not listening, it can play from a playlist (or your Liked Songs) like a radio station, so visitors always see something spinning. Visitors can press play to listen right on your site.

Made for personal sites and portfolios. React on the front, any JavaScript server on the back, and no database.

- **Live:** polls Spotify every ~15 s and moves the progress bar smoothly between polls.
- **House rotation:** when you're idle, every visitor hears the same song at the same moment, like a radio station.
- **Cheap on rate limits:** results are cached in memory and at the CDN, so many visitors share a handful of Spotify calls.
- **Secrets stay on the server:** the browser only ever sees track names and artwork.
- **Accessible:** keyboard support, honours `prefers-reduced-motion`, and turns into a compact pill on phones.

## Try it in two minutes

```bash
git clone https://github.com/felixArbucias/portfolio
cd portfolio/packages/spotify-turntable
npm install
npm run auth     # connect your Spotify account (walks you through it)
npm run dev      # open the printed URL
```

No Spotify yet? Open `?demo=live` or `?demo=rotation` to see it with sample songs.

## Add it to your site

### 1. Install

```bash
npm install spotify-turntable
```

### 2. Connect your Spotify account (once)

```bash
npx spotify-turntable auth
```

It walks you through it:

1. Create an app at <https://developer.spotify.com/dashboard>. Add the redirect URI `http://127.0.0.1:8888/callback` and tick **Web API**.
2. Paste the **Client ID** and **Client Secret** when asked.
3. Approve access in the browser tab that opens.

It then writes everything to `.env.local`:

```bash
SPOTIFY_CLIENT_ID=…
SPOTIFY_CLIENT_SECRET=…
SPOTIFY_REFRESH_TOKEN=…
SPOTIFY_FALLBACK_PLAYLIST=liked   # optional, see "House rotation"
SPOTIFY_SHUFFLE=true              # optional, shuffle the rotation
```

Make sure `.env.local` is in your `.gitignore` (the command warns you if it isn't). When you deploy, add the same values as environment variables on your host (Vercel, Netlify, …).

> New Spotify apps run in development mode. That works for your own account, which is all a personal site needs, but Spotify currently requires the app owner to have Premium.

### 3. Add the endpoint

The component asks your own server for `/api/now-playing`, and the server talks to Spotify. Pick your setup:

**Vite (dev and preview)**

```js
// vite.config.js
import react from "@vitejs/plugin-react";
import { spotifyTurntable } from "spotify-turntable/vite";

export default { plugins: [react(), spotifyTurntable()] };
```

**Vercel (Vite, Create React App, plain HTML…)**

```js
// api/now-playing.js
import { nowPlayingHandler } from "spotify-turntable/server";
export default nowPlayingHandler();
```

**Next.js (App Router)**

```js
// app/api/now-playing/route.js
import { nowPlayingFetchHandler } from "spotify-turntable/server";
export const GET = nowPlayingFetchHandler();
export const dynamic = "force-dynamic";
```

**Express**

```js
import { nowPlayingHandler } from "spotify-turntable/server";
app.get("/api/now-playing", nowPlayingHandler());
```

**Anything else.** `nowPlayingFetchHandler()` is a standard `(Request) => Response` handler: use it with Netlify Functions, Cloudflare Workers, Deno or Bun. Or call `getNowPlaying(process.env)` yourself and return the JSON.

### 4. Drop in the component

```jsx
import { Turntable } from "spotify-turntable";
import "spotify-turntable/style.css";

export default function Layout() {
  return <Turntable floating />; // pinned to the top-right corner
}
```

That's it. Restart your dev server and it shows whatever you're playing.

## Options

```jsx
<Turntable
  floating              // pin to the top-right corner (otherwise it renders in place)
  endpoint="/api/now-playing"
  labels={{ rotation: "Felix's rotation", playing: "On the deck" }}
  fallbackUrl="https://open.spotify.com/user/you"  // where the card links when nothing has played
  demo="rotation"       // "live" | "rotation": sample data, no Spotify needed
/>
```

All label keys: `loading`, `playing`, `rotation`, `paused`, `recent`, `idle`, `unconfigured`, `offline`.

**Share one poller.** If other parts of your page also want to know what's playing:

```jsx
import { Turntable, useNowPlaying } from "spotify-turntable";

const np = useNowPlaying(); // { state, track, playlist, progressMs, playedAt, demo }
<Turntable np={np} />
<MyOtherWidget song={np.track} />
```

**Theme.** Override the CSS variables on `.deck`:

```css
.deck {
  --deck-card: #fffdf9;   /* card background */
  --deck-edge: #ece7df;   /* border */
  --deck-ink: #1a1a1a;    /* text */
  --deck-soft: #6b6b6b;   /* secondary text */
  --deck-line: #e7e3dc;   /* progress track */
  --deck-label: #e9dfcf;  /* record centre label */
  --deck-vinyl: 150px;    /* overall size */
}
```

## House rotation

Set `SPOTIFY_FALLBACK_PLAYLIST` to keep the record spinning while you're offline:

| Value | What happens |
|---|---|
| `liked` | Rotates through your **Liked Songs**. Visitors can play each song, but Liked Songs has no public playlist link. |
| a playlist link or ID | Rotates through that playlist and offers an "Open the whole rotation" link. The playlist must belong to (or be collaborative with) the connected account. |
| empty | Shows what you paused on, or the last song you played. |

The rotation plays in order. Set `SPOTIFY_SHUFFLE=true` to shuffle it: each pass through the list gets a new random order, and every visitor still hears the same song at the same moment.

## What the card shows

1. **Now spinning:** what you're playing right now (songs and podcasts).
2. **House rotation:** nothing playing, so it plays from your fallback playlist.
3. **On pause / Last spun:** no rotation set, so it shows the last thing you played.
4. **Not connected:** no credentials yet (in development it tells you to run the auth command).

## The JSON

`GET /api/now-playing` (add `?demo=live` or `?demo=rotation` for sample data):

```json
{
  "configured": true,
  "mode": "live",
  "isPlaying": true,
  "track": {
    "id": "…", "type": "track", "title": "…", "artist": "…", "album": "…",
    "albumArt": "https://i.scdn.co/…", "url": "https://open.spotify.com/track/…",
    "durationMs": 214000, "progressMs": 81234
  },
  "playlist": null,
  "playedAt": null,
  "fetchedAt": 1793370000000
}
```

`mode` is one of `live`, `rotation`, `paused`, `recent`, `idle`, `unconfigured` or `error`.

## How it works

It uses only the official [Spotify Web API](https://developer.spotify.com/documentation/web-api). There's no SDK and nothing in between:

- `npx spotify-turntable auth` runs Spotify's standard login flow once and saves a **refresh token**.
- On each request, the server swaps that for a short-lived access token (cached for about an hour). It then reads `currently-playing`, falls back to your rotation (`/playlists/{id}/items` or `/me/tracks`), and finally to `recently-played`.
- In-memory caches (player about 12 s, recent about 60 s, playlist about 6 h) and `Cache-Control` headers keep Spotify calls low. If Spotify rate-limits it, it waits and keeps showing the last good result.
- The play button opens Spotify's official embed player.

Scopes requested: `user-read-currently-playing`, `user-read-recently-played`, `user-read-playback-state`, `playlist-read-private`, `playlist-read-collaborative`, `user-library-read`. Everything is read-only.

## Develop

```bash
npm test         # mocked Spotify, never hits the network
npm run dev      # example app on http://localhost:5173
```

## License

MIT © Felix Arbucias. Not affiliated with Spotify.
