/**
 * annotations.js — annotations panel: render, add, delete.
 */
import * as api from "./api.js";
import { esc, emptyState, toast } from "./ui.js";

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {import('./api.js').Annotation[]} */
let annotations = [];

/** Callback: user clicked an annotation → jump to that chapter */
let onJumpToChapter = (_idx) => {};

let _currentBookId = null;

// ── Init ──────────────────────────────────────────────────────────────────────

export function init({ onJump }) {
  onJumpToChapter = onJump;

  document.getElementById("ann-list").addEventListener("click", (e) => {
    const item   = e.target.closest(".ann-item");
    const delBtn = e.target.closest(".ann-delete");
    if (delBtn) {
      e.stopPropagation();
      deleteAnnotation(delBtn.dataset.id);
      return;
    }
    if (item) onJumpToChapter(+item.dataset.chapter);
  });
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
    list.innerHTML = emptyState("pencil", "No annotations yet", "Select text while reading to add notes");
    return;
  }

  list.innerHTML = annotations.map((a) => `
    <div class="ann-item" data-chapter="${a.chapter_idx}" data-id="${a.id}">
      <span class="ann-delete" data-id="${a.id}" title="Delete">✕</span>
      <div class="ann-quote">"${esc(a.quote)}"</div>
      ${a.note ? `<div class="ann-note">${esc(a.note)}</div>` : ""}
      <div class="ann-loc">Ch ${a.chapter_idx + 1}</div>
    </div>`).join("");
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
      quote: quote.slice(0, 300),
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
