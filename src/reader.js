/** Coordinates chapter rendering, progress persistence, TOC state, and selection actions. */
import * as api from "./api.js";
import * as ann from "./annotations.js";
import * as search from "./search.js";
import { esc, toast } from "./ui.js";

// --- State ---

/** @type {import('./api.js').Book|null} */
let book = null;
/** @type {import('./api.js').TocEntry[]} */
let toc = [];
let chapterIdx = 0;
let chapterTotal = 0;
let tocOpen = true;
const tocCollapsedGroups = new Set();
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
let _readingTimeTimer = null;
let _lastReadingTickAt = 0;
let _pendingReadingSeconds = 0;
let _readingTimeQueue = Promise.resolve();
let _skipExternalLinkConfirmForSession = false;
let _progressDrag = null;
let _progressWheelTargetChapter = null;
let _progressWheelTimer = null;
let _progressWheelCarry = 0;
let _progressHoverRaf = 0;
let _progressHoverClientX = 0;
let _progressBarEl = null;
let _progressTooltipEl = null;
let _progressTooltipTitleEl = null;
let _progressTooltipMetaEl = null;
let _progressTooltipVisible = false;
let _progressTooltipLastChapter = -1;
let _progressTooltipLastPlacement = "";
let _progressTooltipWidth = 0;
let _progressTooltipHeight = 0;
let _chapterTooltipTitles = [];
let _imageViewerBackdrop = null;
let _imageViewerPanel = null;
let _imageViewerImg = null;
let _imageViewerCaption = null;
let _imageViewerCloseTimer = null;
let _imageViewerMenu = null;
let _imageViewerMenuOpen = false;
let _imageViewerMenuSrc = "";
let _imageViewerMenuAlt = "";

const AUTO_PAGE_THRESHOLD_PX = 56;
const AUTO_PAGE_COOLDOWN_MS = 420;
const AUTO_PAGE_WHEEL_INTENT_MS = 450;
const PROGRESS_SAVE_DEBOUNCE_MS = 500;
const RESUME_LOCATOR_STORAGE_KEY = "vellum.resume-locators.v1";
const EDGE_PAGE_INTENT_WINDOW_MS = 1800;
const EDGE_PAGE_INTENT_MIN_GAP_MS = 320;
const READING_TIME_TICK_MS = 15000;
const MAX_READING_TIME_STEP_SEC = 120;
const PROGRESS_WHEEL_STEP_THRESHOLD = 110;
const PROGRESS_TOOLTIP_VIEWPORT_MARGIN_PX = 8;

// --- Initialize reader interactions ---

export function init() {
  document.getElementById("btn-toc").addEventListener("click", toggleToc);
  document.getElementById("btn-ann").addEventListener("click", ann.toggle);

  document.getElementById("btn-prev").addEventListener("click", prevChapter);
  document.getElementById("btn-next").addEventListener("click", nextChapter);

  const progressBar = document.getElementById("reader-progress");
  _progressBarEl = progressBar;
  _progressTooltipEl = document.getElementById("reader-progress-tooltip");
  _progressTooltipTitleEl = _progressTooltipEl?.querySelector(".reader-progress-tooltip-title") ?? null;
  _progressTooltipMetaEl = _progressTooltipEl?.querySelector(".reader-progress-tooltip-meta") ?? null;
  progressBar.addEventListener("pointerdown", onProgressPointerDown);
  progressBar.addEventListener("pointermove", onProgressPointerMove);
  progressBar.addEventListener("pointerup", onProgressPointerUp);
  progressBar.addEventListener("pointercancel", onProgressPointerCancel);
  progressBar.addEventListener("mousemove", onProgressHoverMove);
  progressBar.addEventListener("mouseleave", onProgressHoverLeave);

  // Make chapter seek easier: wheel anywhere on the reader bottom controls.
  const readerBottomBar = document.querySelector(".reader-bottombar");
  readerBottomBar?.addEventListener("wheel", onProgressWheel, { passive: false });

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

  initSelectionTooltip();
  initImageViewer();

  ann.init({ onJump: loadChapter });

  search.init({ onJump: loadChapter });

  // Avoid counting time when app is backgrounded to measure genuine reading time
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flushReadingTime();
      stopReadingTimer();
      return;
    }
    if (_readerActive && book) startReadingTimer();
  });
}

function onReadingAreaClick(event) {
  if (!(event.target instanceof Element)) return;
  const img = event.target.closest("img");
  if (!img || !img.closest(".chapter-body")) return;
  if (_imageViewerBackdrop?.classList.contains("open")) return;

  event.preventDefault();
  event.stopPropagation();

  openImageViewer(img);
}

function onProgressPointerDown(event) {
  if (!book || event.button !== 0) return;

  const progressBar = getProgressBarElement();
  if (!progressBar) return;

  clearProgressHoverFrame();
  hideProgressTooltip(true);

  const pct = progressPctFromClientX(progressBar, event.clientX);
  _progressDrag = {
    pointerId: event.pointerId,
    moved: false,
    pct,
    startX: event.clientX,
  };

  progressBar.setPointerCapture(event.pointerId);
  applyProgressPreview(pct);
  event.preventDefault();
}

function onProgressPointerMove(event) {
  if (!_progressDrag || _progressDrag.pointerId !== event.pointerId) return;

  const progressBar = getProgressBarElement();
  if (!progressBar) return;

  const pct = progressPctFromClientX(progressBar, event.clientX);
  _progressDrag.pct = pct;
  _progressDrag.moved ||= Math.abs(event.clientX - _progressDrag.startX) >= 2;
  applyProgressPreview(pct);
}

function onProgressPointerUp(event) {
  if (!_progressDrag || _progressDrag.pointerId !== event.pointerId) return;

  const progressBar = getProgressBarElement();
  if (progressBar?.hasPointerCapture(event.pointerId)) {
    progressBar.releasePointerCapture(event.pointerId);
  }

  const pct = _progressDrag.pct;
  _progressDrag = null;
  seekToProgressPct(pct);
}

function onProgressPointerCancel(event) {
  if (!_progressDrag || _progressDrag.pointerId !== event.pointerId) return;

  const progressBar = getProgressBarElement();
  if (progressBar?.hasPointerCapture(event.pointerId)) {
    progressBar.releasePointerCapture(event.pointerId);
  }

  _progressDrag = null;
  updateProgressDisplay(chapterProgressPct(chapterIdx), chapterIdx);
}

function onProgressHoverMove(event) {
  if (!book || _progressDrag) return;

  _progressHoverClientX = event.clientX;
  if (_progressHoverRaf) return;
  _progressHoverRaf = requestAnimationFrame(() => {
    _progressHoverRaf = 0;
    showProgressTooltip(_progressHoverClientX);
  });
}

function onProgressHoverLeave() {
  clearProgressHoverFrame();
  hideProgressTooltip();
}

function onProgressWheel(event) {
  if (!book || chapterTotal <= 1) return;

  event.preventDefault();
  clearProgressHoverFrame();
  hideProgressTooltip();

  // Clamp to one chapter step per debounce window.
  if (Number.isFinite(_progressWheelTargetChapter)) {
    return;
  }

  const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 18
    : (event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 120 : 1);
  _progressWheelCarry += event.deltaY * deltaScale;

  const stepCount = Math.trunc(_progressWheelCarry / PROGRESS_WHEEL_STEP_THRESHOLD);
  if (stepCount === 0) return;

  _progressWheelCarry -= stepCount * PROGRESS_WHEEL_STEP_THRESHOLD;

  const baseChapter = Number.isFinite(_progressWheelTargetChapter)
    ? _progressWheelTargetChapter
    : chapterIdx;
  const targetChapter = clampChapterIndex(baseChapter + stepCount);
  if (targetChapter === baseChapter) return;

  _progressWheelTargetChapter = targetChapter;
  updateProgressDisplay(chapterProgressPct(targetChapter), targetChapter);

  clearTimeout(_progressWheelTimer);
  _progressWheelTimer = setTimeout(() => {
    const pendingTarget = _progressWheelTargetChapter;
    _progressWheelTargetChapter = null;
    _progressWheelTimer = null;

    if (!Number.isFinite(pendingTarget) || pendingTarget === chapterIdx) {
      updateProgressDisplay(chapterProgressPct(chapterIdx), chapterIdx);
      return;
    }

    void loadChapter(pendingTarget, { scrollTarget: "top" });
  }, 120);
}

function progressPctFromClientX(progressBar, clientX) {
  const rect = progressBar.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  const x = clientX - rect.left;
  return clamp(x / rect.width, 0, 1);
}

function chapterIndexFromProgressPct(pct) {
  if (chapterTotal <= 1) return chapterIdx;
  const normalized = clamp(pct, 0, 1);
  return clampChapterIndex(Math.floor(normalized * (chapterTotal - 1)));
}

function chapterProgressPct(idx) {
  if (chapterTotal <= 1) return 10;
  const clamped = clampChapterIndex(idx);
  return Math.round((clamped / (chapterTotal - 1)) * 100);
}

function updateProgressDisplay(progressPct, chapterForLabel) {
  const safeChapter = clampChapterIndex(chapterForLabel);
  document.getElementById("reader-progress-fill").style.width = `${clamp(progressPct, 0, 100)}%`;
  document.getElementById("pos-label").textContent = `${safeChapter + 1}/${chapterTotal} · ${Math.round(progressPct)}%`;
}

function applyProgressPreview(pct) {
  if (!book) return;

  const targetChapter = chapterIndexFromProgressPct(pct);
  const progressPct = chapterProgressPct(targetChapter);
  updateProgressDisplay(progressPct, targetChapter);
}

function seekToProgressPct(pct) {
  if (!book) return;

  const normalized = clamp(pct, 0, 1);
  const targetChapter = chapterIndexFromProgressPct(normalized);

  if (targetChapter !== chapterIdx) {
    void loadChapter(targetChapter, { scrollTarget: "top" });
    return;
  }

  // Scroll within chapter to avoid expensive chapter reload for same-chapter jumps.
  const readingArea = document.getElementById("reading-area");
  if (!readingArea) return;

  readingArea.scrollTop = normalized * Math.max(0, readingArea.scrollHeight - readingArea.clientHeight);
  scheduleProgressSave();
  updateProgressDisplay(chapterProgressPct(chapterIdx), chapterIdx);
}

function clearProgressHoverFrame() {
  if (!_progressHoverRaf) return;
  cancelAnimationFrame(_progressHoverRaf);
  _progressHoverRaf = 0;
}

function showProgressTooltip(clientX) {
  if (!book || _progressDrag) return;

  const progressBar = getProgressBarElement();
  const tooltip = getProgressTooltipElement();
  if (!progressBar || !tooltip || !_progressTooltipTitleEl || !_progressTooltipMetaEl) return;

  const pct = progressPctFromClientX(progressBar, clientX);
  const targetChapter = chapterIndexFromProgressPct(pct);
  if (targetChapter !== _progressTooltipLastChapter) {
    const chapterPct = chapterProgressPct(targetChapter);
    _progressTooltipTitleEl.textContent = chapterTooltipTitle(targetChapter);
    _progressTooltipMetaEl.textContent = `Chapter ${targetChapter + 1} of ${chapterTotal} · ${chapterPct}%`;
    _progressTooltipLastChapter = targetChapter;
    _progressTooltipWidth = 0;
    _progressTooltipHeight = 0;
  }

  if (!_progressTooltipVisible) {
    tooltip.classList.add("show");
    tooltip.setAttribute("aria-hidden", "false");
    _progressTooltipVisible = true;
  }

  if (_progressTooltipWidth <= 0 || _progressTooltipHeight <= 0) {
    _progressTooltipWidth = tooltip.offsetWidth;
    _progressTooltipHeight = tooltip.offsetHeight;
  }

  const barRect = progressBar.getBoundingClientRect();
  const desiredCenter = clientX - barRect.left;
  const minCenter = (PROGRESS_TOOLTIP_VIEWPORT_MARGIN_PX - barRect.left) + (_progressTooltipWidth / 2);
  const maxCenter = (window.innerWidth - PROGRESS_TOOLTIP_VIEWPORT_MARGIN_PX - barRect.left) - (_progressTooltipWidth / 2);
  const clampedCenter = clamp(desiredCenter, minCenter, maxCenter);
  tooltip.style.left = `${clampedCenter}px`;

  const aboveTop = barRect.top - _progressTooltipHeight - 10;
  const placement = aboveTop < PROGRESS_TOOLTIP_VIEWPORT_MARGIN_PX ? "below" : "above";
  if (placement !== _progressTooltipLastPlacement) {
    tooltip.dataset.placement = placement;
    _progressTooltipLastPlacement = placement;
  }
}

function hideProgressTooltip(immediate = false) {
  const tooltip = getProgressTooltipElement();
  if (!tooltip) return;
  if (_progressTooltipVisible || immediate) {
    tooltip.classList.remove("show");
    tooltip.setAttribute("aria-hidden", "true");
  }
  _progressTooltipVisible = false;
  _progressTooltipLastChapter = -1;
  _progressTooltipLastPlacement = "";
}

function chapterTooltipTitle(targetChapter) {
  const label = _chapterTooltipTitles[targetChapter];
  if (label) return label;
  return `Chapter ${targetChapter + 1}`;
}

function getProgressBarElement() {
  if (_progressBarEl?.isConnected) return _progressBarEl;
  _progressBarEl = document.getElementById("reader-progress");
  return _progressBarEl;
}

function getProgressTooltipElement() {
  if (_progressTooltipEl?.isConnected) return _progressTooltipEl;
  _progressTooltipEl = document.getElementById("reader-progress-tooltip");
  _progressTooltipTitleEl = _progressTooltipEl?.querySelector(".reader-progress-tooltip-title") ?? null;
  _progressTooltipMetaEl = _progressTooltipEl?.querySelector(".reader-progress-tooltip-meta") ?? null;
  return _progressTooltipEl;
}

function rebuildChapterTooltipTitles() {
  _chapterTooltipTitles = new Array(Math.max(0, chapterTotal)).fill("");
  for (const entry of toc) {
    const idx = Number(entry.chapter_idx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= _chapterTooltipTitles.length) continue;
    if (_chapterTooltipTitles[idx]) continue;
    const label = String(entry.label || "").trim();
    if (label) _chapterTooltipTitles[idx] = label;
  }
}

export function setActive(isActive) {
  const next = Boolean(isActive);
  if (_readerActive === next) return;

  _readerActive = next;
  if (_readerActive && book) {
    startReadingTimer();
    return;
  }

  void flushReadingTime().finally(() => stopReadingTimer());
}

// --- Open and restore a book ---

export async function openBook(b) {
  await flushReadingTime();
  stopReadingTimer();

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
  rebuildChapterTooltipTitles();

  renderToc();
  await ann.load(b.id);
  await loadChapter(chapterIdx, {
    scrollTarget: "restore",
    restoreScrollPct,
    restoreLocator,
  });

  if (_readerActive) startReadingTimer();
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

  clearProgressHoverFrame();
  hideProgressTooltip(true);

  _progressWheelTargetChapter = null;
  _progressWheelCarry = 0;
  if (_progressWheelTimer) {
    clearTimeout(_progressWheelTimer);
    _progressWheelTimer = null;
  }

  document.getElementById("chapter-content").innerHTML = `
    <div class="chapter-num">Chapter ${ch.index + 1} of ${chapterTotal}</div>
    <div class="chapter-title">${esc(ch.title)}</div>
    <div class="chapter-body">${ch.html}</div>`;

  attachChapterLinkHandler();

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
  updateProgressDisplay(pct, ch.index);
  document.getElementById("btn-prev").disabled = ch.index === 0;
  document.getElementById("btn-next").disabled = ch.index >= chapterTotal - 1;

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
        applyResumeLocator(readingArea, restoreForChapter);
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

function attachChapterLinkHandler() {
  const body = document.querySelector(".chapter-body");
  if (!body) return;

  body.addEventListener("click", (event) => {
    void handleChapterLinkClick(event);
  });
}

async function handleChapterLinkClick(event) {
  if (!(event.target instanceof Element) || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const link = event.target.closest("a[href]");
  if (!link || !book) return;

  const href = (link.getAttribute("href") || "").trim();
  if (!href) return;

  // Keep navigation inside the reader for EPUB-internal links.
  if (isExternalHref(href)) {
    event.preventDefault();

    if (!isAllowedExternalHref(href)) {
      toast("Blocked unsafe link");
      return;
    }

    const approved = await confirmOpenExternalLink(href);
    if (!approved) return;

    try {
      await api.openExternalUrl(href);
    } catch (err) {
      toast(`Could not open link: ${err.message}`);
    }
    return;
  }

  event.preventDefault();

  try {
    const target = await api.resolveBookLink(book.file_path, chapterIdx, href);
    if (!target) {
      toast("Link target not found");
      return;
    }

    const targetChapter = clampChapterIndex(target.chapter_idx);
    const targetAnchor = normalizeAnchorTarget(target.anchor ?? "");

    if (targetChapter === chapterIdx) {
      if (targetAnchor && scrollToAnchor(targetAnchor)) {
        scheduleProgressSave();
      }
      return;
    }

    await loadChapter(targetChapter, {
      scrollTarget: "top",
      anchorTarget: targetAnchor,
    });
  } catch (err) {
    toast(`Link navigation failed: ${err.message}`);
  }
}

function isExternalHref(href) {
  const value = String(href || "").trim().toLowerCase();
  return /^(https?:|mailto:|tel:|javascript:|data:|file:)/.test(value);
}

function isAllowedExternalHref(href) {
  const value = String(href || "").trim().toLowerCase();
  return /^(https?:|mailto:|tel:)/.test(value);
}

async function confirmOpenExternalLink(href) {
  const safeHref = String(href ?? "").trim();
  if (_skipExternalLinkConfirmForSession) return true;
  return showExternalLinkConfirm(safeHref);
}

function showExternalLinkConfirm(href) {
  return new Promise((resolve) => {
    const existing = document.getElementById("external-link-confirm");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "external-link-confirm";
    overlay.className = "external-link-confirm-backdrop";
    overlay.innerHTML = `
      <div class="external-link-confirm" role="dialog" aria-modal="true" aria-labelledby="external-link-confirm-title">
        <div class="external-link-confirm-title" id="external-link-confirm-title">Open External Link</div>
        <div class="external-link-confirm-body">Open this link in your default browser?</div>
        <input class="external-link-confirm-url" type="text" readonly value="${esc(href)}" />
        <label class="external-link-confirm-session-opt">
          <input class="external-link-confirm-session-checkbox" type="checkbox" data-role="skip-session" />
          <span class="external-link-confirm-session-text">Don't ask again for this session</span>
        </label>
        <div class="external-link-confirm-actions">
          <button class="nav-btn" type="button" data-action="open">Open</button>
          <button class="nav-btn" type="button" data-action="cancel">Cancel</button>
        </div>
      </div>`;

    const urlInput = overlay.querySelector(".external-link-confirm-url");
    const skipSessionInput = overlay.querySelector('[data-role="skip-session"]');
    const openBtn = overlay.querySelector('[data-action="open"]');

    const close = (approved) => {
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.classList.remove("open");
      setTimeout(() => {
        overlay.remove();
        resolve(approved);
      }, 120);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(false);
      }
      if (event.key === "Enter") {
        event.preventDefault();
        close(true);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        urlInput?.focus();
        urlInput?.select();
      }
    };

    overlay.addEventListener("click", (event) => {
      const action = event.target?.closest?.("[data-action]")?.getAttribute("data-action");
      if (action === "open") {
        _skipExternalLinkConfirmForSession = Boolean(skipSessionInput?.checked);
        close(true);
        return;
      }
      if (action === "cancel" || event.target === overlay) {
        close(false);
      }
    });

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("open"));
    document.addEventListener("keydown", onKeyDown, true);

    openBtn?.focus();
  });
}

function showAddNoteDialog() {
  return new Promise((resolve) => {
    const existing = document.getElementById("add-note-dialog");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "add-note-dialog";
    overlay.className = "add-note-dialog-backdrop";
    overlay.innerHTML = `
      <div class="add-note-dialog" role="dialog" aria-modal="true" aria-labelledby="add-note-dialog-title">
        <div class="add-note-dialog-title" id="add-note-dialog-title">Add a note</div>
        <textarea class="add-note-dialog-input" data-role="note-input" rows="4" maxlength="2000" placeholder="Write a note..."></textarea>
        <div class="add-note-dialog-actions">
          <button class="nav-btn" type="button" data-action="cancel">Cancel</button>
          <button class="nav-btn" type="button" data-action="save">Save</button>
        </div>
      </div>`;

    const input = overlay.querySelector('[data-role="note-input"]');
    const saveBtn = overlay.querySelector('[data-action="save"]');
    const cancelBtn = overlay.querySelector('[data-action="cancel"]');

    const autoSizeInput = () => {
      if (!input) return;
      input.style.height = "auto";
      const maxPx = Math.floor(window.innerHeight * 0.45);
      input.style.height = `${Math.min(input.scrollHeight, maxPx)}px`;
    };

    const close = (result) => {
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.classList.remove("open");
      setTimeout(() => {
        overlay.remove();
        resolve(result);
      }, 120);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(null);
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        const value = String(input?.value ?? "").trim();
        close(value || null);
      }
    };

    saveBtn?.addEventListener("click", () => {
      const value = String(input?.value ?? "").trim();
      close(value || null);
    });

    cancelBtn?.addEventListener("click", () => {
      close(null);
    });

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        close(null);
      }
    });

    input?.addEventListener("input", autoSizeInput);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("open"));
    document.addEventListener("keydown", onKeyDown, true);

    saveBtn?.focus();
    input?.focus();
    autoSizeInput();
  });
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

function flashAnnotationHit(quote) {
  const body = document.querySelector(".chapter-body");
  if (!body) return false;

  clearTimeout(_searchHighlightTimer);
  clearExistingSearchHighlight();

  const q = quote.trim();
  if (!q || q.length < 4) return false;

  const { normalizedText, map, nodeIndex, textNodes } =
    buildNormalizedTextMap(body, { stripPunct: true });

  const normalizedQuote = normalizeAnnotationString(q);
  if (!normalizedQuote || normalizedQuote.length < 4) return false;
  if (normalizedText.length < normalizedQuote.length) return false;

  // Try full normalized quote first, then progressively shorten from end.
  // Track exact matched length so end index uses what was found.
  const MIN_SEARCH_LEN = Math.max(20, Math.floor(normalizedQuote.length * 0.5));
  let matchIdx = -1;
  let matchedLen = 0;
  let searchQ = normalizedQuote;

  while (searchQ.length >= MIN_SEARCH_LEN) {
    const idx = normalizedText.indexOf(searchQ);
    if (idx >= 0) {
      matchIdx = idx;
      matchedLen = searchQ.length;
      break;
    }

    // Shorten by trimming to previous word boundary.
    const lastSpace = searchQ.trimEnd().lastIndexOf(" ");
    if (lastSpace < MIN_SEARCH_LEN) break;
    searchQ = searchQ.slice(0, lastSpace).trimEnd();
  }

  if (matchIdx < 0 || matchedLen === 0) return false;

  const startInfo = map[matchIdx];
  if (!startInfo) return false;

  // Use matchedLen (actual hit), not normalizedQuote length, to avoid overshoot.
  let endMapIdx = matchIdx + matchedLen - 1;

  // Extend to include trailing chars normalization strips, if quote ends with them.
  const originalEnd = q.trimEnd();
  while (endMapIdx + 1 < map.length) {
    const nextEntry = map[endMapIdx + 1];
    const nextRawChar = nextEntry.node.nodeValue?.[nextEntry.offset] ?? "";

    // Stop on real word characters beyond matched range.
    if (/\w/.test(nextRawChar)) break;

    // Only include stripped chars that are present at quote end.
    const quoteEndsWithIt = originalEnd.endsWith(
      (nextEntry.node.nodeValue || "").slice(
        nextEntry.offset,
        nextEntry.offset + 1
      )
    );
    if (!quoteEndsWithIt) break;

    endMapIdx++;
  }

  const endInfo = map[Math.min(endMapIdx, map.length - 1)];
  if (!endInfo) return false;

  // Validate: reconstructed text should overlap strongly with original quote
  const matchedRaw = textNodes
    .slice(nodeIndex.get(startInfo.node), nodeIndex.get(endInfo.node) + 1)
    .map((n, i, arr) => {
      const val = n.nodeValue || "";
      if (arr.length === 1) return val.slice(startInfo.offset, endInfo.offset + 1);
      if (i === 0) return val.slice(startInfo.offset);
      if (i === arr.length - 1) return val.slice(0, endInfo.offset + 1);
      return val;
    })
    .join("");

  const matchedNorm = normalizeAnnotationString(matchedRaw);
  const overlapRatio = longestCommonSubstring(matchedNorm, normalizedQuote) / normalizedQuote.length;
  if (overlapRatio < 0.75) return false;

  const spans = highlightTextRange(
    textNodes, nodeIndex,
    startInfo.node, startInfo.offset,
    endInfo.node,   endInfo.offset + 1
  );
  if (!spans.length) return false;

  spans.forEach(s =>
    s.addEventListener("animationend", () => unwrapHighlight(s), { once: true })
  );
  spans[0].scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

function flashSearchHit(query) {
  const body = document.querySelector(".chapter-body");
  if (!body) return false;

  clearTimeout(_searchHighlightTimer);
  clearExistingSearchHighlight();

  const q = query.trim();
  if (!q) return false;

  // Strategy 1: exact phrase match across the full normalized text map
  // handles matches that span multiple text nodes (e.g. across <em>, <span>)
  const { normalizedText, map, nodeIndex, textNodes } = buildNormalizedTextMap(body, { stripPunct: false });
  const normalizedQ = normalizeSearchString(q);

  if (normalizedQ.length >= 2) {
    const matchIdx = normalizedText.indexOf(normalizedQ);
    if (matchIdx >= 0) {
      const startInfo = map[matchIdx];
      const endInfo   = map[matchIdx + normalizedQ.length - 1];
      if (startInfo && endInfo) {
        const spans = highlightTextRange(
          textNodes, nodeIndex,
          startInfo.node, startInfo.offset,
          endInfo.node,   endInfo.offset + 1
        );
        if (spans.length) {
          spans.forEach(s => s.addEventListener("animationend", () => unwrapHighlight(s), { once: true }));
          spans[0].scrollIntoView({ behavior: "smooth", block: "center" });
          return true;
        }
      }
    }
  }

  // Strategy 2: single text node match on the full query only, never tokens
  const needle = q.toLocaleLowerCase();
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const tag = node.parentElement?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
      return node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  let node;
  while ((node = walker.nextNode())) {
    const lower = (node.nodeValue || "").toLocaleLowerCase();
    const idx = lower.indexOf(needle);
    if (idx < 0) continue;

    const candidate = (node.nodeValue || "").slice(idx, idx + needle.length);
    if (candidate.toLocaleLowerCase() !== needle) continue;

    const span = wrapTextInNode(node, idx, idx + needle.length);
    if (!span) continue;

    span.addEventListener("animationend", () => unwrapHighlight(span), { once: true });
    span.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }

  return false;
}

function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  let max = 0;
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > max) max = dp[i][j];
      }
    }
  }
  return max;
}

// Block-level tags that the browser renders with an implicit line break,
// meaning there is no space text node between them and adjacent content.
const BLOCK_TAGS = new Set([
  "ADDRESS","ARTICLE","ASIDE","BLOCKQUOTE","DD","DETAILS","DIALOG","DIV",
  "DL","DT","FIELDSET","FIGCAPTION","FIGURE","FOOTER","FORM","H1","H2",
  "H3","H4","H5","H6","HEADER","HGROUP","HR","LI","MAIN","NAV","OL",
  "P","PRE","SECTION","SUMMARY","TABLE","UL","BR","TR","TD","TH",
]);

function isBlockElement(node) {
  return node instanceof Element && BLOCK_TAGS.has(node.tagName);
}

// Returns true if there is at least one block-level ancestor boundary
// between node a and node b (i.e. they live in different block boxes).
function crossesBlockBoundary(a, b) {
  if (!a || !b) return false;
  let cur = b.parentNode;
  while (cur) {
    if (isBlockElement(cur)) {
      return !cur.contains(a);
    }
    cur = cur.parentNode;
  }
  return false;
}

function buildNormalizedTextMap(root, { stripPunct = false } = {}) {
  const textNodes = [];
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const txt = node.nodeValue || "";
        const parentTag = node.parentElement?.tagName;
        if (parentTag === "SCRIPT" || parentTag === "STYLE") return NodeFilter.FILTER_REJECT;
        return txt.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    }
  );

  let node;
  while ((node = walker.nextNode())) {
    textNodes.push(node);
  }

  const nodeIndex = new Map();
  textNodes.forEach((n, idx) => nodeIndex.set(n, idx));

  let normalizedText = "";
  const map = [];
  let prevSpace = false;
  let prevTextNode = null;

  for (const textNode of textNodes) {
    // Inject a space when crossing a block boundary so that
    // "HeadingText" and "Paragraph text" are separated in normalizedText,
    // matching what a real browser selection string contains.
    if (prevTextNode && crossesBlockBoundary(prevTextNode, textNode)) {
      if (!prevSpace && normalizedText.length > 0) {
        normalizedText += " ";
        // Use the first char of this textNode as the sentinel map entry
        // so the space resolves to a real position in the DOM.
        map.push({ node: textNode, offset: 0, synthetic: true });
        prevSpace = true;
      }
    }
    prevTextNode = textNode;

    const text = textNode.nodeValue || "";
    for (let i = 0; i < text.length; i++) {
      let ch = normalizeMatchChar(text[i], { stripPunct });
      if (ch === "") continue;

      if (ch === " ") {
        if (!normalizedText.length || prevSpace) {
          prevSpace = true;
          continue;
        }
        prevSpace = true;
      } else {
        prevSpace = false;
      }

      normalizedText += ch;
      map.push({ node: textNode, offset: i });
    }
  }

  while (normalizedText.endsWith(" ")) {
    normalizedText = normalizedText.slice(0, -1);
    map.pop();
  }

  return { normalizedText, map, nodeIndex, textNodes };
}

function normalizeSearchString(text) {
  return normalizeTextForMatch(text, { stripPunct: false });
}

function normalizeAnnotationString(text) {
  return normalizeTextForMatch(text, { stripPunct: true });
}

function normalizeTextForMatch(text, { stripPunct = false } = {}) {
  const raw = String(text || "");
  let normalized = "";
  let prevSpace = false;

  for (let i = 0; i < raw.length; i++) {
    let ch = normalizeMatchChar(raw[i], { stripPunct });
    if (ch === "") continue;

    if (ch === " ") {
      if (!normalized.length || prevSpace) {
        prevSpace = true;
        continue;
      }
      prevSpace = true;
    } else {
      prevSpace = false;
    }

    normalized += ch;
  }

  return normalized.trim();
}

function normalizeMatchChar(ch, { stripPunct = false } = {}) {
  let out = ch;
  if (out === "\u00A0") out = " ";
  if (out === "\u00AD" || out === "\u200B" || out === "\uFEFF") return "";
  if (out === "\u201C" || out === "\u201D") out = '"';
  if (out === "\u2018" || out === "\u2019") out = "'";
  if (out === "\u2013" || out === "\u2014" || out === "\u2212") out = "-";
  if (/\s/.test(out)) out = " ";
  if (stripPunct && /[\p{P}\p{S}]/u.test(out)) out = " ";
  return out;
}

function highlightTextRange(textNodes, nodeIndex, startNode, startOffset, endNode, endOffset) {
  const startIdx = nodeIndex.get(startNode);
  const endIdx = nodeIndex.get(endNode);
  if (!Number.isInteger(startIdx) || !Number.isInteger(endIdx)) return [];

  const from = Math.min(startIdx, endIdx);
  const to = Math.max(startIdx, endIdx);
  const spans = [];

  for (let i = from; i <= to; i++) {
    const node = textNodes[i];
    if (!node?.nodeValue) continue;

    let nodeStart = 0;
    let nodeEnd = node.nodeValue.length;

    if (node === startNode) nodeStart = startOffset;
    if (node === endNode) nodeEnd = endOffset;

    if (nodeStart >= nodeEnd) continue;
    const span = wrapTextInNode(node, nodeStart, nodeEnd);
    if (span) spans.push(span);
  }

  return spans;
}

function buildHighlightNeedles(query) {
  const q = (query || "").trim().toLocaleLowerCase();
  return q ? [q] : [];
}

function wrapTextInNode(textNode, start, end) {
  const txt = textNode.nodeValue || "";
  if (start < 0 || end <= start || end > txt.length) return null;

  const after = textNode.splitText(end);
  const middle = textNode.splitText(start);
  const span = document.createElement("span");
  span.className = "search-hit-flash";
  middle.parentNode?.insertBefore(span, middle);
  span.appendChild(middle);
  after.parentNode?.normalize();
  return span;
}

function clearExistingSearchHighlight() {
  document.querySelectorAll(".search-hit-flash").forEach((el) => unwrapHighlight(el));
}

function unwrapHighlight(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
  parent.normalize();
}

async function convertLocalImageUrls() {
  const images = [...document.querySelectorAll(".chapter-body img")];
  if (!images.length) return;

  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");

    images.forEach((img) => {
      const raw = img.getAttribute("src") || "";
      if (!raw.startsWith("file://")) return;

      try {
        const parsed = new URL(raw);
        let filePath = decodeURIComponent(parsed.pathname);
        // Normalize Windows paths so convertFileSrc receives a valid local path.
        if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1);
        img.setAttribute("src", convertFileSrc(filePath));
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

// --- TOC ---

function renderToc() {
  const el = document.getElementById("toc-items");
  if (!toc.length) {
    el.innerHTML = `<div style="padding:12px 14px;font-size:12px;color:var(--t2)">No table of contents</div>`;
    return;
  }

  const tree = buildTocTree(toc);
  const activePath = new Set();
  markActivePath(tree, activePath);

  // Keep the active chapter visible when users collapse sibling groups.
  expandToActivePath(tree, activePath);

  el.innerHTML = renderTocNodes(tree, 0, activePath);

  el.onclick = (evt) => {
    const target = evt.target;
    if (!(target instanceof Element)) return;

    const toggleBtn = target.closest(".toc-group-toggle");
    if (toggleBtn) {
      const groupId = toggleBtn.getAttribute("data-group-id");
      if (!groupId) return;

      if (tocCollapsedGroups.has(groupId)) {
        tocCollapsedGroups.delete(groupId);
      } else {
        tocCollapsedGroups.add(groupId);
      }
      renderToc();
      return;
    }

    // Resolve chapter from nested clicks within grouped TOC rows.
    let chapter = null;
    let walkEl = target;
    while (walkEl && walkEl !== el) {
      const ch = walkEl.getAttribute?.("data-chapter");
      if (ch !== null && ch !== undefined) {
        chapter = Number(ch);
        if (Number.isFinite(chapter)) break;
      }
      walkEl = walkEl.parentElement;
    }

    if (!Number.isFinite(chapter)) return;

    loadChapter(chapter);
  };
}

function buildTocTree(entries) {
  const root = [];
  const stack = [];
  let seq = 0;

  for (const entry of entries) {
    const depth = Math.max(0, Number(entry.depth) || 0);
    const node = {
      label: entry.label,
      chapter_idx: entry.chapter_idx,
      depth,
      groupId: `g-${entry.chapter_idx}-${seq++}`,
      children: [],
    };

    while (stack.length && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }

    if (!stack.length) {
      root.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }

  return root;
}

function markActivePath(nodes, activePath) {
  let found = false;

  for (const node of nodes) {
    const inSubtree = node.chapter_idx === chapterIdx || markActivePath(node.children, activePath);
    if (inSubtree) {
      activePath.add(node.groupId);
      found = true;
    }
  }

  return found;
}

function expandToActivePath(nodes, activePath) {
  for (const node of nodes) {
    if (node.children.length > 0) {
      const hasActive = markActivePath([node], new Set());
      if (hasActive && activePath.has(node.groupId)) {
        tocCollapsedGroups.delete(node.groupId);
      }
      expandToActivePath(node.children, activePath);
    }
  }
}

function renderTocNodes(nodes, level, activePath) {
  return nodes.map((node) => {
    const hasChildren = node.children.length > 0;
    const active = node.chapter_idx === chapterIdx;
    const shouldCollapse = hasChildren
      ? tocCollapsedGroups.has(node.groupId) && !activePath.has(node.groupId)
      : false;

    const item = `<div class="toc-item${active ? " active" : ""}" data-depth="${level}" data-chapter="${node.chapter_idx}">${esc(node.label)}</div>`;

    if (!hasChildren) return item;

    return `<div class="toc-group${shouldCollapse ? " collapsed" : ""}" data-depth="${level}">
      <div class="toc-group-header" data-depth="${level}">
        <button class="toc-group-toggle" data-group-id="${node.groupId}" aria-label="Toggle section" title="Toggle section">
          <span class="toc-group-chevron" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="2.5,4.5 6,8 9.5,4.5"></polyline>
            </svg>
          </span>
        </button>
        ${item}
      </div>
      <div class="toc-group-children">
        ${renderTocNodes(node.children, level + 1, activePath)}
      </div>
    </div>`;
  }).join("");
}

function toggleToc() {
  tocOpen = !tocOpen;
  document.getElementById("toc-panel").classList.toggle("collapsed", !tocOpen);
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
  await flushReadingTime();
}

function startReadingTimer() {
  stopReadingTimer();
  _lastReadingTickAt = Date.now();
  _readingTimeTimer = setInterval(() => {
    void captureReadingTimeTick(false);
  }, READING_TIME_TICK_MS);
}

function stopReadingTimer() {
  if (_readingTimeTimer) {
    clearInterval(_readingTimeTimer);
    _readingTimeTimer = null;
  }
  _lastReadingTickAt = 0;
}

async function captureReadingTimeTick(force) {
  if (!book) return;

  const now = Date.now();
  if (!_lastReadingTickAt) {
    _lastReadingTickAt = now;
    return;
  }

  let deltaSec = Math.floor((now - _lastReadingTickAt) / 1000);
  _lastReadingTickAt = now;
  if (deltaSec <= 0) return;

  deltaSec = Math.min(deltaSec, MAX_READING_TIME_STEP_SEC);

  if (!force) {
    if (!_readerActive || document.visibilityState !== "visible") return;
  }

  _pendingReadingSeconds += deltaSec;
  const shouldFlush = force || _pendingReadingSeconds >= 15;
  if (!shouldFlush) return;

  const secondsToSave = _pendingReadingSeconds;
  _pendingReadingSeconds = 0;

  const bookId = book.id;
  _readingTimeQueue = _readingTimeQueue
    .catch(() => {})
    .then(async () => {
      try {
        await api.addReadingTime(bookId, secondsToSave);
        if (book && book.id === bookId) {
          book.reading_seconds = (Number(book.reading_seconds) || 0) + secondsToSave;
        }
      } catch {
        if (book && book.id === bookId) {
          _pendingReadingSeconds += secondsToSave;
        }
      }
    });
}

async function flushReadingTime() {
  await captureReadingTimeTick(true);
  await _readingTimeQueue;
}

// --- Selection tooltip ---

function initSelectionTooltip() {
  const tooltip = document.getElementById("sel-tooltip");
  const area    = document.getElementById("reading-area");

  area.addEventListener("mouseup", (e) => {
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 4) {
      const maxLeft = Math.max(4, window.innerWidth - 180);
      tooltip.style.top  = Math.max(0, e.clientY - 48) + "px";
      tooltip.style.left = clamp(e.clientX - 70, 4, maxLeft) + "px";
      tooltip.classList.add("show");
    } else {
      hideTooltip();
    }
  });

  document.getElementById("sel-cancel").addEventListener("click", hideTooltip);
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#sel-tooltip")) hideTooltip();
  });

  document.getElementById("sel-highlight").addEventListener("click", () =>
    saveSelection(null)
  );
  document.getElementById("sel-note").addEventListener("click", async () => {
    const selectedQuote = window.getSelection()?.toString().trim() || "";
    const note = await showAddNoteDialog();
    await saveSelection(note, selectedQuote);
  });
}

// --- Image viewer ---

function initImageViewer() {
  const content = document.getElementById("content");
  if (!content) return;

  _imageViewerBackdrop = document.createElement("div");
  _imageViewerBackdrop.className = "image-viewer-backdrop";
  _imageViewerBackdrop.setAttribute("aria-hidden", "true");

  _imageViewerPanel = document.createElement("aside");
  _imageViewerPanel.className = "image-viewer-panel";
  _imageViewerPanel.setAttribute("aria-hidden", "true");
  _imageViewerPanel.innerHTML = `
    <div class="image-viewer-stage">
      <img class="image-viewer-img" alt="" />
      <div class="image-viewer-caption" aria-hidden="true"></div>
    </div>
  `;

  content.appendChild(_imageViewerBackdrop);
  content.appendChild(_imageViewerPanel);

  _imageViewerMenu = document.createElement("div");
  _imageViewerMenu.className = "image-viewer-menu";
  _imageViewerMenu.setAttribute("role", "menu");
  _imageViewerMenu.setAttribute("aria-hidden", "true");
  _imageViewerMenu.innerHTML = `
    <div class="image-viewer-menu-title">Image</div>
    <button class="image-viewer-menu-item" type="button" data-action="copy" role="menuitem">Copy image</button>
    <button class="image-viewer-menu-item" type="button" data-action="export" role="menuitem">Export image...</button>
  `;
  content.appendChild(_imageViewerMenu);

  _imageViewerImg = _imageViewerPanel.querySelector(".image-viewer-img");
  _imageViewerCaption = _imageViewerPanel.querySelector(".image-viewer-caption");

  _imageViewerBackdrop.addEventListener("click", closeImageViewer);
  _imageViewerPanel.addEventListener("click", (event) => {
    if (event.target === _imageViewerPanel) closeImageViewer();
  });
  _imageViewerImg?.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setImageMenuSource(_imageViewerImg);
    openImageViewerMenu(event.clientX, event.clientY);
  });
  const readingArea = document.getElementById("reading-area");
  readingArea?.addEventListener("contextmenu", (event) => {
    if (!(event.target instanceof Element)) return;
    const img = event.target.closest("img");
    if (!img || !img.closest(".chapter-body")) return;
    event.preventDefault();
    event.stopPropagation();
    setImageMenuSource(img);
    openImageViewerMenu(event.clientX, event.clientY);
  });
  _imageViewerMenu.addEventListener("click", (event) => {
    const action = event.target?.closest?.("[data-action]")?.getAttribute("data-action");
    if (action === "copy") {
      void copyImageFromViewer();
    } else if (action === "export") {
      void exportImageFromViewer();
    }
  });
  document.addEventListener("click", (event) => {
    if (_imageViewerMenuOpen && !_imageViewerMenu.contains(event.target)) {
      closeImageViewerMenu();
    }
  });
  document.addEventListener("scroll", () => {
    if (_imageViewerMenuOpen) closeImageViewerMenu();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && _imageViewerPanel?.classList.contains("open")) {
      event.preventDefault();
      closeImageViewerMenu();
      closeImageViewer();
    }
    if (event.key === "Escape") closeImageViewerMenu();
  });
}

function openImageViewerMenu(x, y) {
  if (!_imageViewerMenu || !_imageViewerMenuSrc) return;

  _imageViewerMenuOpen = true;
  _imageViewerMenu.classList.add("open");
  _imageViewerMenu.setAttribute("aria-hidden", "false");
  _imageViewerMenu.style.visibility = "hidden";
  _imageViewerMenu.style.left = "0px";
  _imageViewerMenu.style.top = "0px";

  requestAnimationFrame(() => {
    if (!_imageViewerMenu) return;
    const rect = _imageViewerMenu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    const left = clamp(x, 8, Math.max(8, maxX));
    const top = clamp(y, 8, Math.max(8, maxY));
    _imageViewerMenu.style.left = `${left}px`;
    _imageViewerMenu.style.top = `${top}px`;
    _imageViewerMenu.style.visibility = "";
  });
}

function setImageMenuSource(img) {
  if (!img) return;
  const src = img.getAttribute("src") || "";
  if (!src) return;
  _imageViewerMenuSrc = src;
  _imageViewerMenuAlt = String(img.getAttribute("alt") || "").trim();
}

function closeImageViewerMenu() {
  if (!_imageViewerMenuOpen || !_imageViewerMenu) return;
  _imageViewerMenuOpen = false;
  _imageViewerMenu.classList.remove("open");
  _imageViewerMenu.setAttribute("aria-hidden", "true");
  _imageViewerMenu.style.left = "-9999px";
  _imageViewerMenu.style.top = "-9999px";
}

async function copyImageFromViewer() {
  if (!_imageViewerMenuSrc) return;
  closeImageViewerMenu();

  try {
    const blob = await fetchImageBlob(_imageViewerMenuSrc);
    if (!blob) throw new Error("Image not available");

    try {
      const { writeImage } = await import("@tauri-apps/plugin-clipboard-manager");
      const { Image } = await import("@tauri-apps/api/image");
      if (writeImage) {
        const pngBytes = await rasterizeImageToPngBytes(blob);
        const tauriImage = await Image.fromBytes(pngBytes);
        await writeImage(tauriImage);
        toast("Image copied to clipboard");
        return;
      }
    } catch {
      // Fall back to web clipboard below.
    }

    if (navigator.clipboard?.write && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      toast("Image copied to clipboard");
      return;
    }

    const dataUrl = await blobToDataUrl(blob);
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(dataUrl);
      toast("Copied image data URL");
      return;
    }

    throw new Error("Clipboard image copy not supported");
  } catch (err) {
    toast(`Copy failed: ${err.message}`);
  }
}

async function exportImageFromViewer() {
  if (!_imageViewerMenuSrc) return;
  closeImageViewerMenu();

  try {
    const blob = await fetchImageBlob(_imageViewerMenuSrc);
    if (!blob) throw new Error("Image not available");

    const ext = (blob.type.split("/")[1] || "png").replace(/[^a-z0-9]+/gi, "");
    const base = (_imageViewerMenuAlt || "image").replace(/[^a-z0-9._-]+/gi, "_");
    const defaultName = `${base || "image"}.${ext || "png"}`;

    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: "Image", extensions: [ext || "png"] }],
    });
    if (!path) return;

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { writeFile } = await import("@tauri-apps/plugin-fs");

    try {
      await writeFile(path, bytes);
    } catch {
      await writeFile({ path, contents: bytes });
    }

    toast("Image exported");
  } catch (err) {
    toast(`Export failed: ${err.message}`);
  }
}

async function fetchImageBlob(src) {
  const res = await fetch(src);
  if (!res.ok) throw new Error("Image fetch failed");
  return await res.blob();
}

async function rasterizeImageToPngBytes(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not available");
  ctx.drawImage(bitmap, 0, 0);

  const pngBlob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png")
  );
  if (!pngBlob) throw new Error("PNG conversion failed");
  return new Uint8Array(await pngBlob.arrayBuffer());
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.readAsDataURL(blob);
  });
}

function openImageViewer(img) {
  if (!_imageViewerBackdrop || !_imageViewerPanel || !_imageViewerImg) return;

  if (_imageViewerCloseTimer) {
    clearTimeout(_imageViewerCloseTimer);
    _imageViewerCloseTimer = null;
  }

  const src = img.getAttribute("src") || "";
  if (!src) return;

  _imageViewerImg.src = src;
  const altText = String(img.getAttribute("alt") || "").trim();
  _imageViewerImg.alt = altText || "Image preview";
  setImageMenuSource(_imageViewerImg);
  if (_imageViewerCaption) {
    _imageViewerCaption.textContent = altText;
    _imageViewerCaption.setAttribute("aria-hidden", altText ? "false" : "true");
  }

  _imageViewerBackdrop.classList.add("open");
  _imageViewerPanel.classList.add("open");
  _imageViewerBackdrop.setAttribute("aria-hidden", "false");
  _imageViewerPanel.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeImageViewer() {
  if (!_imageViewerBackdrop || !_imageViewerPanel || !_imageViewerImg) return;

  if (_imageViewerCloseTimer) return;

  _imageViewerBackdrop.classList.remove("open");
  _imageViewerPanel.classList.remove("open");
  closeImageViewerMenu();

  _imageViewerCloseTimer = setTimeout(() => {
    _imageViewerCloseTimer = null;
    _imageViewerBackdrop.setAttribute("aria-hidden", "true");
    _imageViewerPanel.setAttribute("aria-hidden", "true");
    _imageViewerImg.src = "";
    _imageViewerMenuSrc = "";
    _imageViewerMenuAlt = "";
    if (_imageViewerCaption) {
      _imageViewerCaption.textContent = "";
      _imageViewerCaption.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "";
  }, 140);
}

async function saveSelection(note, quoteOverride = "") {
  const sel = window.getSelection();
  const quote = quoteOverride || sel?.toString().trim();
  hideTooltip();
  if (!quote) return;

  const saved = await ann.add({ chapterIdx, quote, note });
  if (saved) ann.open();
}

function hideTooltip() {
  document.getElementById("sel-tooltip")?.classList.remove("show");
  window.getSelection?.()?.removeAllRanges();
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

function buildResumeLocator(readingArea, chapter, scrollPct) {
  const body = document.querySelector(".chapter-body");
  if (!body) return null;

  const maxScrollTop = Math.max(0, readingArea.scrollHeight - readingArea.clientHeight);
  const currentScroll = readingArea.scrollTop;

  // Anchor near the top of the viewport for a stable resume target.
  const areaRect = readingArea.getBoundingClientRect();
  const targetY = areaRect.top + Math.max(16, areaRect.height * 0.2);
  let el = document.elementFromPoint(areaRect.left + areaRect.width / 2, targetY);

  // Fallback to the first visible readable node when hit-testing fails.
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
    textHint: (target.textContent || "").trim().slice(0, 120),
    offsetPx: Math.round(scrollOffsetFromElement),
    savedAt: Date.now(),
  };
}

function applyResumeLocator(readingArea, locator) {
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
    if (Math.abs(wanted - pxFallback) < 200 || !Number.isFinite(pxFallback)) {
      readingArea.scrollTop = wanted;
      _lastScrollTop = readingArea.scrollTop;
      return true;
    }
  }

  if (Number.isFinite(pxFallback)) {
    readingArea.scrollTop = pxFallback;
    _lastScrollTop = readingArea.scrollTop;
    return true;
  }

  return false;
}


function computePixelResumeTarget(locator, maxScrollTop) {
  const rawTop = Number(locator.scrollTopPx);
  if (!Number.isFinite(rawTop)) return null;

  const savedScrollable = Number(locator.scrollablePx);
  if (Number.isFinite(savedScrollable) && savedScrollable > 0) {
    // Scale absolute position to the current viewport height.
    return clamp((rawTop / savedScrollable) * maxScrollTop, 0, maxScrollTop);
  }

  return clamp(rawTop, 0, maxScrollTop);
}

function nearestLocatorElement(el, root) {
  let cur = el;
  while (cur && cur !== root) {
    if (cur.parentElement === root) return cur;
    cur = cur.parentElement;
  }
  return root.firstElementChild || null;
}

function buildElementPath(el, root) {
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

function resolveElementPath(root, path) {
  if (!Array.isArray(path) || !path.length) return null;

  let cur = root;
  for (const idx of path) {
    if (!cur?.children?.length) return null;
    if (!Number.isInteger(idx) || idx < 0 || idx >= cur.children.length) return null;
    cur = cur.children[idx];
  }
  return cur instanceof Element ? cur : null;
}

function readResumeLocator(bookId) {
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

function writeResumeLocator(bookId, locator) {
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
      textHint: typeof locator.textHint === "string" ? locator.textHint.slice(0, 160) : "",
      offsetPx: Math.trunc(Number(locator.offsetPx) || 0),
      savedAt: Number(locator.savedAt) || Date.now(),
    };

    localStorage.setItem(RESUME_LOCATOR_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Local storage can fail in constrained environments; continue silently.
  }
}
