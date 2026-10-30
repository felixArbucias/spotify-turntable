#!/usr/bin/env node
/*
 * npx spotify-turntable auth
 *
 * One-time setup: asks for your Spotify app's Client ID / Secret (if they aren't already in your
 * env file), opens Spotify's consent screen, and writes SPOTIFY_REFRESH_TOKEN (plus the rest)
 * into .env.local. Nothing is sent anywhere except Spotify.
 */
import http from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, exit } from "node:process";
import { parseEnv, upsertEnv } from "../src/env-file.js";

const SCOPES = [
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-read-playback-state",
  "playlist-read-private", // private / collaborative SPOTIFY_FALLBACK_PLAYLIST
  "playlist-read-collaborative",
  "user-library-read", // SPOTIFY_FALLBACK_PLAYLIST=liked
].join(" ");

const HELP = `spotify-turntable

Usage
  npx spotify-turntable auth [options]   Connect your Spotify account (writes .env.local)
  npx spotify-turntable help

Options
  --env-file <path>   File to read and update (default: .env.local)
  --port <n>          Local callback port (default: 8888)
  --print             Only print the values; don't write any file
`;

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}

const command = argv[2] && !argv[2].startsWith("--") ? argv[2] : "auth";
if (command === "help" || argv.includes("--help") || argv.includes("-h")) {
  stdout.write(HELP);
  exit(0);
}
if (command !== "auth") {
  console.error(`Unknown command "${command}".\n`);
  stdout.write(HELP);
  exit(1);
}

const ENV_FILE = flag("env-file", ".env.local");
const PORT = Number(flag("port", 8888));
const PRINT_ONLY = argv.includes("--print");
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");

function isGitIgnored(file) {
  const rules = read(".gitignore").split(/\r?\n/).map((l) => l.trim());
  const name = file.replace(/^\.\//, "");
  return rules.some((r) => r === name || r === `/${name}` || r === "*.local" || r === ".env*" || r === ".env.*");
}

function openBrowser(url) {
  try {
    const [cmd, args] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
        : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is printed too.
  }
}

async function exchangeCode(code, clientId, clientSecret) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) {
    const reason = data.error_description || data.error || "no refresh_token";
    const hint = data.error === "invalid_client" ? " (check the Client ID / Secret)" : "";
    throw new Error(`Token exchange failed (${res.status}): ${reason}${hint}`);
  }
  return data.refresh_token;
}

function authorize(clientId, clientSecret) {
  const state = randomBytes(12).toString("hex");
  const url =
    "https://accounts.spotify.com/authorize?" +
    new URLSearchParams({ response_type: "code", client_id: clientId, scope: SCOPES, redirect_uri: REDIRECT_URI, state, show_dialog: "true" });

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (u.pathname !== "/callback") return res.writeHead(404).end();
      const finish = (status, body, err, token) => {
        res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(body);
        server.close();
        if (err) reject(err);
        else resolve(token);
      };
      if (u.searchParams.get("error")) return finish(400, "Authorization was cancelled. You can close this tab.", new Error(`Spotify said: ${u.searchParams.get("error")}`));
      if (u.searchParams.get("state") !== state) return finish(400, "State mismatch. Run the command again.", new Error("State mismatch"));
      try {
        const token = await exchangeCode(u.searchParams.get("code") || "", clientId, clientSecret);
        finish(200, "Connected! Head back to your terminal. You can close this tab.", null, token);
      } catch (err) {
        finish(500, "Token exchange failed. Check your terminal.", err);
      }
    });
    server.on("error", (err) => reject(err.code === "EADDRINUSE" ? new Error(`Port ${PORT} is busy. Try --port 8889 (and add that redirect URI in Spotify).`) : err));
    server.listen(PORT, "127.0.0.1", () => {
      console.log("\nOpening Spotify so you can approve access (or open this link yourself):\n");
      console.log(`  ${url}\n`);
      openBrowser(url);
    });
  });
}

async function main() {
  const fileEnv = { ...parseEnv(read(".env")), ...parseEnv(read(ENV_FILE)) };
  const env = { ...fileEnv, ...process.env };
  let clientId = env.SPOTIFY_CLIENT_ID;
  let clientSecret = env.SPOTIFY_CLIENT_SECRET;
  let playlist = env.SPOTIFY_FALLBACK_PLAYLIST;

  console.log("spotify-turntable · connect your Spotify account\n");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    if (!clientId || !clientSecret) {
      console.log("1. Go to https://developer.spotify.com/dashboard and create an app.");
      console.log(`2. In the app's settings, add this Redirect URI:  ${REDIRECT_URI}`);
      console.log("   (tick \"Web API\" when it asks which APIs you'll use)");
      console.log("3. Copy the Client ID and Client Secret below.\n");
      while (!clientId) clientId = (await rl.question("Client ID: ")).trim();
      while (!clientSecret) clientSecret = (await rl.question("Client Secret: ")).trim();
    } else {
      console.log(`Using the Client ID from ${ENV_FILE}. Make sure ${REDIRECT_URI} is a Redirect URI in your Spotify app.`);
    }
    if (playlist === undefined && stdin.isTTY) {
      console.log("\nWhen you're not playing anything, the turntable can play from a rotation like a radio station.");
      playlist = (await rl.question("Paste a playlist link, type \"liked\" for your Liked Songs, or press Enter to skip: ")).trim();
    }
  } finally {
    rl.close();
  }

  const refreshToken = await authorize(clientId, clientSecret);
  const values = { SPOTIFY_CLIENT_ID: clientId, SPOTIFY_CLIENT_SECRET: clientSecret, SPOTIFY_REFRESH_TOKEN: refreshToken };
  if (playlist) values.SPOTIFY_FALLBACK_PLAYLIST = playlist;

  if (PRINT_ONLY) {
    console.log("\nConnected. Add these to your environment (keep them secret):\n");
    for (const [k, v] of Object.entries(values)) console.log(`${k}=${v}`);
  } else {
    writeFileSync(ENV_FILE, upsertEnv(read(ENV_FILE), values));
    console.log(`\nConnected! Saved your credentials to ${ENV_FILE}.`);
    if (existsSync(".git") && !isGitIgnored(ENV_FILE)) {
      console.log(`\n⚠  ${ENV_FILE} doesn't look git-ignored. Add it to .gitignore so you never commit your secret.`);
    }
  }
  console.log("\nRestart your dev server and the turntable will be live.");
  console.log("Deploying? Add the same SPOTIFY_* values as environment variables on your host (Vercel, Netlify…).");
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  exit(1);
});
