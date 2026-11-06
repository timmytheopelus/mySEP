const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

/**
 * Video id from an https YouTube URL (watch?v=, youtu.be/, embed/), else null. Everything else (other hosts,
 * other schemes, userinfo, ports, extra path segments, scheme-relative URLs) is rejected.
 */
export function parseYoutubeId(url: string): string | null {
  if (typeof url !== "string" || url.length > 300 || !url.startsWith("https://")) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be") {
    const m = /^\/([^/]+)\/?$/.exec(u.pathname);
    id = m ? m[1] : null;
  } else if (WATCH_HOSTS.has(host) && u.pathname === "/watch") {
    id = u.searchParams.get("v");
  } else if ((WATCH_HOSTS.has(host) || host === "www.youtube-nocookie.com") && /^\/embed\/[^/]+\/?$/.test(u.pathname)) {
    id = u.pathname.split("/")[2];
  }
  return id !== null && ID_RE.test(id) ? id : null;
}

export function embedUrl(id: string): string {
  if (!ID_RE.test(id)) throw new Error("Invalid YouTube id");
  return `https://www.youtube-nocookie.com/embed/${id}`;
}

export const canonicalWatchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
