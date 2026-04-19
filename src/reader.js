/** Coordinates chapter rendering, progress persistence, TOC state, and selection actions. */
import * as api from "./api.js";
import * as ann from "./annotations.js";
import * as search from "./search.js";
import { esc, toast } from "./ui.js";
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


const AUTO_PAGE_THRESHOLD_PX = 56;
const AUTO_PAGE_COOLDOWN_MS = 420;
const AUTO_PAGE_WHEEL_INTENT_MS = 450;
const PROGRESS_SAVE_DEBOUNCE_MS = 500;
const EDGE_PAGE_INTENT_WINDOW_MS = 1800;
const EDGE_PAGE_INTENT_MIN_GAP_MS = 320;

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

  book = b;
  chapterIdx = b.progress_chapter ?? 0;
  let restoreScrollPct = 0;
  let restoreLocator = null;

  try {
    toc = await api.getToc(b.file_path);
    chapterTotal = toc.length || 1;
  } catch {
    toc = [];
    chapterTotal = 1;
  }

  try {
    const prog = await api.getProgress(b.id);
    if (prog) {
      chapterIdx = prog.chapter_idx;
      restoreScrollPct = clamp(prog.scroll_pct ?? 0, 0, 1);
    }
  } catch {
    // Reading should still open even if persisted progress is unavailable.
  }

  restoreLocator = readResumeLocator(book.id);

  if (restoreLocator && Number.isFinite(restoreLocator.chapterIdx)) {
    const locatorChapter = restoreLocator.chapterIdx;
    chapterIdx = clampChapterIndex(locatorChapter);
    if (Number.isFinite(restoreLocator.scrollPct)) {
      restoreScrollPct = clamp(restoreLocator.scrollPct, 0, 1);
    }
  }

  chapterIdx = clampChapterIndex(chapterIdx);
  progressUI.rebuildChapterTooltipTitles();

  setTocData(toc, chapterIdx);
  renderToc();
  await ann.load(b.id);
  await loadChapter(chapterIdx, {
    scrollTarget: "restore",
    restoreScrollPct,
    restoreLocator,
  });

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
    const ch = await api.getChapter(book.file_path, idx);
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
  const pct = chapterProgressPct(ch.index);

  progressUI.clearHoverFrame();
  progressUI.hideTooltip(true);
  progressUI.clearWheelTarget();

  document.getElementById("chapter-content").innerHTML = `
    <div class="chapter-num">${esc(ch.title)} · ${ch.index + 1} of ${chapterTotal}</div>
    <div class="chapter-body">${ch.html}</div>`;

  links.attach(document.querySelector(".chapter-body"));

  convertLocalImageUrls();

  // Hide broken inline images to prevent layout glitches in reader flow.
  const images = document.querySelectorAll('.chapter-body img');
  images.forEach((img) => {
    img.addEventListener('error', () => {
      img.style.display = 'none';
    });

    img.addEventListener('load', () => {
      img.style.opacity = '1';
    });
  });

  document.getElementById("reader-book-title").textContent = book.title;
  document.getElementById("reader-chapter-title").textContent = ch.title;
  progressUI.updateDisplay(pct, ch.index);
  document.getElementById("btn-prev").disabled = ch.index === 0;
  document.getElementById("btn-next").disabled = ch.index >= chapterTotal - 1;

  setTocData(toc, chapterIdx);
  renderToc();

  const readingArea = document.getElementById("reading-area");
  const restoreForChapter =
    restoreLocator && Number.isFinite(restoreLocator.chapterIdx) && restoreLocator.chapterIdx === ch.index
      ? restoreLocator
      : null;

  // Suppress auto-pagination while programmatic restore scroll is settling.
  const suspendDuration = scrollTarget === "restore" ? 1200 : 300;
  _suspendAutoPageUntil = Date.now() + suspendDuration;

  if (scrollTarget === "restore") {
    // Apply percentage first, then refine by element for stable resume behavior.
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

    // Re-apply once fonts/resources settle to reduce visual jumps.
    setTimeout(() => {
      applyScrollPct(readingArea, restoreScrollPct);
      refinePosition();
    }, 240);

    if (restoreForChapter) {
      setTimeout(() => refinePosition(), 350);
      setTimeout(() => refinePosition(), 900);

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

  if (anchorTarget) {
    queueAnchorScroll(anchorTarget);
  }

  _lastScrollTop = readingArea.scrollTop;

  // Delay save after restore so persisted progress reflects final settled position.
  if (scrollTarget !== "restore") {
    persistProgress();
  } else {
    clearTimeout(_saveTimer);
    const saveDelay = Math.max(
      PROGRESS_SAVE_DEBOUNCE_MS,
      (suspendDuration + 50),
    );
    _saveTimer = setTimeout(persistProgress, saveDelay);
  }

  if (highlightQuote || highlightQuery) {
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
    setTimeout(attempt, 180);
    setTimeout(attempt, 520);
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

function normalizeAnchorTarget(anchor) {
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
    .catch(() => {})
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

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

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

