/**
 * cover-cache.js — Caches book cover object URLs to avoid re-decoding
 * large base64 strings on every render.
 */

/** @type {Map<string, string>} bookId → objectURL */
const cache = new Map();

/**
 * Returns a blob object URL for the given cover, decoding the base64 only once.
 * Falls back to the raw data URI if decoding fails so the image still renders.
 * @param {string} bookId
 * @param {string|null|undefined} base64DataUri  e.g. "data:image/jpeg;base64,…"
 * @returns {string|null}
 */
export function getCoverUrl(bookId, base64DataUri) {
  if (!base64DataUri) return null;
  const hit = cache.get(bookId);
  if (hit) return hit;

  try {
    const commaIdx = base64DataUri.indexOf(",");
    if (commaIdx === -1) return base64DataUri; // not a data URI — pass through
    const header = base64DataUri.slice(0, commaIdx);
    const data = base64DataUri.slice(commaIdx + 1);
    const mime = header.match(/:(.*?);/)?.[1] || "image/jpeg";
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    cache.set(bookId, url);
    return url;
  } catch (_err) {
    return base64DataUri;
  }
}

/**
 * Revokes the object URL and removes it from cache.
 * Call this when a book is deleted to avoid memory leaks.
 * @param {string} bookId
 */
export function invalidate(bookId) {
  const url = cache.get(bookId);
  if (url) {
    URL.revokeObjectURL(url);
    cache.delete(bookId);
  }
}

export function invalidateAll() {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
}
