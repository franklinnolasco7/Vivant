/** Coordinates chapter rendering, progress persistence, TOC state, and selection actions. */
import * as api from "./api.js";
import * as ann from "./annotations.js";
import * as search from "./search.js";
import { esc, clamp, toast } from "./ui.js";
import { initImageViewer, openImageViewer, isImageViewerOpen } from "./image-viewer.js";
import { flashAnnotationHit, flashSearchHit } from "./text-match.js";
import { buildResumeLocator, applyResumeLocator, readResumeLocator, writeResumeLocator } from "./resume-locator.js";
import { initToc, setTocData, renderToc } from "./toc.js";
import * as timer from "./reading-timer.js";
import * as selection from "./reader-selection.js";
import * as links from "./reader-links.js";
import * as progressUI from "./progress-ui.js";

// --- State ---

/** @type {import('./api.js').Book|null} */
let book = null;
/** @type {import('./api.js').TocEntry[]} */
let toc = [];
let chapterIdx = 0;
let chapterTotal = 0;
let _saveTimer = null;
let _autoPaging = false;
let _lastAutoPageAt = 0;
let _lastScrollTop = 0;
let _searchHighlightTimer = null;
let _suspendAutoPageUntil = 0;
let _progressSaveQueue = Promise.resolve();
let _lastWheelDownAt = 0;
let _lastWheelUpAt = 0;
let _edgePageIntentDir = 0;
let _edgePageIntentCount = 0;
let _edgePageIntentAt = 0;
let _readerActive = false;
let _skipExternalLinkConfirmForSession = false;

/** @type {Map<string, import('./api.js').ChapterContent>} */
const _chapterCache = new Map();
const CHAPTER_CACHE_MAX = 50;


const AUTO_PAGE_THRESHOLD_PX = 56;
const AUTO_PAGE_COOLDOWN_MS = 420;
const AUTO_PAGE_WHEEL_INTENT_MS = 450;
const PROGRESS_SAVE_DEBOUNCE_MS = 500;
const EDGE_PAGE_INTENT_WINDOW_MS = 1800;
const EDGE_PAGE_INTENT_MIN_GAP_MS = 150;

const RESTORE_SUSPEND_MS = 1200;
const NAV_SUSPEND_MS = 300;
const REFINE_RETRY_DELAYS = [240, 350, 900];
const ANCHOR_SCROLL_RETRY_DELAYS = [180, 520];

// --- Initialize reader interactions ---

export function init() {
  initToc({ onChapterSelect: (ch) => loadChapter(ch) });
  document.getElementById("btn-ann").addEventListener("click", ann.toggle);

  document.getElementById("btn-prev").addEventListener("click", prevChapter);
  document.getElementById("btn-next").addEventListener("click", nextChapter);

  progressUI.init({
    getBook: () => book,
    getChapterIdx: () => chapterIdx,
    getChapterTotal: () => chapterTotal,
    getToc: () => toc,
    clampChapterIndex,
    chapterProgressPct,
    loadChapter,
    scheduleProgressSave
  });

  // Debounce writes so frequent scroll events do not flood persistence.
  const readingArea = document.getElementById("reading-area");
  readingArea.addEventListener("click", onReadingAreaClick, true);
  readingArea.addEventListener("scroll", () => {
    const now = Date.now();
    const autoPageSuspended = now < _suspendAutoPageUntil;
    const currentTop = readingArea.scrollTop;
    const direction = autoPageSuspended
      ? 0
      : (currentTop > _lastScrollTop ? 1 : (currentTop < _lastScrollTop ? -1 : 0));
    _lastScrollTop = currentTop;

    // Require real user movement so restore/layout scrolls do not flip chapters.
    if (!autoPageSuspended && direction !== 0) {
      maybeAutoPage(readingArea, direction);
    }

    // Skip writes during restore so we do not overwrite a valid saved position.
    if (autoPageSuspended) return;

    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(persistProgress, PROGRESS_SAVE_DEBOUNCE_MS);
  });

  // Track wheel velocity to enable chapter flips for short chapters that don't scroll
  readingArea.addEventListener("wheel", (e) => {
    const now = Date.now();
    if (e.deltaY > 0) _lastWheelDownAt = now;
    if (e.deltaY < 0) _lastWheelUpAt = now;

    // Defer chapter flips until content restore settles to prevent accidental navigation
    if (now < _suspendAutoPageUntil) return;
    maybeAutoPageFromWheel(readingArea, e.deltaY);
  }, { passive: true });

  selection.init({ getChapterIdx: () => chapterIdx });
  links.init({
    getBook: () => book,
    getChapterIdx: () => chapterIdx,
    clampChapterIndex,
    normalizeAnchorTarget,
    scrollToAnchor,
    scheduleProgressSave,
    loadChapter
  });
  initImageViewer();

  ann.init({ onJump: loadChapter });

  search.init({ onJump: loadChapter });

  timer.init();
}

function onReadingAreaClick(event) {
  if (!(event.target instanceof Element)) return;
  const img = event.target.closest("img");
  if (!img || !img.closest(".chapter-body")) return;
  if (isImageViewerOpen()) return;

  event.preventDefault();
  event.stopPropagation();

  openImageViewer(img);
}

function chapterProgressPct(idx) {
  if (chapterTotal <= 1) return 10;
  const clamped = clampChapterIndex(idx);
  return Math.round((clamped / (chapterTotal - 1)) * 100);
}

export function setActive(isActive) {
  const next = Boolean(isActive);
  if (_readerActive === next) return;

  _readerActive = next;
  timer.setActive(_readerActive);
}

// --- Open and restore a book ---

export async function openBook(b) {
  timer.setBook(null);

  // Fresh book = fresh chapter cache.
  _chapterCache.clear();

  book = b;
  chapterIdx = b.progress_chapter ?? 0;
  let restoreScrollPct = 0;
  let restoreLocator = readResumeLocator(book.id);

  // Synchronous initial values
  if (restoreLocator && Number.isFinite(restoreLocator.chapterIdx)) {
    chapterIdx = clampChapterIndex(restoreLocator.chapterIdx);
    if (Number.isFinite(restoreLocator.scrollPct)) {
      restoreScrollPct = clamp(restoreLocator.scrollPct, 0, 1);
    }
  } else {
    // If no locator, use initial book progress passed in list 
    // it will be updated when getProgress completes if necessary, but this gives instant first render
  }

  // Render chapter immediately!
  let chapterRenderPromise = loadChapter(chapterIdx, {
    scrollTarget: "restore",
    restoreScrollPct,
    restoreLocator,
  }).catch(() => {});

  // Fetch the rest in parallel
  const [tocResult, progResult, annResult] = await Promise.allSettled([
    api.getToc(b.file_path),
    api.getProgress(b.id),
    ann.load(b.id)
  ]);

  if (tocResult.status === 'fulfilled') {
    toc = tocResult.value;
    chapterTotal = toc.length || 1;
    ann.setToc(toc);
  } else {
    toc = [];
    chapterTotal = 1;
  }

  let finalChapterIdx = chapterIdx;
  let finalRestoreScrollPct = restoreScrollPct;

  if (progResult.status === 'fulfilled' && progResult.value) {
    const prog = progResult.value;
    // Only apply DB progress if we didn't have a valid resume locator 
    if (!restoreLocator || !Number.isFinite(restoreLocator.chapterIdx)) {
        finalChapterIdx = prog.chapter_idx;
        finalRestoreScrollPct = clamp(prog.scroll_pct ?? 0, 0, 1);
    }
  }

  chapterIdx = clampChapterIndex(finalChapterIdx);
  progressUI.rebuildChapterTooltipTitles();

  setTocData(toc, chapterIdx);
  renderToc();

  // If the chapter index changed because of the parallel progress fetch, we load again.
  // This is rare since we use book.progress_chapter or resumeLocator initially.
  if (chapterIdx !== finalChapterIdx) {
      await loadChapter(chapterIdx, {
        scrollTarget: "restore",
        restoreScrollPct: finalRestoreScrollPct,
        restoreLocator,
      });
  }

  timer.setBook(book);
  if (_readerActive) timer.start();
}


// --- Chapter loading ---

export async function loadChapter(idx, opts = {}) {
  if (!book) return;
  chapterIdx = clampChapterIndex(idx);

  const scrollTarget =
    opts.scrollTarget === "bottom" || opts.scrollTarget === "restore"
      ? opts.scrollTarget
      : "top";
  const restoreScrollPct = clamp(opts.restoreScrollPct ?? 0, 0, 1);
  const restoreLocator = opts.restoreLocator || null;
  const highlightQuery = (opts.highlightQuery ?? "").trim();
  const highlightQuote = (opts.highlightQuote ?? "").trim();
  const anchorTarget = normalizeAnchorTarget(opts.anchorTarget ?? "");

  document.getElementById("chapter-content").innerHTML =
    `<div class="empty-state"><div class="empty-state-sub">Loading…</div></div>`;

  try {
    const cacheKey = `${book.file_path}::${idx}`;
    let ch = _chapterCache.get(cacheKey);
    if (!ch) {
      ch = await api.getChapter(book.file_path, idx);
      // LRU eviction: delete oldest entry when cache is full.
      if (_chapterCache.size >= CHAPTER_CACHE_MAX) {
        const oldest = _chapterCache.keys().next().value;
        _chapterCache.delete(oldest);
      }
      _chapterCache.set(cacheKey, ch);
    }
    renderChapter(ch, scrollTarget, restoreScrollPct, restoreLocator, highlightQuery, highlightQuote, anchorTarget);
  } catch (err) {
    document.getElementById("chapter-content").innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">Could not load chapter</div>
        <div class="empty-state-sub">${esc(err.message)}</div>
      </div>`;
  }
}

function renderChapter(
  ch,
  scrollTarget = "top",
  restoreScrollPct = 0,
  restoreLocator = null,
  highlightQuery = "",
  highlightQuote = "",
  anchorTarget = ""
) {
  progressUI.clearHoverFrame();
  progressUI.hideTooltip(true);
  progressUI.clearWheelTarget();

  document.getElementById("chapter-content").innerHTML = `
    <div class="chapter-num">${esc(ch.title)} · ${ch.index + 1} of ${chapterTotal}</div>
    <div class="chapter-body">${ch.html}</div>`;

  links.attach(document.querySelector(".chapter-body"));
  convertLocalImageUrls();
  setupImageErrorHandling();

  updateReaderUI(ch);

  const readingArea = document.getElementById("reading-area");
  const suspendDuration = applyScrollRestore(readingArea, scrollTarget, restoreScrollPct, restoreLocator, ch);

  if (anchorTarget) {
    queueAnchorScroll(anchorTarget);
  }

  _lastScrollTop = readingArea.scrollTop;

  if (scrollTarget !== "restore") {
    persistProgress();
  } else {
    clearTimeout(_saveTimer);
    const saveDelay = Math.max(PROGRESS_SAVE_DEBOUNCE_MS, suspendDuration + 50);
    _saveTimer = setTimeout(persistProgress, saveDelay);
  }

  scheduleHighlightSave(highlightQuote, highlightQuery);
}





function queueAnchorScroll(anchor) {
  const normalized = normalizeAnchorTarget(anchor);
  if (!normalized) return;

  const attempt = () => {
    if (scrollToAnchor(normalized)) {
      scheduleProgressSave();
      return true;
    }
    return false;
  };

  requestAnimationFrame(() => {
    if (attempt()) return;
    setTimeout(attempt, ANCHOR_SCROLL_RETRY_DELAYS[0]);
    setTimeout(attempt, ANCHOR_SCROLL_RETRY_DELAYS[1]);
  });
}

function scrollToAnchor(anchor) {
  const target = findAnchorElement(anchor);
  if (!target) return false;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

function findAnchorElement(anchor) {
  const normalized = normalizeAnchorTarget(anchor);
  if (!normalized) return null;

  const directId = document.getElementById(normalized);
  if (directId) return directId;

  const escaped = normalized
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');

  return document.querySelector(
    `.chapter-body [id="${escaped}"], .chapter-body a[name="${escaped}"]`
  );
}

export function normalizeAnchorTarget(anchor) {
  const raw = String(anchor ?? "").trim().replace(/^#/, "");
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function scheduleProgressSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(persistProgress, PROGRESS_SAVE_DEBOUNCE_MS);
}


async function convertLocalImageUrls() {
  const elements = [...document.querySelectorAll(".chapter-body img, .chapter-body image")];
  if (!elements.length) return;

  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");

    elements.forEach((el) => {
      const attrs = ["src", "href", "xlink:href"];
      let raw = "";
      let usedAttr = "";
      for (const attr of attrs) {
        if (el.hasAttribute(attr)) {
          const val = el.getAttribute(attr);
          if (val && val.startsWith("file://")) {
            raw = val;
            usedAttr = attr;
            break;
          }
        }
      }

      if (!raw) return;

      try {
        const parsed = new URL(raw);
        let filePath = decodeURIComponent(parsed.pathname);
        // Normalize Windows paths so convertFileSrc receives a valid local path.
        if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1);
        el.setAttribute(usedAttr, convertFileSrc(filePath));
      } catch {
        // Leave original src to avoid hiding images when conversion fails.
      }
    });
  } catch {
    // Best-effort conversion: keep rendering even if platform API is unavailable.
  }
}

// --- Navigation ---

async function prevChapter() {
  if (chapterIdx > 0) await loadChapter(chapterIdx - 1, { scrollTarget: "bottom" });
}
async function nextChapter() {
  if (chapterIdx < chapterTotal - 1) await loadChapter(chapterIdx + 1, { scrollTarget: "top" });
}

async function maybeAutoPage(readingArea, direction) {
  if (!book || _autoPaging || direction === 0) return;

  const now = Date.now();
  if (now - _lastAutoPageAt < AUTO_PAGE_COOLDOWN_MS) return;

  const nearBottom = readingArea.scrollTop + readingArea.clientHeight >= (readingArea.scrollHeight - AUTO_PAGE_THRESHOLD_PX);
  const nearTop = readingArea.scrollTop <= AUTO_PAGE_THRESHOLD_PX;

  const hasRecentDownWheel = (now - _lastWheelDownAt) <= AUTO_PAGE_WHEEL_INTENT_MS;
  const hasRecentUpWheel = (now - _lastWheelUpAt) <= AUTO_PAGE_WHEEL_INTENT_MS;

  if (direction > 0 && nearBottom && hasRecentDownWheel && chapterIdx < chapterTotal - 1) {
    // Require multiple deliberate interactions at edge to prevent accidental chapter flips from momentum
    if (!consumeEdgePageIntent(1)) return;
    _autoPaging = true;
    _lastAutoPageAt = now;
    try {
      await loadChapter(chapterIdx + 1, { scrollTarget: "top" });
    } finally {
      _autoPaging = false;
      resetEdgePageIntent();
    }
    return;
  }

  if (direction < 0 && nearTop && hasRecentUpWheel && chapterIdx > 0) {
    // Require multiple deliberate interactions at edge to prevent accidental chapter flips from momentum
    if (!consumeEdgePageIntent(-1)) return;
    _autoPaging = true;
    _lastAutoPageAt = now;
    try {
      await loadChapter(chapterIdx - 1, { scrollTarget: "bottom" });
    } finally {
      _autoPaging = false;
      resetEdgePageIntent();
    }
    return;
  }

  if ((direction > 0 && !nearBottom) || (direction < 0 && !nearTop)) {
    resetEdgePageIntent();
  }
}

async function maybeAutoPageFromWheel(readingArea, deltaY) {
  if (!book || _autoPaging || deltaY === 0) return;

  const now = Date.now();
  if (now - _lastAutoPageAt < AUTO_PAGE_COOLDOWN_MS) return;

  const nearBottom = readingArea.scrollTop + readingArea.clientHeight >= (readingArea.scrollHeight - AUTO_PAGE_THRESHOLD_PX);
  const nearTop = readingArea.scrollTop <= AUTO_PAGE_THRESHOLD_PX;
  const noScrollableOverflow = readingArea.scrollHeight <= (readingArea.clientHeight + 1);

  if (deltaY > 0 && (nearBottom || noScrollableOverflow) && chapterIdx < chapterTotal - 1) {
    // Require multiple deliberate interactions at edge to prevent accidental chapter flips from momentum
    if (!consumeEdgePageIntent(1)) return;
    _autoPaging = true;
    _lastAutoPageAt = now;
    try {
      await loadChapter(chapterIdx + 1, { scrollTarget: "top" });
    } finally {
      _autoPaging = false;
      resetEdgePageIntent();
    }
    return;
  }

  if (deltaY < 0 && (nearTop || noScrollableOverflow) && chapterIdx > 0) {
    // Require multiple deliberate interactions at edge to prevent accidental chapter flips from momentum
    if (!consumeEdgePageIntent(-1)) return;
    _autoPaging = true;
    _lastAutoPageAt = now;
    try {
      await loadChapter(chapterIdx - 1, { scrollTarget: "bottom" });
    } finally {
      _autoPaging = false;
      resetEdgePageIntent();
    }
    return;
  }

  if ((deltaY > 0 && !nearBottom && !noScrollableOverflow)
    || (deltaY < 0 && !nearTop && !noScrollableOverflow)) {
    resetEdgePageIntent();
  }
}

function consumeEdgePageIntent(direction) {
  const now = Date.now();
  const sameDirection = _edgePageIntentDir === direction;
  const withinWindow = (now - _edgePageIntentAt) <= EDGE_PAGE_INTENT_WINDOW_MS;
  const hasGap = (now - _edgePageIntentAt) >= EDGE_PAGE_INTENT_MIN_GAP_MS;

  if (!sameDirection || !withinWindow) {
    _edgePageIntentDir = direction;
    _edgePageIntentCount = 1;
    _edgePageIntentAt = now;
    return false;
  }

  // Ignore repeated edge checks from the same momentum burst.
  if (!hasGap) {
    return false;
  }

  _edgePageIntentCount += 1;
  _edgePageIntentAt = now;
  if (_edgePageIntentCount < 2) return false;
  return true;
}

function resetEdgePageIntent() {
  _edgePageIntentDir = 0;
  _edgePageIntentCount = 0;
  _edgePageIntentAt = 0;
}


// --- Progress ---

async function persistProgress() {
  if (!book) return;

  const bookId = book.id;
  const chapter = chapterIdx;
  const ra = document.getElementById("reading-area");
  if (!ra || ra.clientHeight <= 0 || ra.scrollHeight <= 0) return;

  const maxScroll = Math.max(1, ra.scrollHeight - ra.clientHeight);
  const pct = maxScroll > 0 ? ra.scrollTop / maxScroll : 0;

  // Save both percentage and structural locator to survive chapter reflows.
  const locator = buildResumeLocator(ra, chapter, pct);
  if (locator) {
    writeResumeLocator(bookId, locator);
  }

  // Serialize saves to prevent stale writes from racing newer positions.
  _progressSaveQueue = _progressSaveQueue
    .catch(() => { })
    .then(async () => {
      try {
        await api.saveProgress(bookId, chapter, clamp(pct, 0, 1));
      } catch {
        // Ignore transient save errors; next scroll save will retry.
      }
    });
}

export async function flushProgress() {
  clearTimeout(_saveTimer);
  await persistProgress();
  await timer.flush();
}




// --- Search bridge ---

export function openSearch() {
  if (!book) return;
  search.open(book.file_path, toc);
}

// --- Utilities ---

function clampChapterIndex(idx) {
  const n = Number.isFinite(idx) ? Math.trunc(idx) : 0;
  const max = Math.max(0, chapterTotal - 1);
  return clamp(n, 0, max);
}

function applyScrollPct(readingArea, pct) {
  if (readingArea.scrollHeight <= readingArea.clientHeight) {
    readingArea.scrollTop = 0;
    return;
  }
  const p = clamp(pct, 0, 1);
  const maxScroll = readingArea.scrollHeight - readingArea.clientHeight;
  const targetScroll = p * maxScroll;
  readingArea.scrollTop = targetScroll;
}

function setupImageErrorHandling() {
  const images = document.querySelectorAll('.chapter-body img');
  images.forEach((img) => {
    img.addEventListener('error', () => {
      img.style.display = 'none';
    });

    img.addEventListener('load', () => {
      img.style.opacity = '1';
    });
  });
}

function updateReaderUI(ch) {
  const pct = chapterProgressPct(ch.index);

  document.getElementById("reader-book-title").textContent = book.title;
  document.getElementById("reader-chapter-title").textContent = ch.title;
  progressUI.updateDisplay(pct, ch.index);
  document.getElementById("btn-prev").disabled = ch.index === 0;
  document.getElementById("btn-next").disabled = ch.index >= chapterTotal - 1;

  setTocData(toc, chapterIdx);
  renderToc();
}

function applyScrollRestore(readingArea, scrollTarget, restoreScrollPct, restoreLocator, ch) {
  const restoreForChapter =
    restoreLocator && Number.isFinite(restoreLocator.chapterIdx) && restoreLocator.chapterIdx === ch.index
      ? restoreLocator
      : null;

  const suspendDuration = scrollTarget === "restore" ? RESTORE_SUSPEND_MS : NAV_SUSPEND_MS;
  _suspendAutoPageUntil = Date.now() + suspendDuration;

  if (scrollTarget === "restore") {
    applyScrollPct(readingArea, restoreScrollPct);

    const refinePosition = () => {
      if (restoreForChapter) {
        applyResumeLocator(readingArea, restoreForChapter, scroll => { _lastScrollTop = scroll; });
      }
    };

    requestAnimationFrame(() => {
      applyScrollPct(readingArea, restoreScrollPct);
      refinePosition();
    });

    setTimeout(() => {
      applyScrollPct(readingArea, restoreScrollPct);
      refinePosition();
    }, REFINE_RETRY_DELAYS[0]);

    if (restoreForChapter) {
      setTimeout(() => refinePosition(), REFINE_RETRY_DELAYS[1]);
      setTimeout(() => refinePosition(), REFINE_RETRY_DELAYS[2]);

      document.querySelectorAll(".chapter-body img").forEach((img) => {
        if (img.complete) return;
        img.addEventListener("load", () => {
          if (Date.now() < _suspendAutoPageUntil) {
            refinePosition();
          }
        }, { once: true });
      });
    }
  } else if (scrollTarget === "bottom") {
    readingArea.scrollTop = Math.max(0, readingArea.scrollHeight - readingArea.clientHeight - 2);
  } else {
    readingArea.scrollTop = 0;
  }

  return suspendDuration;
}

function scheduleHighlightSave(highlightQuote, highlightQuery) {
  if (!highlightQuote && !highlightQuery) return;

  requestAnimationFrame(() => {
    const flashed =
      (highlightQuote && flashAnnotationHit(highlightQuote))
      || (highlightQuery && flashSearchHit(highlightQuery));
    if (flashed) {
      clearTimeout(_saveTimer);
      _saveTimer = setTimeout(persistProgress, PROGRESS_SAVE_DEBOUNCE_MS);
    }
  });
}

