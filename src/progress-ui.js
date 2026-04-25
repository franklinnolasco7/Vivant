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

const PROGRESS_WHEEL_STEP_THRESHOLD = 110;
const PROGRESS_TOOLTIP_VIEWPORT_MARGIN_PX = 8;
const PROGRESS_SAVE_DEBOUNCE_MS = 120;

let ctx = null;

export function init(context) {
  ctx = context;

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
}

export function rebuildChapterTooltipTitles() {
  const chapterTotal = ctx.getChapterTotal();
  const toc = ctx.getToc();
  _chapterTooltipTitles = new Array(Math.max(0, chapterTotal)).fill("");
  for (const entry of toc) {
    const idx = Number(entry.chapter_idx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= _chapterTooltipTitles.length) continue;
    if (_chapterTooltipTitles[idx]) continue;
    const label = String(entry.label || "").trim();
    if (label) _chapterTooltipTitles[idx] = label;
  }
}

export function updateDisplay(progressPct, chapterForLabel) {
  const chapterTotal = ctx.getChapterTotal();
  const safeChapter = ctx.clampChapterIndex(chapterForLabel);
  document.getElementById("reader-progress-fill").style.width = `${clamp(progressPct, 0, 100)}%`;
  document.getElementById("pos-label").textContent = `${safeChapter + 1}/${chapterTotal} · ${Math.round(progressPct)}%`;
}

export function clearHoverFrame() {
  if (!_progressHoverRaf) return;
  cancelAnimationFrame(_progressHoverRaf);
  _progressHoverRaf = 0;
}

export function hideTooltip(immediate = false) {
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

export function clearWheelTarget() {
  _progressWheelTargetChapter = null;
  _progressWheelCarry = 0;
  if (_progressWheelTimer) {
    clearTimeout(_progressWheelTimer);
    _progressWheelTimer = null;
  }
}

function onProgressPointerDown(event) {
  if (!ctx.getBook() || event.button !== 0) return;

  const progressBar = getProgressBarElement();
  if (!progressBar) return;

  clearHoverFrame();
  hideTooltip(true);

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
  const chapterIdx = ctx.getChapterIdx();
  updateDisplay(ctx.chapterProgressPct(chapterIdx), chapterIdx);
}

function onProgressHoverMove(event) {
  if (!ctx.getBook() || _progressDrag) return;

  _progressHoverClientX = event.clientX;
  if (_progressHoverRaf) return;
  _progressHoverRaf = requestAnimationFrame(() => {
    _progressHoverRaf = 0;
    showTooltip(_progressHoverClientX);
  });
}

function onProgressHoverLeave() {
  clearHoverFrame();
  hideTooltip();
}

function onProgressWheel(event) {
  const chapterTotal = ctx.getChapterTotal();
  if (!ctx.getBook() || chapterTotal <= 1) return;

  event.preventDefault();
  clearHoverFrame();
  hideTooltip();

  // Clamp to one chapter step per debounce window.
  if (Number.isFinite(_progressWheelTargetChapter)) {
    return;
  }

  const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 18
    : (event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 120 : 1);
  _progressWheelCarry += event.deltaY * deltaScale;

  const stepCount = Math.trunc(_progressWheelCarry / PROGRESS_WHEEL_STEP_THRESHOLD);
  // Require minimum threshold to prevent tiny scroll amounts from flipping chapters
  if (stepCount === 0) return;

  _progressWheelCarry -= stepCount * PROGRESS_WHEEL_STEP_THRESHOLD;

  const chapterIdx = ctx.getChapterIdx();
  const baseChapter = Number.isFinite(_progressWheelTargetChapter)
    ? _progressWheelTargetChapter
    : chapterIdx;
  const targetChapter = ctx.clampChapterIndex(baseChapter + stepCount);
  if (targetChapter === baseChapter) return;

  _progressWheelTargetChapter = targetChapter;
  updateDisplay(ctx.chapterProgressPct(targetChapter), targetChapter);

  clearTimeout(_progressWheelTimer);
  _progressWheelTimer = setTimeout(() => {
    const pendingTarget = _progressWheelTargetChapter;
    _progressWheelTargetChapter = null;
    _progressWheelTimer = null;

    if (!Number.isFinite(pendingTarget) || pendingTarget === chapterIdx) {
      updateDisplay(ctx.chapterProgressPct(chapterIdx), chapterIdx);
      return;
    }

    void ctx.loadChapter(pendingTarget, { scrollTarget: "top" });
  }, PROGRESS_SAVE_DEBOUNCE_MS);
}

function progressPctFromClientX(progressBar, clientX) {
  const rect = progressBar.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  const x = clientX - rect.left;
  return clamp(x / rect.width, 0, 1);
}

function chapterIndexFromProgressPct(pct) {
  const chapterTotal = ctx.getChapterTotal();
  if (chapterTotal <= 1) return ctx.getChapterIdx();
  const normalized = clamp(pct, 0, 1);
  return ctx.clampChapterIndex(Math.floor(normalized * (chapterTotal - 1)));
}

function applyProgressPreview(pct) {
  if (!ctx.getBook()) return;

  const targetChapter = chapterIndexFromProgressPct(pct);
  const progressPct = ctx.chapterProgressPct(targetChapter);
  updateDisplay(progressPct, targetChapter);
}

function seekToProgressPct(pct) {
  if (!ctx.getBook()) return;

  const normalized = clamp(pct, 0, 1);
  const targetChapter = chapterIndexFromProgressPct(normalized);
  const chapterIdx = ctx.getChapterIdx();

  if (targetChapter !== chapterIdx) {
    void ctx.loadChapter(targetChapter, { scrollTarget: "top" });
    return;
  }

  // Scroll within chapter to avoid expensive chapter reload for same-chapter jumps.
  const readingArea = document.getElementById("reading-area");
  if (!readingArea) return;

  readingArea.scrollTop = normalized * Math.max(0, readingArea.scrollHeight - readingArea.clientHeight);
  ctx.scheduleProgressSave();
  updateDisplay(ctx.chapterProgressPct(chapterIdx), chapterIdx);
}

function showTooltip(clientX) {
  const chapterTotal = ctx.getChapterTotal();
  if (!ctx.getBook() || _progressDrag) return;

  const progressBar = getProgressBarElement();
  const tooltip = getProgressTooltipElement();
  if (!progressBar || !tooltip || !_progressTooltipTitleEl || !_progressTooltipMetaEl) return;

  const pct = progressPctFromClientX(progressBar, clientX);
  const targetChapter = chapterIndexFromProgressPct(pct);
  if (targetChapter !== _progressTooltipLastChapter) {
    const chapterPct = ctx.chapterProgressPct(targetChapter);
    _progressTooltipTitleEl.textContent = chapterTooltipTitle(targetChapter);
    _progressTooltipMetaEl.textContent = `${targetChapter + 1} of ${chapterTotal} · ${chapterPct}%`;
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

function chapterTooltipTitle(targetChapter) {
  const label = _chapterTooltipTitles[targetChapter];
  if (label) return label;
  return `Section ${targetChapter + 1}`;
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

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}
