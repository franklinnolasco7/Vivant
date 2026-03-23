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

const AUTO_PAGE_THRESHOLD_PX = 56;
const AUTO_PAGE_COOLDOWN_MS = 420;
const AUTO_PAGE_WHEEL_INTENT_MS = 450;
const PROGRESS_SAVE_DEBOUNCE_MS = 500;
const RESUME_LOCATOR_STORAGE_KEY = "vellum.resume-locators.v1";
const EDGE_PAGE_INTENT_WINDOW_MS = 1800;
const EDGE_PAGE_INTENT_MIN_GAP_MS = 320;
const READING_TIME_TICK_MS = 15000;
const MAX_READING_TIME_STEP_SEC = 120;

// --- Initialize reader interactions ---

export function init() {
  document.getElementById("btn-toc").addEventListener("click", toggleToc);
  document.getElementById("btn-ann").addEventListener("click", ann.toggle);

  document.getElementById("btn-prev").addEventListener("click", prevChapter);
  document.getElementById("btn-next").addEventListener("click", nextChapter);

  // Allow clicking progress bar for instant navigation rather than sequential scrolling
  document.getElementById("reader-progress").addEventListener("click", (e) => {
    if (!book || chapterTotal <= 1) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, clickX / rect.width));
    const targetChapter = Math.floor(pct * (chapterTotal - 1));
    if (targetChapter !== chapterIdx) {
      loadChapter(targetChapter, { scrollTarget: "top" });
    } else {
      // Scroll within chapter to avoid expensive chapter reload for same-chapter jumps
      const readingArea = document.getElementById("reading-area");
      readingArea.scrollTop = pct * (readingArea.scrollHeight - readingArea.clientHeight);
    }
  });

  // Debounce writes so frequent scroll events do not flood persistence.
  const readingArea = document.getElementById("reading-area");
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

  document.getElementById("chapter-content").innerHTML =
    `<div class="empty-state"><div class="empty-state-sub">Loading…</div></div>`;

  try {
    const ch = await api.getChapter(book.file_path, idx);
    renderChapter(ch, scrollTarget, restoreScrollPct, restoreLocator, highlightQuery);
  } catch (err) {
    document.getElementById("chapter-content").innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">Could not load chapter</div>
        <div class="empty-state-sub">${esc(err.message)}</div>
      </div>`;
  }
}

function renderChapter(ch, scrollTarget = "top", restoreScrollPct = 0, restoreLocator = null, highlightQuery = "") {
  const pct = chapterTotal <= 1
    ? 10
    : Math.round((ch.index / (chapterTotal - 1)) * 100);

  document.getElementById("chapter-content").innerHTML = `
    <div class="chapter-num">Chapter ${ch.index + 1} of ${chapterTotal}</div>
    <div class="chapter-title">${esc(ch.title)}</div>
    <div class="chapter-body">${ch.html}</div>`;

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
  document.getElementById("reader-progress-fill").style.width = pct + "%";
  document.getElementById("pos-label").textContent =
    `${ch.index + 1}/${chapterTotal} · ${pct}%`;
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

  if (highlightQuery) {
    requestAnimationFrame(() => {
      if (flashSearchHit(highlightQuery)) {
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(persistProgress, PROGRESS_SAVE_DEBOUNCE_MS);
      }
    });
  }
}

function flashSearchHit(query) {
  const body = document.querySelector(".chapter-body");
  if (!body) return false;

  clearTimeout(_searchHighlightTimer);
  clearExistingSearchHighlight();

  const needles = buildHighlightNeedles(query);
  if (!needles.length) return false;

  const walker = document.createTreeWalker(
    body,
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
    const text = node.nodeValue || "";
    const lower = text.toLocaleLowerCase();

    for (const needle of needles) {
      const idx = lower.indexOf(needle);
      if (idx < 0) continue;

      const span = wrapTextInNode(node, idx, idx + needle.length);
      if (!span) continue;

      span.addEventListener("animationend", () => unwrapHighlight(span), { once: true });
      span.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    }
  }

  return false;
}

function buildHighlightNeedles(query) {
  const q = (query || "").trim().toLocaleLowerCase();
  if (!q) return [];

  const needles = [q];
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length);

  for (const tok of tokens) {
    if (!needles.includes(tok)) needles.push(tok);
  }
  return needles;
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
          <span class="toc-group-chevron">▾</span>
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
      const rect = area.getBoundingClientRect();
      tooltip.style.top  = Math.max(0, e.clientY - rect.top - 48) + "px";
      tooltip.style.left = clamp(e.clientX - rect.left - 70, 4, rect.width - 180) + "px";
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
  document.getElementById("sel-note").addEventListener("click", () => {
    const note = prompt("Add a note (optional):");
    saveSelection(note ?? null);
  });
}

async function saveSelection(note) {
  const sel = window.getSelection();
  const quote = sel?.toString().trim();
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
