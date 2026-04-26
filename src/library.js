/** Manages library state, rendering, import, deletion, and sort behavior. */
import * as api from "./api.js";
import * as bookinfo from "./bookinfo.js";
import { esc, emptyState, fallbackCover, toast, LIBRARY_SEARCH_DEBOUNCE_MS } from "./ui.js";

const DELETE_DIALOG_CLOSE_DELAY_MS = 120;

let tauriDropUnlisten = null;

let books = [];
let searchQuery = "";
let onOpenBook = (_book) => {};

let selectionMode = false;
let selectedBookIds = new Set();

const SORT_OPTIONS = [
  {
    label: "Recent",
    compare: (a, b) => cmpDateDesc(a.last_opened, b.last_opened) || cmpDateDesc(a.added_at, b.added_at),
  },
  {
    label: "Title",
    compare: (a, b) => cmpText(a.title, b.title) || cmpDateDesc(a.added_at, b.added_at),
  },
  {
    label: "Author",
    compare: (a, b) => cmpText(a.author, b.author) || cmpText(a.title, b.title),
  },
  {
    label: "Progress",
    compare: (a, b) => (b.progress_pct - a.progress_pct) || cmpText(a.title, b.title),
  },
];

/** Filter books by search query across title and author. */
export function filterBooks(booksArray, query) {
  if (!query) return booksArray;
  const q = query.toLowerCase();
  return booksArray.filter((book) =>
    book.title.toLowerCase().includes(q) ||
    book.author.toLowerCase().includes(q)
  );
}

let sortIndex = 0;

/** Initialize library interactions and handlers. */
export function init({ onOpen }) {
  onOpenBook = onOpen;
  initSortDropdown();

  const importBtn = document.getElementById("btn-import");
  if (importBtn) importBtn.addEventListener("click", openFilePicker);

  const selectBtn = document.getElementById("btn-select");
  if (selectBtn) selectBtn.addEventListener("click", toggleSelectionMode);

  const selCancelBtn = document.getElementById("btn-selection-cancel");
  if (selCancelBtn) selCancelBtn.addEventListener("click", () => setSelectionMode(false));

  const selDeleteBtn = document.getElementById("btn-selection-delete");
  if (selDeleteBtn) selDeleteBtn.addEventListener("click", handleBulkDelete);

  let _searchDebounce = null;
  const searchInput = document.getElementById("lib-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value.trim();
      clearTimeout(_searchDebounce);
      _searchDebounce = setTimeout(() => requestAnimationFrame(render), LIBRARY_SEARCH_DEBOUNCE_MS);
    });
  }

  const libView = document.getElementById("view-library");
  let dragDepth = 0;

  function resetDragState() {
    dragDepth = 0;
    libView.classList.remove("drag-over");
  }

  // Expand target area for drag-drop to meet Fitts's law for faster interaction
  libView.addEventListener("dragover", (e) => {
    e.preventDefault();
    dragDepth = Math.max(1, dragDepth);
    libView.classList.add("drag-over");
  });
  libView.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth += 1;
    libView.classList.add("drag-over");
  });
  libView.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      libView.classList.remove("drag-over");
    }
  });
  libView.addEventListener("drop", (e) => {
    e.preventDefault();
    resetDragState();
    const paths = normalizeEpubPaths(
      [...(e.dataTransfer?.files ?? [])]
        .map((f) => f.path)
        .filter(Boolean)
    );
    importPaths(paths);
  });

  // Ensure hover state never remains after focus changes or aborted drags.
  window.addEventListener("blur", resetDragState);
  document.addEventListener("dragend", resetDragState);

  // Listen for native OS drag-drop events in desktop context to support native file manager drops
  setupTauriDropListener(libView, resetDragState);

  document.addEventListener("vivant:library-changed", load);
}

async function setupTauriDropListener(libView, resetDragState) {
  if (tauriDropUnlisten) return;

  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    tauriDropUnlisten = await getCurrentWindow().onDragDropEvent((event) => {
      const { type } = event.payload;

      if (type === "enter" || type === "over") {
        libView.classList.add("drag-over");
        return;
      }

      if (type === "leave") {
        resetDragState();
        return;
      }

      if (type === "drop") {
        resetDragState();
        importPaths(normalizeEpubPaths(event.payload.paths));
      }
    });
  } catch (_err) {
    // Non-Tauri environments (tests/web preview) can rely on DOM drop events.
  }
}

export function normalizeEpubPaths(paths) {
  return paths
    .filter((path) => typeof path === "string")
    .map((path) => path.trim())
    .filter(Boolean)
    .filter((path) => path.toLowerCase().endsWith(".epub"));
}

let _picking = false;
async function openFilePicker(e) {
  e.stopPropagation();
  if (_picking) return;
  _picking = true;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: true,
      filters: [{ name: "EPUB", extensions: ["epub"] }],
    });
    if (!selected) {
      _picking = false;
      return;
    }
    const paths = Array.isArray(selected) ? selected : [selected];
    await importPaths(paths);
  } catch (err) {
    toast(`Could not open file picker: ${err.message}`);
  } finally {
    _picking = false;
  }
}

/** Load books from the backend and render the current library view. */
export async function load() {
  try {
    books = await api.getLibrary();
  } catch (err) {
    toast(`Library error: ${err.message}`);
    books = [];
  }
  render();
}

/** Render the library grid and metadata using current state and sort mode. */
export function render() {
  const grid = document.getElementById("book-grid");
  const meta = document.getElementById("library-meta");

  syncSortDropdown();

  const filteredBooks = getFilteredAndSortedBooks();

  const title = document.querySelector(".library-title");
  
  if (selectionMode) {
    title.textContent = `${selectedBookIds.size} selected`;
    meta.style.display = "none";
    const selDeleteBtn = document.getElementById("btn-selection-delete");
    if (selDeleteBtn) {
      const hasSelection = selectedBookIds.size > 0;
      selDeleteBtn.disabled = !hasSelection;
      selDeleteBtn.classList.toggle("active", hasSelection);
    }
  } else {
    title.textContent = "Your Library";
    meta.style.display = "block";
    const inprog = filteredBooks.filter((b) => b.progress_pct > 0 && b.progress_pct < 100).length;
    meta.textContent = `${filteredBooks.length} book${filteredBooks.length !== 1 ? "s" : ""} · ${inprog} in progress`;
  }

  if (!filteredBooks.length) {
    grid.innerHTML = emptyState("book", "No books yet", searchQuery ? "No books match your search" : "Import an EPUB to get started");
    return;
  }

  grid.innerHTML = filteredBooks.map((b) => buildBookCard(b)).join("");

  grid.querySelectorAll(".book-card").forEach((card) => {
    const bookId = card.dataset.bookId;
    const book = books.find(b => b.id === bookId);
    if (!book) return;
    attachBookCardHandlers(card, book);
  });
}

function applySort(booksArray) {
  const option = SORT_OPTIONS[sortIndex] || SORT_OPTIONS[0];
  booksArray.sort(option.compare);
}

/** Returns HTML string for a single book card. */
function buildBookCard(b) {
  const isSelected = selectedBookIds.has(b.id);
  return `
    <div class="book-card ${isSelected ? 'selected' : ''}" data-book-id="${esc(b.id)}">
      <div class="book-cover">
        <div class="selection-checkbox" aria-hidden="true">
          ${isSelected ? `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 7.5 6 10.5 11 3"></polyline></svg>` : ''}
        </div>
        ${b.cover_b64
          ? `<img src="${b.cover_b64}" alt="${esc(b.title)}" loading="lazy" decoding="async" draggable="false" />`
          : fallbackCover(b.title)}
        <div class="book-cover-overlay">
          <button class="overlay-btn play-btn" title="Open book" aria-label="Open book">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
              <polygon points="8,6 18,12 8,18"></polygon>
            </svg>
          </button>
          <button class="overlay-btn info-btn" title="Book details" aria-label="Book details">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="12" cy="5.2" r="1.6"></circle>
              <rect x="10.8" y="8.2" width="2.4" height="10.8" rx="1.2"></rect>
            </svg>
          </button>
        </div>
      </div>
      <div class="book-title" title="${esc(b.title)}">${esc(b.title)}</div>
      <div class="book-author" title="${esc(b.author)}">${esc(b.author)}</div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:${b.progress_pct}%"></div>
      </div>
      <div class="progress-label">${progressLabel(b)}</div>
      <button class="delete-btn" data-book-id="${esc(b.id)}" title="Delete book" aria-label="Delete book">
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <line x1="3" y1="3" x2="11" y2="11"></line>
          <line x1="11" y1="3" x2="3" y2="11"></line>
        </svg>
      </button>
    </div>`;
}

/** Attaches click handlers to a rendered book card. */
function attachBookCardHandlers(card, book) {
  const playBtn = card.querySelector(".play-btn");
  const infoBtn = card.querySelector(".info-btn");

  card.addEventListener("click", (e) => {
    if (selectionMode) {
      e.preventDefault();
      if (selectedBookIds.has(book.id)) {
        selectedBookIds.delete(book.id);
      } else {
        selectedBookIds.add(book.id);
      }
      render();
      return;
    }
    if (!e.target.closest(".overlay-btn") && !e.target.closest(".delete-btn")) {
      onOpenBook(book);
    }
  });

  playBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onOpenBook(book);
  });

  infoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showBookInfo(book);
  });

  const deleteBtn = card.querySelector(".delete-btn");
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (await confirmDeleteBook()) {
      deleteBookItem(book.id);
    }
  });
}

/** Returns filtered and sorted books ready for rendering. */
function getFilteredAndSortedBooks() {
  const filtered = filterBooks(books, searchQuery);
  applySort(filtered);
  return filtered;
}

function initSortDropdown() {
  const dropdown = document.getElementById("sort-dropdown");
  const trigger = document.getElementById("sort-trigger");
  const menu = document.getElementById("sort-menu");

  if (!dropdown || !trigger || !menu) return;

  menu.innerHTML = SORT_OPTIONS
    .map((opt, idx) => `
      <button
        class="sort-option"
        type="button"
        role="option"
        data-index="${idx}"
        aria-selected="false"
      >Sort: ${esc(opt.label)}</button>`)
    .join("");

  const closeMenu = () => {
    dropdown.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
  };

  const openMenu = () => {
    dropdown.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
  };

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dropdown.classList.contains("open")) {
      closeMenu();
      return;
    }
    openMenu();
  });

  menu.addEventListener("click", (e) => {
    const option = e.target.closest(".sort-option");
    if (!option) return;
    const nextIndex = Number.parseInt(option.dataset.index ?? "", 10);
    if (!Number.isFinite(nextIndex) || nextIndex < 0 || nextIndex >= SORT_OPTIONS.length) {
      return;
    }
    sortIndex = nextIndex;
    closeMenu();
    render();
  });

  document.addEventListener("click", (e) => {
    if (!dropdown.contains(e.target)) {
      closeMenu();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeMenu();
    }
  });

  syncSortDropdown();
}

function syncSortDropdown() {
  const triggerLabel = document.getElementById("sort-trigger-label");
  const menu = document.getElementById("sort-menu");
  if (!triggerLabel || !menu) return;

  const option = SORT_OPTIONS[sortIndex] || SORT_OPTIONS[0];
  triggerLabel.textContent = `Sort: ${option.label}`;

  menu.querySelectorAll(".sort-option").forEach((btn) => {
    const idx = Number.parseInt(btn.dataset.index ?? "", 10);
    const active = idx === sortIndex;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function cmpText(a, b) {
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { sensitivity: "base" });
}

function cmpDateDesc(a, b) {
  return toMillis(b) - toMillis(a);
}

function toMillis(value) {
  const n = Date.parse(value || "");
  return Number.isNaN(n) ? 0 : n;
}

async function confirmDeleteBook() {
  return showDeleteBookConfirm();
}

function showDeleteBookConfirm() {
  return new Promise((resolve) => {
    const existing = document.getElementById("delete-book-confirm");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "delete-book-confirm";
    overlay.className = "external-link-confirm-backdrop";
    overlay.innerHTML = `
      <div class="external-link-confirm" role="dialog" aria-modal="true" aria-labelledby="delete-book-confirm-title">
        <div class="external-link-confirm-title" id="delete-book-confirm-title">Delete Book</div>
        <div class="external-link-confirm-body">Delete this book from your library?</div>
        <div class="external-link-confirm-actions">
          <button class="nav-btn" type="button" data-action="delete">Delete</button>
          <button class="nav-btn" type="button" data-action="cancel">Cancel</button>
        </div>
      </div>`;

    const close = (approved) => {
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.classList.remove("open");
      setTimeout(() => {
        overlay.remove();
        resolve(approved);
      }, DELETE_DIALOG_CLOSE_DELAY_MS);
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
    };

    overlay.addEventListener("click", (event) => {
      const action = event.target?.closest?.("[data-action]")?.getAttribute("data-action");
      if (action === "delete") {
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

    const deleteBtn = overlay.querySelector('[data-action="delete"]');
    deleteBtn?.focus();
  });
}

function setSelectionMode(enabled) {
  selectionMode = enabled;
  selectedBookIds.clear();
  
  const normalActions = document.getElementById("library-actions-normal");
  const selActions = document.getElementById("library-actions-selection");
  if (normalActions) normalActions.style.display = enabled ? "none" : "flex";
  if (selActions) selActions.style.display = enabled ? "flex" : "none";
  
  const libView = document.getElementById("view-library");
  if (libView) libView.classList.toggle("selection-mode", enabled);
  render();
}

function toggleSelectionMode() {
  setSelectionMode(!selectionMode);
}

async function handleBulkDelete() {
  if (selectedBookIds.size === 0) return;
  if (await showDeleteBooksConfirm(selectedBookIds.size)) {
    try {
      const ids = Array.from(selectedBookIds);
      await api.deleteBooks(ids);
      books = books.filter(b => !selectedBookIds.has(b.id));
      render();
      toast(`${ids.length} books deleted`);
      setSelectionMode(false);
    } catch (err) {
      toast(`Delete failed: ${err.message}`);
    }
  }
}

function showDeleteBooksConfirm(count) {
  return new Promise((resolve) => {
    const existing = document.getElementById("delete-book-confirm");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "delete-book-confirm";
    overlay.className = "external-link-confirm-backdrop";
    overlay.innerHTML = `
      <div class="external-link-confirm" role="dialog" aria-modal="true" aria-labelledby="delete-book-confirm-title">
        <div class="external-link-confirm-title" id="delete-book-confirm-title">Delete Books</div>
        <div class="external-link-confirm-body">Delete ${count} selected books from your library?</div>
        <div class="external-link-confirm-actions">
          <button class="nav-btn" type="button" data-action="delete">Delete</button>
          <button class="nav-btn" type="button" data-action="cancel">Cancel</button>
        </div>
      </div>`;

    const close = (approved) => {
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.classList.remove("open");
      setTimeout(() => {
        overlay.remove();
        resolve(approved);
      }, DELETE_DIALOG_CLOSE_DELAY_MS);
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
    };

    overlay.addEventListener("click", (event) => {
      const action = event.target?.closest?.("[data-action]")?.getAttribute("data-action");
      if (action === "delete") {
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

    const deleteBtn = overlay.querySelector('[data-action="delete"]');
    deleteBtn?.focus();
  });
}

async function importPaths(paths) {
  const chunkSize = 20;
  for (let i = 0; i < paths.length; i += chunkSize) {
    const chunk = paths.slice(i, i + chunkSize);
    await Promise.all(chunk.map(async (path) => {
      try {
        const book = await api.importEpub(path);
        upsert(book);
        toast(`"${book.title}" imported`);
      } catch (err) {
        toast(`Import failed: ${err.message}`);
      }
    }));
    render();
  }
}

function upsert(book) {
  const idx = books.findIndex((b) => b.file_path === book.file_path);
  if (idx >= 0) books[idx] = book;
  else books.unshift(book);
}

export function progressLabel(b) {
  if (b.progress_pct <= 0)   return "Not started";
  if (b.progress_pct >= 100) return "✓ Finished";
  return `${Math.round(b.progress_pct)}% read`;
}
async function deleteBookItem(bookId) {
  try {
    const book = books.find((b) => b.id === bookId);
    await api.deleteBooks([bookId]);
    books = books.filter((b) => b.id !== bookId);
    render();
    toast(`"${book.title}" deleted`);
  } catch (err) {
    toast(`Delete failed: ${err.message}`);
  }
}

/** Gather data and show the book info panel. */
async function showBookInfo(book) {
  try {
    const [toc, annotations, progress] = await Promise.all([
      api.getToc(book.file_path),
      api.getAnnotations(book.id),
      api.getProgress(book.id),
    ]);

    if (!progress) {
      toast("Open this book once first, then Book details will be available.");
      return;
    }

    bookinfo.show(book, toc, annotations, progress, {
      onContinue: () => onOpenBook(book),
    });
  } catch (err) {
    toast(`Failed to load book info: ${err.message}`);
  }
}
