/**
 * search.js — in-book search overlay.
 */
import * as api from "./api.js";
import { esc } from "./ui.js";

let _filePath = null;
let _toc = [];
let _debounce = null;
let onNavigate = (_chapterIdx) => {};

// ── Init ──────────────────────────────────────────────────────────────────────

export function init({ onJump }) {
  onNavigate = onJump;

  document.getElementById("search-input").addEventListener("input", (e) => {
    clearTimeout(_debounce);
    _debounce = setTimeout(() => runSearch(e.target.value.trim()), SEARCH_DEBOUNCE_MS);
  });

  document.getElementById("btn-search-close").addEventListener("click", close);

  document.getElementById("search-results").addEventListener("click", (e) => {
    const row = e.target.closest(".search-result");
    if (row) {
      const query = document.getElementById("search-input").value.trim();
      onNavigate(+row.dataset.chapter, { highlightQuery: query });
      close();
    }
  });
}

// ── Open / close ──────────────────────────────────────────────────────────────

export function open(filePath, toc) {
  _filePath = filePath;
  _toc = toc;
  document.getElementById("search-overlay").classList.add("open");
  document.getElementById("search-input").focus();
}

export function close() {
  document.getElementById("search-overlay").classList.remove("open");
  document.getElementById("search-input").value = "";
  document.getElementById("search-results").innerHTML = "";
  document.getElementById("search-count").textContent = "";
}

export function isOpen() {
  return document.getElementById("search-overlay").classList.contains("open");
}

// ── Search ────────────────────────────────────────────────────────────────────

async function runSearch(query) {
  const countEl   = document.getElementById("search-count");
  const resultsEl = document.getElementById("search-results");

  if (!query || !_filePath) {
    countEl.textContent = "";
    resultsEl.innerHTML = "";
    return;
  }

  try {
    const results = await api.searchBook(_filePath, query);
    countEl.textContent = results.length
      ? `${results.length} result${results.length !== 1 ? "s" : ""}`
      : "No results";
    resultsEl.innerHTML = results.map((r) => {
      const before = esc(r.snippet.slice(0, r.match_start));
      const match  = esc(r.snippet.slice(r.match_start, r.match_start + r.match_len));
      const after  = esc(r.snippet.slice(r.match_start + r.match_len));
      const label  = _toc[r.chapter_idx]?.label ?? `Chapter ${r.chapter_idx + 1}`;
      return `<div class="search-result" data-chapter="${r.chapter_idx}">
        <div class="search-result-text">…${before}<em>${match}</em>${after}…</div>
        <div class="search-result-loc">${esc(label)}</div>
      </div>`;
    }).join("");
  } catch (err) {
    countEl.textContent = `Error: ${err.message}`;
    resultsEl.innerHTML = "";
  }
}
