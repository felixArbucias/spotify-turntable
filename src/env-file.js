// Tiny .env reader/writer used by the auth CLI.

export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}



/** Updates KEY=value lines in place and appends the ones that are missing. */
export function upsertEnv(text, values) {
  const lines = text ? text.split(/\r?\n/) : [];
  const done = new Set();
  const next = lines.map((line) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && m[1] in values) {
      done.add(m[1]);
      return `${m[1]}=${values[m[1]]}`;
    }
    return line;
  });
  while (next.length && next[next.length - 1] === "") next.pop();
  const missing = Object.keys(values).filter((k) => !done.has(k));
  if (missing.length) {
    if (next.length) next.push("");
    next.push("# Spotify turntable (npx spotify-turntable auth)");
    for (const k of missing) next.push(`${k}=${values[k]}`);
  }
  return next.join("\n") + "\n";
}
