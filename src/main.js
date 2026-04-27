/** Bootstraps the app shell and routes between library and reader views. */

import * as api      from "./api.js";
import * as ui       from "./ui.js";
import * as lib      from "./library.js";
import * as reader   from "./reader.js";
import * as search   from "./search.js";
import * as bookinfo from "./bookinfo.js";
import * as settings from "./settings.js";

// --- Build HTML shell ---

document.getElementById("app").innerHTML = `
<div id="titlebar">
  <span class="app-name">VIVANT</span>
  <div class="tabs">
    <div class="tab active" data-view="library">Library</div>
    <div class="tab" data-view="reader">Reading</div>
  </div>
  <div style="flex:1"></div>
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
      <div class="library-actions" id="library-actions-normal">
        <button class="lib-import-btn" id="btn-import" title="Import EPUB files">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Import Books
        </button>
        <button class="lib-icon-btn" id="btn-settings" title="Settings" aria-label="Settings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
        <div class="lib-search-container">
          <input
            class="lib-search-input"
            id="lib-search-input"
            type="text"
            placeholder="Search..."
            autocomplete="off"
          />
          <span class="lib-search-icon" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="7" cy="7" r="4.5"/>
              <line x1="10.5" y1="10.5" x2="14" y2="14"/>
            </svg>
          </span>
        </div>
        <div class="sort-dropdown" id="sort-dropdown">
          <button
            class="lib-icon-btn"
            id="sort-trigger"
            title="Sort books"
            aria-label="Sort books"
            aria-haspopup="listbox"
            aria-expanded="false"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="4" y1="6" x2="20" y2="6"/>
              <line x1="4" y1="12" x2="14" y2="12"/>
              <line x1="4" y1="18" x2="9" y2="18"/>
            </svg>
          </button>
          <div class="sort-menu" id="sort-menu" role="listbox" aria-label="Sort options"></div>
        </div>
        <button class="lib-icon-btn" id="btn-select" title="Select multiple books" aria-label="Select books">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="5" width="4" height="4" rx="0.5"/>
            <line x1="10" y1="7" x2="21" y2="7"/>
            <rect x="3" y="13" width="4" height="4" rx="0.5"/>
            <line x1="10" y1="15" x2="21" y2="15"/>
          </svg>
        </button>
      </div>
      <div class="library-actions" id="library-actions-selection" style="display: none;">
        <button class="nav-btn" id="btn-selection-cancel">Cancel</button>
        <button class="nav-btn" id="btn-selection-delete">Delete</button>
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
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M13 21h8"/>
            <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>
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
settings.init();

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

wireGlobalEvents();

function wireGlobalEvents() {

  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => switchView(tab.dataset.view))
  );

  document.getElementById("btn-search").addEventListener("click", () => {
    if (currentView === "reader" && hasActiveBook) reader.openSearch();
  });

  document.getElementById("btn-min").addEventListener("click",   () => api.windowMinimize());
  document.getElementById("btn-max").addEventListener("click",   () => api.windowMaximize());
  document.getElementById("btn-close").addEventListener("click", () => api.windowClose());

  document.addEventListener("keydown", (e) => {
    const inInput = e.target.matches("input, textarea");

    if (e.key === "Escape") {
      if (e.defaultPrevented) return;
      if (search.isOpen()) {
        search.close();
        return;
      }
      if (currentView === "reader") {
        switchView("library");
        return;
      }
      if (currentView === "library" && lib.isSelectionMode()) {
        lib.cancelSelectionMode();
        return;
      }
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
    if (!inInput && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      if (currentView === "library" && lib.isSelectionMode()) {
        e.preventDefault();
        lib.selectAllBooks();
        return;
      }
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
}



function switchView(view) {
  if (view === "reader" && !hasActiveBook) {
    ui.toast("Open a book first to start reading");
    return;
  }

  const wasReader = currentView === "reader";
  currentView = view;

  if (view === "library" && search.isOpen()) {
    search.close();
  }

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
    applyViewState();
    pendingReaderFlush = Promise.resolve(reader.flushProgress?.()).catch(() => {});
    pendingReaderFlush.finally(() => {
      if (view === "library") lib.load();
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

document.addEventListener("contextmenu", (e) => e.preventDefault());
