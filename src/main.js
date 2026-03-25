/** Bootstraps the app shell and routes between library and reader views. */

import * as api      from "./api.js";
import * as ui       from "./ui.js";
import * as lib      from "./library.js";
import * as reader   from "./reader.js";
import * as search   from "./search.js";
import * as bookinfo from "./bookinfo.js";

// --- Build HTML shell ---

document.getElementById("app").innerHTML = `
<div id="titlebar">
  <span class="app-name">VELLUM</span>
  <div class="tabs">
    <div class="tab active" data-view="library">Library</div>
    <div class="tab" data-view="reader">Reading</div>
  </div>
  <div style="flex:1"></div>
  <div class="theme-swatches">
    <button class="swatch-btn" data-theme="dark" title="Dark">Dark</button>
    <button class="swatch-btn" data-theme="sepia" title="Sepia">Sepia</button>
    <button class="swatch-btn" data-theme="light" title="Light">Light</button>
    <button class="swatch-btn" data-theme="bw" title="B&W">B&W</button>
  </div>
  <div class="sep"></div>
  <button class="icon-btn icon-btn-search" id="btn-search" title="Search (Ctrl+F)" aria-label="Search">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5"/>
      <line x1="10.5" y1="10.5" x2="14" y2="14"/>
    </svg>
  </button>
  <div class="sep" id="sep-search"></div>
  <div class="win-controls">
    <button class="win-btn" id="btn-min" title="Minimize" aria-label="Minimize">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2">
        <line x1="2" y1="5" x2="8" y2="5"/>
      </svg>
    </button>
    <button class="win-btn" id="btn-max" title="Maximize" aria-label="Maximize">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2">
        <rect x="1" y="1" width="8" height="8"/>
      </svg>
    </button>
    <button class="win-btn close" id="btn-close" title="Close" aria-label="Close">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2">
        <line x1="2" y1="2" x2="8" y2="8"/>
        <line x1="8" y1="2" x2="2" y2="8"/>
      </svg>
    </button>
  </div>
</div>

<div id="content">

  <!-- Search overlay (shown over both views when active) -->
  <div class="search-overlay" id="search-overlay">
    <div class="search-row">
      <span class="search-row-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="7" cy="7" r="4.5"/>
          <line x1="10.5" y1="10.5" x2="14" y2="14"/>
        </svg>
      </span>
      <input class="search-input" id="search-input" placeholder="Search in book…" autocomplete="off"/>
      <span class="search-count" id="search-count"></span>
      <button class="search-close-btn" id="btn-search-close" title="Close" aria-label="Close search">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <line x1="3" y1="3" x2="11" y2="11"/>
          <line x1="11" y1="3" x2="3" y2="11"/>
        </svg>
      </button>
    </div>
    <div class="search-results" id="search-results"></div>
  </div>

  <!-- Selection tooltip -->
  <div class="selection-tooltip" id="sel-tooltip">
    <button class="sel-btn" id="sel-highlight">Highlight</button>
    <button class="sel-btn" id="sel-note">+ Note</button>
    <button class="sel-btn" id="sel-cancel" aria-label="Cancel">
      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
        <line x1="3" y1="3" x2="11" y2="11"/>
        <line x1="11" y1="3" x2="3" y2="11"/>
      </svg>
    </button>
  </div>

  <!-- ── Library view ── -->
  <div id="view-library">
    <div class="library-header">
      <div class="library-title-section">
        <div class="library-title">Your Library</div>
        <div class="library-meta" id="library-meta">Loading…</div>
      </div>
      <div class="library-actions">
        <div class="lib-search-container">
          <input
            class="lib-search-input"
            id="lib-search-input"
            type="text"
            placeholder="Search library…"
            autocomplete="off"
          />
          <span class="lib-search-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="7" cy="7" r="4.5"/>
              <line x1="10.5" y1="10.5" x2="14" y2="14"/>
            </svg>
          </span>
        </div>
        <div class="sort-dropdown" id="sort-dropdown">
          <button
            class="nav-btn sort-trigger"
            id="sort-trigger"
            title="Sort books"
            aria-label="Sort books"
            aria-haspopup="listbox"
            aria-expanded="false"
          >
            <span id="sort-trigger-label">Sort: Recent</span>
            <span class="sort-trigger-chevron" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="2.5,4.5 6,8 9.5,4.5"/>
              </svg>
            </span>
          </button>
          <div class="sort-menu" id="sort-menu" role="listbox" aria-label="Sort options"></div>
        </div>
        <button class="nav-btn" id="btn-import" title="Import EPUB files">+ Import</button>
      </div>
    </div>

    <div class="book-grid" id="book-grid"></div>
  </div>

  <!-- ── Reader view ── -->
  <div id="view-reader" style="display:none">
    <div class="toc-panel" id="toc-panel">
      <div class="toc-header">CONTENTS</div>
      <div class="toc-items" id="toc-items"></div>
    </div>

    <div class="reader-main">
      <div class="reader-topbar">
        <button class="icon-btn" id="btn-toc" title="Table of contents" aria-label="Table of contents">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="3" y1="4" x2="13" y2="4"/>
            <line x1="3" y1="8" x2="13" y2="8"/>
            <line x1="3" y1="12" x2="13" y2="12"/>
          </svg>
        </button>
        <div class="reader-title-stack" id="reader-title-stack">
          <div class="reader-book-title" id="reader-book-title">—</div>
          <div class="reader-chapter-title" id="reader-chapter-title">—</div>
        </div>
        <button class="icon-btn" id="btn-ann" title="Annotations" aria-label="Annotations">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2.5 11.8L11.3 3a1.6 1.6 0 0 1 2.2 0l.5.5a1.6 1.6 0 0 1 0 2.2L5.2 14.5l-3 .6.3-3.3z"/>
            <path d="M10.2 4.1l1.7 1.7"/>
          </svg>
        </button>
      </div>
      <div class="reading-area" id="reading-area">
        <div class="chapter-content" id="chapter-content"></div>
      </div>
      <div class="reader-bottombar">
        <button class="nav-btn" id="btn-prev">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="7.5,2.5 4,6 7.5,9.5"/>
          </svg>
          Prev
        </button>
        <div class="reader-progress" id="reader-progress">
          <div class="reader-progress-fill" id="reader-progress-fill" style="width:0%"></div>
          <div class="reader-progress-tooltip" id="reader-progress-tooltip" aria-hidden="true">
            <div class="reader-progress-tooltip-title"></div>
            <div class="reader-progress-tooltip-meta"></div>
          </div>
        </div>
        <span class="pos-label" id="pos-label">—</span>
        <button class="nav-btn" id="btn-next">
          Next
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="4.5,2.5 8,6 4.5,9.5"/>
          </svg>
        </button>
      </div>
    </div>

    <div class="ann-panel" id="ann-panel">
      <div class="ann-header">
        <span>ANNOTATIONS</span>
        <span class="ann-count" id="ann-count"></span>
      </div>
      <div class="ann-list" id="ann-list"></div>
    </div>
  </div>

</div>

<div id="toast"></div>
`;

// --- Apply saved theme ---

ui.applyTheme(ui.savedTheme());

let currentView = "library";
let hasActiveBook = false;
let pendingReaderFlush = Promise.resolve();

function updateReadingTabAvailability() {
  const readerTab = document.querySelector('.tab[data-view="reader"]');
  if (!readerTab) return;
  readerTab.classList.toggle("disabled", !hasActiveBook);
  readerTab.setAttribute("aria-disabled", String(!hasActiveBook));
}

function updateSearchVisibility() {
  const btn = document.getElementById("btn-search");
  const sep = document.getElementById("sep-search");
  const visible = currentView === "reader" && hasActiveBook;
  btn.style.display = visible ? "flex" : "none";
  sep.style.display = visible ? "block" : "none";
}

function updateReaderActivity() {
  reader.setActive?.(currentView === "reader" && hasActiveBook);
}

// --- Initialize modules ---

bookinfo.init();

lib.init({
  onOpen: async (book) => {
    await pendingReaderFlush;
    hasActiveBook = true;
    updateReadingTabAvailability();
    switchView("reader");
    await reader.openBook(book);
  },
});

reader.init();

// --- Wire global events ---

document.querySelectorAll(".swatch-btn").forEach((s) =>
  s.addEventListener("click", () => ui.applyTheme(s.dataset.theme))
);

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => switchView(tab.dataset.view))
);

document.getElementById("btn-search").addEventListener("click", () => {
  if (currentView === "reader" && hasActiveBook) reader.openSearch();
});

// Window controls call backend commands because the title bar is custom.
document.getElementById("btn-min").addEventListener("click",   () => api.windowMinimize());
document.getElementById("btn-max").addEventListener("click",   () => api.windowMaximize());
document.getElementById("btn-close").addEventListener("click", () => api.windowClose());

document.addEventListener("keydown", (e) => {
  const inInput = e.target.matches("input, textarea");

  if (e.key === "Escape") {
    if (search.isOpen()) search.close();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault();

    if (currentView === "library") {
      const librarySearch = document.getElementById("lib-search-input");
      librarySearch?.focus();
      librarySearch?.select();
      return;
    }

    if (currentView === "reader" && hasActiveBook) {
      reader.openSearch();
    }
    return;
  }
  if (!inInput && e.key === "ArrowRight") reader.loadChapter && document.getElementById("btn-next").click();
  if (!inInput && e.key === "ArrowLeft")  reader.loadChapter && document.getElementById("btn-prev").click();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    reader.flushProgress?.();
  }
});

window.addEventListener("beforeunload", () => {
  reader.flushProgress?.();
});

// --- Switch active view ---

function switchView(view) {
  if (view === "reader" && !hasActiveBook) {
    ui.toast("Open a book first to start reading");
    return;
  }

  const wasReader = currentView === "reader";
  currentView = view;

  const applyViewState = () => {
    document.getElementById("view-library").style.display = view === "library" ? "block" : "none";
    document.getElementById("view-reader").style.display  = view === "reader"  ? "flex"  : "none";
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.view === view)
    );
    updateSearchVisibility();
    updateReaderActivity();
  };

  if (wasReader && view !== "reader") {
    pendingReaderFlush = Promise.resolve(reader.flushProgress?.()).catch(() => {});
    pendingReaderFlush.finally(() => {
      if (view === "library") lib.load();
      applyViewState();
    });
    return;
  } else if (view === "library") {
    lib.load();
  }

  applyViewState();
}

// --- Bootstrap ---

lib.load();
updateReadingTabAvailability();
updateSearchVisibility();
updateReaderActivity();
