export function timeAgo(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)} hr ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function formatMs(ms) {
  const t = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}
