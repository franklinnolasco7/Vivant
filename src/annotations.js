/**
 * annotations.js — annotations panel: render, add, delete, detail view.
 */
import * as api from "./api.js";
import { esc, emptyState, toast } from "./ui.js";

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {import('./api.js').Annotation[]} */
let annotations = [];

/** onJumpToChapter callback triggered when user clicks an annotation **/
let onJumpToChapter = (_idx) => {};

let _currentBookId = null;
let _toc = [];

export function setToc(toc) {
  _toc = Array.isArray(toc) ? toc : [];
}

let _detailBackdrop = null;
let _detailPanel = null;
let _currentDetailAnnotation = null;
let _dragging = false;
let _draggedItem = null;
let _draggedGroup = null;
let _dragOverItem = null;
let _dragResetTimer = null;

function buildAnnotationHighlightQuery(quote) {
  const cleaned = String(quote || "")
    .replace(/[“”‘’"']/g, "")
    .replace(/\.\.\.|…/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";

  const words = cleaned.split(" ");
  if (words.length <= 8) return cleaned;

  let longestIdx = 0;
  let longestLen = 0;
  for (let i = 0; i < words.length; i++) {
    const len = words[i].length;
    if (len > longestLen) {
      longestLen = len;
      longestIdx = i;
    }
  }

  const windowSize = 6;
  let start = Math.max(0, longestIdx - Math.floor(windowSize / 2));
  let end = Math.min(words.length, start + windowSize);
  if (end - start < windowSize) {
    start = Math.max(0, end - windowSize);
  }

  return words.slice(start, end).join(" ");
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function init({ onJump }) {
  onJumpToChapter = onJump;

  document.getElementById("ann-list").addEventListener("click", (e) => {
    if (_dragging) return;
    const item   = e.target.closest(".ann-item");
    const delBtn = e.target.closest(".ann-delete");
    if (delBtn) {
      e.stopPropagation();
      deleteAnnotation(delBtn.dataset.id);
      return;
    }
    if (item) {
      const annId = item.dataset.id;
      openDetailPanel(annId);
    }
  });

  initDetailPanel();
  initDragReorder();
}

// ── Load & render ─────────────────────────────────────────────────────────────

export async function load(bookId) {
  _currentBookId = bookId;
  try {
    annotations = await api.getAnnotations(bookId);
  } catch {
    annotations = [];
  }
  render();
}

export function render() {
  const list  = document.getElementById("ann-list");
  const count = document.getElementById("ann-count");
  count.textContent = annotations.length || "";

  if (!annotations.length) {
    list.innerHTML = emptyState("highlighter", "No annotations yet", "Highlight or select text while reading");
    return;
  }

  const highlights = annotations.filter((a) => !a.note);
  const notes = annotations.filter((a) => a.note);

  const renderItems = (items, group) => items.map((a) => `
    <div class="ann-item" data-chapter="${a.chapter_idx}" data-id="${a.id}" data-group="${group}" draggable="true">
      <span class="ann-delete" data-id="${a.id}" title="Delete">✕</span>
      <div class="ann-quote">"${esc(a.quote)}"</div>
      ${a.note ? `<div class="ann-note">${esc(a.note)}</div>` : ""}
      <div class="ann-loc">Section ${a.chapter_idx + 1}</div>
    </div>`).join("");

  let html = "";

  if (highlights.length) {
    html += `
      <div class="ann-section ann-section-highlight">
        <div class="ann-section-header">Highlights (${highlights.length})</div>
        ${renderItems(highlights, "highlight")}
      </div>`;
  }

  if (notes.length) {
    html += `
      <div class="ann-section">
        <div class="ann-section-header">Notes (${notes.length})</div>
        ${renderItems(notes, "note")}
      </div>`;
  }

  list.innerHTML = html;
}

function initDragReorder() {
  const list = document.getElementById("ann-list");
  if (!list) return;

  list.addEventListener("dragstart", (event) => {
    const item = event.target.closest(".ann-item");
    if (!item || event.target.closest(".ann-delete")) return;

    _dragging = true;
    _draggedItem = item;
    _draggedGroup = item.dataset.group || null;
    item.classList.add("ann-item-dragging");

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.dataset.id || "");
    }
  });

  list.addEventListener("dragover", (event) => {
    if (!_draggedItem || !_draggedGroup) return;
    const hovered = document.elementFromPoint(event.clientX, event.clientY);
    const item = hovered?.closest?.(".ann-item");
    if (!item || item === _draggedItem) return;
    if (item.dataset.group !== _draggedGroup) return;

    event.preventDefault();

    if (_dragOverItem && _dragOverItem !== item) {
      _dragOverItem.classList.remove("ann-item-dragover");
    }
    _dragOverItem = item;
    _dragOverItem.classList.add("ann-item-dragover");
  });

  list.addEventListener("drop", (event) => {
    if (!_draggedItem || !_draggedGroup) return;
    event.preventDefault();
    const hovered = document.elementFromPoint(event.clientX, event.clientY);
    const target = hovered?.closest?.(".ann-item");
    if (target && target !== _draggedItem && target.dataset.group === _draggedGroup) {
      finalizeDragOrder(target);
    } else {
      finalizeDragOrder();
    }
    _dragging = false;
  });

  list.addEventListener("dragend", () => {
    if (_draggedItem) {
      _draggedItem.classList.remove("ann-item-dragging");
    }
    if (_dragOverItem) {
      _dragOverItem.classList.remove("ann-item-dragover");
    }
    _draggedItem = null;
    _dragOverItem = null;
    _draggedGroup = null;
    clearTimeout(_dragResetTimer);
    _dragResetTimer = null;
    _dragging = false;
  });
}

function finalizeDragOrder(target = null) {
  if (!_draggedItem || !_draggedGroup) return;
  const section = _draggedItem.closest(".ann-section");
  if (!section) return;

  const orderedIds = [...section.querySelectorAll(".ann-item")]
    .map((el) => el.dataset.id)
    .filter(Boolean);

  if (!orderedIds.length) return;

  const draggedId = _draggedItem.dataset.id;
  const targetId = target?.dataset?.id;
  if (draggedId && targetId && draggedId !== targetId) {
    const fromIdx = orderedIds.indexOf(draggedId);
    const toIdx = orderedIds.indexOf(targetId);
    if (fromIdx >= 0 && toIdx >= 0) {
      orderedIds[fromIdx] = targetId;
      orderedIds[toIdx] = draggedId;
    }
  }

  const highlights = annotations.filter((a) => !a.note);
  const notes = annotations.filter((a) => a.note);

  const reorder = (items, ids) => {
    const byId = new Map(items.map((item) => [item.id, item]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    if (ordered.length !== items.length) {
      const remaining = items.filter((item) => !ids.includes(item.id));
      return [...ordered, ...remaining];
    }
    return ordered;
  };

  const nextHighlights = _draggedGroup === "highlight" ? reorder(highlights, orderedIds) : highlights;
  const nextNotes = _draggedGroup === "note" ? reorder(notes, orderedIds) : notes;
  annotations = [...nextHighlights, ...nextNotes];
  render();

  const orders = orderedIds.map((id, index) => ({
    id,
    order: (index + 1) * 10,
  }));

  void api.updateAnnotationOrder(_currentBookId, orders).catch((err) => {
    toast(`Could not save order: ${err.message}`);
    if (_currentBookId) {
      void load(_currentBookId);
    }
  });
}

// ── Add ───────────────────────────────────────────────────────────────────────

/**
 * Save a new annotation from selected text.
 * @param {{ chapterIdx: number, quote: string, note?: string }} opts
 */
export async function add({ chapterIdx, quote, note }) {
  if (!_currentBookId) return;
  try {
    const ann = await api.addAnnotation({
      bookId: _currentBookId,
      chapterIdx,
      quote,
      note: note || null,
      color: "amber",
    });
    annotations.unshift(ann);
    render();
    return ann;
  } catch (err) {
    toast(`Could not save annotation: ${err.message}`);
    return null;
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function deleteAnnotation(id) {
  try {
    await api.deleteAnnotation(id);
    annotations = annotations.filter((a) => a.id !== id);
    render();
  } catch (err) {
    toast(`Could not delete: ${err.message}`);
  }
}

// ── Panel toggle ──────────────────────────────────────────────────────────────

let _open = true;

export function toggle() {
  _open = !_open;
  document.getElementById("ann-panel").classList.toggle("collapsed", !_open);
}

export function open() {
  if (!_open) toggle();
}

// ── Detail Panel ──────────────────────────────────────────────────────────────

function buildDetailPanelHTML() {
  return `
    <div class="ann-detail-header">
      <button class="ann-detail-close" id="ann-detail-close" title="Close" aria-label="Close">
        <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <line x1="3" y1="3" x2="11" y2="11"></line>
          <line x1="11" y1="3" x2="3" y2="11"></line>
        </svg>
      </button>
      <button class="ann-detail-jump" id="ann-detail-jump" title="Jump to location" aria-label="Jump to location">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M17 12H3"/>
          <path d="m11 18 6-6-6-6"/>
          <path d="M21 5v14"/>
        </svg>
      </button>
    </div>
    <div class="ann-detail-content">
      <div class="ann-detail-quote" id="ann-detail-quote"></div>
      <div class="ann-detail-note" id="ann-detail-note"></div>
      <div class="ann-detail-meta" id="ann-detail-meta"></div>
    </div>`;
}

function initDetailPanel() {
  const content = document.getElementById("content");
  if (!content) return;

  _detailBackdrop = document.createElement("div");
  _detailBackdrop.className = "ann-detail-backdrop";
  _detailBackdrop.setAttribute("aria-hidden", "true");

  _detailPanel = document.createElement("aside");
  _detailPanel.className = "ann-detail-panel";
  _detailPanel.setAttribute("aria-hidden", "true");
  _detailPanel.innerHTML = buildDetailPanelHTML();

  content.appendChild(_detailBackdrop);
  content.appendChild(_detailPanel);

  _detailBackdrop.addEventListener("click", () => closeDetailPanel());
  document.getElementById("ann-detail-close").addEventListener("click", (e) => {
    e.preventDefault();
    closeDetailPanel();
  });
  document.getElementById("ann-detail-jump").addEventListener("click", (e) => {
    e.preventDefault();
    jumpToDetailAnnotation();
  });

  // Keyboard: Escape to close
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _detailPanel && _detailPanel.classList.contains("open")) {
      closeDetailPanel();
    }
  });
}

function openDetailPanel(annId) {
  const ann = annotations.find((a) => a.id === annId);
  if (!ann) return;

  _currentDetailAnnotation = ann;

  const quoteEl = document.getElementById("ann-detail-quote");
  const noteEl = document.getElementById("ann-detail-note");
  const metaEl = document.getElementById("ann-detail-meta");

  quoteEl.textContent = `"${ann.quote}"`;

  if (ann.note) {
    noteEl.innerHTML = `<div class="ann-detail-note-label">Your note:</div><div class="ann-detail-note-text">${esc(ann.note)}</div>`;
  } else {
    noteEl.innerHTML = "";
  }

  const tocTitle = _toc.find((e) => e.chapter_idx === ann.chapter_idx)?.label || "";
  const isFallback = /^Section \d+$/.test(tocTitle);
  const metaLabel = (tocTitle && !isFallback)
    ? `Section ${ann.chapter_idx + 1}: ${tocTitle}`
    : `Section ${ann.chapter_idx + 1}`;
  metaEl.innerHTML = `<span>${esc(metaLabel)}</span>`;

  _detailBackdrop.classList.add("open");
  _detailPanel.classList.add("open");
  _detailPanel.setAttribute("aria-hidden", "false");

  // Prevent body scroll when panel is open
  document.body.style.overflow = "hidden";
}

function closeDetailPanel() {
  if (!_detailPanel) return;

  _detailBackdrop.classList.remove("open");
  _detailPanel.classList.remove("open");
  _detailPanel.setAttribute("aria-hidden", "true");
  _currentDetailAnnotation = null;

  document.body.style.overflow = "";
}

function jumpToDetailAnnotation() {
  if (!_currentDetailAnnotation) return;
  const chapterIdx = _currentDetailAnnotation.chapter_idx;
  const highlightQuery = buildAnnotationHighlightQuery(_currentDetailAnnotation.quote);
  const highlightQuote = String(_currentDetailAnnotation.quote || "").trim();
  closeDetailPanel();
  onJumpToChapter(chapterIdx, { highlightQuery, highlightQuote });
}
