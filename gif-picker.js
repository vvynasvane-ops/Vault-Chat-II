// js/gif-picker.js
//
// Thin wrapper around Tenor's v2 search API for the in-chat GIF picker
// (Section 14). Requires your OWN free Tenor API key — takes a couple of
// minutes to get, no billing required:
//   https://developers.google.com/tenor/guides/quickstart
// Paste it in below. Without a key, search/trending both fail fast and the
// picker shows a clear inline message instead of a silently empty grid.
const TENOR_API_KEY = "REPLACE_WITH_YOUR_TENOR_API_KEY";
const TENOR_BASE = "https://tenor.googleapis.com/v2";
const CLIENT_KEY = "vaultchattii_web";

function mapResult(r) {
  const gif = r.media_formats?.gif;
  const tiny = r.media_formats?.tinygif || gif;
  if (!gif || !tiny) return null;
  return {
    id: r.id,
    previewUrl: tiny.url,
    gifUrl: gif.url,
    description: r.content_description || "GIF",
  };
}

async function tenorFetch(path, params) {
  if (!TENOR_API_KEY || TENOR_API_KEY.startsWith("REPLACE_")) {
    throw new Error("GIF search needs a Tenor API key — see js/gif-picker.js");
  }
  const url = new URL(`${TENOR_BASE}/${path}`);
  url.searchParams.set("key", TENOR_API_KEY);
  url.searchParams.set("client_key", CLIENT_KEY);
  url.searchParams.set("media_filter", "gif,tinygif");
  url.searchParams.set("contentfilter", "medium");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`GIF search failed (${res.status})`);
  const data = await res.json();
  return (data.results || []).map(mapResult).filter(Boolean);
}

export async function getTrendingGifs(limit = 24) {
  return tenorFetch("featured", { limit });
}

export async function searchGifs(query, limit = 24) {
  return tenorFetch("search", { q: query, limit });
}

// The picker grid only ever shows small preview thumbnails (media_filter
// above), so the real bytes are fetched here, on pick, right before they're
// handed to the same encrypted media pipeline as an attached file.
export async function fetchGifBlob(gifUrl) {
  const res = await fetch(gifUrl);
  if (!res.ok) throw new Error("Couldn't download that GIF");
  return await res.blob();
}
