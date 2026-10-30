import { test } from "node:test";
import assert from "node:assert/strict";
import { nowPlayingHandler, nowPlayingFetchHandler } from "../src/server/index.js";
import { parseEnv, upsertEnv } from "../src/env-file.js";

test("fetch handler: unconfigured without credentials", async () => {
  const res = await nowPlayingFetchHandler({ env: {} })(new Request("http://x/api/now-playing"));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).mode, "unconfigured");
});

test("fetch handler: demo rotation is never cached", async () => {
  const res = await nowPlayingFetchHandler({ env: {} })(new Request("http://x/api/now-playing?demo=rotation"));
  const body = await res.json();
  assert.equal(body.mode, "rotation");
  assert.equal(body.demo, true);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("fetch handler: rejects POST", async () => {
  const res = await nowPlayingFetchHandler({ env: {} })(new Request("http://x/api/now-playing", { method: "POST" }));
  assert.equal(res.status, 405);
});

test("node handler: demo live via req.url", async () => {
  const headers = {};
  let body;
  const res = { statusCode: 0, setHeader: (k, v) => (headers[k.toLowerCase()] = v), end: (b) => (body = b) };
  await nowPlayingHandler({ env: {} })({ method: "GET", url: "/api/now-playing?demo=1" }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(body).mode, "live");
  assert.match(headers["content-type"], /json/);
});

test("upsertEnv updates in place and appends missing keys", () => {
  const before = "# mine\nFOO=1\nSPOTIFY_CLIENT_ID=old\n";
  const after = upsertEnv(before, { SPOTIFY_CLIENT_ID: "new", SPOTIFY_REFRESH_TOKEN: "tok" });
  assert.equal(after, "# mine\nFOO=1\nSPOTIFY_CLIENT_ID=new\n\n# Spotify turntable (npx spotify-turntable auth)\nSPOTIFY_REFRESH_TOKEN=tok\n");
  assert.deepEqual(parseEnv(after), { FOO: "1", SPOTIFY_CLIENT_ID: "new", SPOTIFY_REFRESH_TOKEN: "tok" });
  assert.equal(upsertEnv("", { A: "1" }), "# Spotify turntable (npx spotify-turntable auth)\nA=1\n");
});
