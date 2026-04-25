import { clamp } from "./ui.js";

const RESUME_LOCATOR_STORAGE_KEY = "vivant.resume-locators.v1";
const LOCATOR_TEXT_HINT_MAX = 120;
const LOCATOR_PIXEL_TOLERANCE = 200;
const LOCATOR_TEXT_SLICE_MAX = 160;

export function buildResumeLocator(readingArea, chapter, scrollPct) {
  const body = document.querySelector(".chapter-body");
  if (!body) return null;

  const maxScrollTop = Math.max(0, readingArea.scrollHeight - readingArea.clientHeight);
  const currentScroll = readingArea.scrollTop;

  // Hit-test element near top of viewport (20% down or 16px minimum) for stable resume point
  const areaRect = readingArea.getBoundingClientRect();
  const targetY = areaRect.top + Math.max(16, areaRect.height * 0.2);
  let el = document.elementFromPoint(areaRect.left + areaRect.width / 2, targetY);

  // Fall back to first visible element when hit-testing fails or document restructures
  if (!el || !body.contains(el)) {
    const candidates = [...body.querySelectorAll("p,li,h1,h2,h3,h4,h5,h6,blockquote,div,span")];
    el = candidates.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom >= areaRect.top + 16;
    });
    if (!el) el = body.firstElementChild;
  }

  if (!el || !body.contains(el)) return null;

  const target = nearestLocatorElement(el, body);
  if (!target) return null;

  const bodyRect = body.getBoundingClientRect();
  const elementOffsetFromTop = target.getBoundingClientRect().top - bodyRect.top;

  const scrollOffsetFromElement = currentScroll - elementOffsetFromTop;

  return {
    chapterIdx: chapter,
    scrollPct: clamp(scrollPct, 0, 1),
    scrollTopPx: currentScroll,
    scrollablePx: maxScrollTop,
    path: buildElementPath(target, body),
    textHint: (target.textContent || "").trim().slice(0, LOCATOR_TEXT_HINT_MAX),
    offsetPx: Math.round(scrollOffsetFromElement),
    savedAt: Date.now(),
  };
}

export function applyResumeLocator(readingArea, locator, onScrollTopSet) {
  const body = document.querySelector(".chapter-body");
  if (!body || !locator) return false;

  const maxScrollTop = Math.max(0, readingArea.scrollHeight - readingArea.clientHeight);
  const pxFallback = computePixelResumeTarget(locator, maxScrollTop);

  // Prefer structural path matching before fuzzy text matching.
  let target = null;
  if (locator.path && locator.path.length > 0) {
    target = resolveElementPath(body, locator.path);
  }

  if (!target && locator.textHint && locator.textHint.length > 0) {
    const hint = locator.textHint.toLocaleLowerCase();
    const candidates = [...body.querySelectorAll("p,li,h1,h2,h3,h4,h5,h6,blockquote,div")].filter(el => {
      const text = (el.textContent || "").toLocaleLowerCase();
      return text.length > 0 && text.includes(hint);
    });

    if (candidates.length > 0) {
      target = candidates.reduce((best, el) => {
        const txt = (el.textContent || "").toLocaleLowerCase();
        const idx = txt.indexOf(hint);
        const bestIdx = best ? (best.textContent || "").toLocaleLowerCase().indexOf(hint) : Infinity;
        return idx < bestIdx ? el : best;
      });
    }
  }

  if (target) {
    const bodyRect = body.getBoundingClientRect();
    const elementOffsetFromTop = target.getBoundingClientRect().top - bodyRect.top;
    const wanted = clamp(elementOffsetFromTop + (Number(locator.offsetPx) || 0), 0, maxScrollTop);

    // Guard against large jumps when layout differs from the saved snapshot.
    if (Math.abs(wanted - pxFallback) < LOCATOR_PIXEL_TOLERANCE || !Number.isFinite(pxFallback)) {
      readingArea.scrollTop = wanted;
      if (onScrollTopSet) onScrollTopSet(readingArea.scrollTop);
      return true;
    }
  }

  if (Number.isFinite(pxFallback)) {
    readingArea.scrollTop = pxFallback;
    if (onScrollTopSet) onScrollTopSet(readingArea.scrollTop);
    return true;
  }

  return false;
}

export function computePixelResumeTarget(locator, maxScrollTop) {
  const rawTop = Number(locator.scrollTopPx);
  if (!Number.isFinite(rawTop)) return null;

  const savedScrollable = Number(locator.scrollablePx);
  if (Number.isFinite(savedScrollable) && savedScrollable > 0) {
    // Viewport height may differ: rescale saved position to current scroll range
    return clamp((rawTop / savedScrollable) * maxScrollTop, 0, maxScrollTop);
  }

  return clamp(rawTop, 0, maxScrollTop);
}

export function nearestLocatorElement(el, root) {
  let cur = el;
  while (cur && cur !== root) {
    if (cur.parentElement === root) return cur;
    cur = cur.parentElement;
  }
  return root.firstElementChild || null;
}

export function buildElementPath(el, root) {
  const steps = [];
  let cur = el;

  while (cur && cur !== root) {
    const parent = cur.parentElement;
    if (!parent) break;
    const idx = [...parent.children].indexOf(cur);
    if (idx < 0) break;
    steps.push(idx);
    cur = parent;
  }

  return steps.reverse();
}

export function resolveElementPath(root, path) {
  if (!Array.isArray(path) || !path.length) return null;

  let cur = root;
  for (const idx of path) {
    if (!cur?.children?.length) return null;
    if (!Number.isInteger(idx) || idx < 0 || idx >= cur.children.length) return null;
    cur = cur.children[idx];
  }
  return cur instanceof Element ? cur : null;
}

export function readResumeLocator(bookId) {
  if (!bookId) return null;

  try {
    const raw = localStorage.getItem(RESUME_LOCATOR_STORAGE_KEY);
    if (!raw) return null;

    const all = JSON.parse(raw);
    if (!all || typeof all !== "object") return null;

    const loc = all[bookId];
    if (!loc || typeof loc !== "object") return null;
    if (!Number.isFinite(loc.chapterIdx)) return null;

    return {
      chapterIdx: Math.trunc(loc.chapterIdx),
      scrollPct: clamp(Number(loc.scrollPct) || 0, 0, 1),
      scrollTopPx: Number.isFinite(Number(loc.scrollTopPx)) ? Number(loc.scrollTopPx) : null,
      scrollablePx: Number.isFinite(Number(loc.scrollablePx)) ? Number(loc.scrollablePx) : null,
      path: Array.isArray(loc.path) ? loc.path.filter(Number.isInteger) : [],
      textHint: typeof loc.textHint === "string" ? loc.textHint : "",
      offsetPx: Math.trunc(Number(loc.offsetPx) || 0),
      savedAt: Number(loc.savedAt) || 0,
    };
  } catch {
    return null;
  }
}

export function writeResumeLocator(bookId, locator) {
  if (!bookId || !locator) return;

  try {
    const raw = localStorage.getItem(RESUME_LOCATOR_STORAGE_KEY);
    const all = raw ? JSON.parse(raw) : {};
    if (!all || typeof all !== "object") return;

    all[bookId] = {
      chapterIdx: Math.trunc(locator.chapterIdx || 0),
      scrollPct: clamp(Number(locator.scrollPct) || 0, 0, 1),
      scrollTopPx: Number.isFinite(Number(locator.scrollTopPx)) ? Number(locator.scrollTopPx) : null,
      scrollablePx: Number.isFinite(Number(locator.scrollablePx)) ? Number(locator.scrollablePx) : null,
      path: Array.isArray(locator.path) ? locator.path.slice(0, 64) : [],
      textHint: typeof locator.textHint === "string" ? locator.textHint.slice(0, LOCATOR_TEXT_SLICE_MAX) : "",
      offsetPx: Math.trunc(Number(locator.offsetPx) || 0),
      savedAt: Number(locator.savedAt) || Date.now(),
    };

    localStorage.setItem(RESUME_LOCATOR_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Local storage can fail in constrained environments; continue silently.
  }
}
