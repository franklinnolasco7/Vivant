/** Book info panel: slides in from right and displays rich book details. */

import { esc, fallbackCover, toast } from "./ui.js";

let backdrop = null;
let panel = null;
let onContinue = null;

/** Build panel once at startup to avoid re-creating DOM for smooth slide animations on repeated open/close. */
export function init() {
  if (panel) return;

  const content = document.getElementById("content");
  if (!content) return;

  backdrop = document.createElement("div");
  backdrop.className = "bookinfo-backdrop";

  panel = document.createElement("aside");
  panel.className = "bookinfo-panel";
  panel.setAttribute("aria-hidden", "true");
  panel.innerHTML = `
    <section class="bookinfo-hero">
      <div class="bookinfo-cover" id="bookinfo-cover"></div>
      <div class="bookinfo-header">
        <h2 class="bookinfo-title" id="bookinfo-title"></h2>
        <div class="bookinfo-authorline" id="bookinfo-authorline"></div>
        <div class="bookinfo-tags" id="bookinfo-tags"></div>
        <div class="bookinfo-actions">
          <button class="bookinfo-btn bookinfo-btn-primary" id="bookinfo-continue">Continue reading</button>
          <button class="bookinfo-btn bookinfo-btn-icon" id="bookinfo-edit" title="Edit book details" aria-label="Edit book details">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 21l3.8-.8L19 8l-3-3L3.8 17.2z"></path>
              <path d="M14 4l3 3"></path>
            </svg>
          </button>
          <button class="bookinfo-btn bookinfo-btn-secondary" id="bookinfo-close-main" title="Close" aria-label="Close">
            <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
              <line x1="3" y1="3" x2="11" y2="11"></line>
              <line x1="11" y1="3" x2="3" y2="11"></line>
            </svg>
          </button>
        </div>
      </div>
    </section>

    <section class="bookinfo-stats">
      <div class="bookinfo-stat">
        <div class="bookinfo-stat-value" id="stat-progress">0%</div>
        <div class="bookinfo-stat-label">Progress</div>
      </div>
      <div class="bookinfo-stat">
        <div class="bookinfo-stat-value" id="stat-pages">0</div>
        <div class="bookinfo-stat-label">Pages</div>
      </div>
      <div class="bookinfo-stat">
        <div class="bookinfo-stat-value" id="stat-annotations">0</div>
        <div class="bookinfo-stat-label">Annotations</div>
      </div>
      <div class="bookinfo-stat">
        <div class="bookinfo-stat-value" id="stat-time">-</div>
        <div class="bookinfo-stat-label">Time read</div>
      </div>
    </section>

    <nav class="bookinfo-tabs" aria-label="Book info tabs">
      <button class="bookinfo-tab-btn active" data-tab="overview">Overview</button>
      <button class="bookinfo-tab-btn" data-tab="chapters">Chapters</button>
      <button class="bookinfo-tab-btn" data-tab="annotations">Annotations</button>
    </nav>

    <section class="bookinfo-content">
      <div class="bookinfo-tab-pane active" data-tab="overview">
        <div class="bookinfo-overview-title">Reading progress</div>
        <div class="progress-bar-large">
          <div class="progress-fill-large" id="overview-progress-fill"></div>
        </div>
        <div class="bookinfo-overview-progress-row">
          <div class="bookinfo-last-read" id="last-read"></div>
          <div class="bookinfo-progress-pct" id="overview-progress-text"></div>
        </div>

        <div class="bookinfo-overview-title">About this book</div>
        <div class="description" id="description"></div>

        <div class="bookinfo-overview-title">Book details</div>
        <table class="details-table">
          <tr><td>Publisher</td><td id="detail-publisher">-</td></tr>
          <tr><td>Published</td><td id="detail-published">-</td></tr>
          <tr><td>Language</td><td id="detail-language">-</td></tr>
          <tr><td>File size</td><td id="detail-filesize">-</td></tr>
          <tr><td>Added</td><td id="detail-dateadded">-</td></tr>
        </table>
      </div>

      <div class="bookinfo-tab-pane" data-tab="chapters">
        <div class="chapters-list" id="chapters-list"></div>
      </div>

      <div class="bookinfo-tab-pane" data-tab="annotations">
        <div class="annotations-list" id="annotations-list"></div>
      </div>
    </section>
  `;

  content.appendChild(backdrop);
  content.appendChild(panel);

  backdrop.addEventListener("click", close);
  panel.querySelector("#bookinfo-close-main").addEventListener("click", close);
  panel.querySelector("#bookinfo-continue").addEventListener("click", () => {
    if (typeof onContinue === "function") onContinue();
    close();
  });
  panel.querySelector("#bookinfo-edit").addEventListener("click", () => {
    toast("Edit details coming soon");
  });

  panel.querySelectorAll(".bookinfo-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("open")) close();
  });
}

/** Populate and open panel. */
export function show(book, toc = [], annotations = [], progress = {}, options = {}) {
  if (!panel) init();
  if (!panel) return;

  progress = progress || {};
  onContinue = options.onContinue;

  const progressChapter = Number.isFinite(progress.chapter_idx)
    ? progress.chapter_idx
    : Number.isFinite(book.progress_chapter)
      ? book.progress_chapter
      : 0;
  const progressPct = Number.isFinite(book.progress_pct)
    ? Math.max(0, Math.min(100, Math.round(book.progress_pct)))
    : estimateProgress(progressChapter, toc.length || book.chapter_count || 1);

  renderHero(book);
  renderStats(book, toc, annotations, progressPct);
  renderOverview(book, toc, progressChapter, progressPct);
  renderChapters(toc, progressChapter);
  renderAnnotations(annotations, toc);
  switchTab("overview");

  panel.classList.add("open");
  backdrop.classList.add("open");
  panel.setAttribute("aria-hidden", "false");
}

/** Close panel. */
export function close() {
  if (!panel || !backdrop) return;
  panel.classList.remove("open");
  backdrop.classList.remove("open");
  panel.setAttribute("aria-hidden", "true");
}

function switchTab(tab) {
  panel.querySelectorAll(".bookinfo-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  panel.querySelectorAll(".bookinfo-tab-pane").forEach((pane) => {
    pane.classList.toggle("active", pane.dataset.tab === tab);
  });
}

function renderHero(book) {
  const cover = panel.querySelector("#bookinfo-cover");
  cover.innerHTML = book.cover_b64
    ? `<img src="${book.cover_b64}" alt="${esc(book.title || "Book cover")}"/>`
    : fallbackCover(book.title || "Untitled");

  panel.querySelector("#bookinfo-title").textContent = book.title || "Untitled";

  const year = extractYear(book.published_at || book.added_at);
  const author = book.author || "Unknown author";
  panel.querySelector("#bookinfo-authorline").textContent = year ? `${author} · ${year}` : author;

  const tags = panel.querySelector("#bookinfo-tags");
  const genreTags = toTagList(book.genre);
  tags.innerHTML = (genreTags.length ? genreTags : ["EPUB"]).slice(0, 3)
    .map((tag) => `<span class="bookinfo-tag">${esc(tag)}</span>`)
    .join("");
}

function renderStats(book, toc, annotations, progressPct) {
  panel.querySelector("#stat-progress").textContent = `${progressPct}%`;
  panel.querySelector("#stat-pages").textContent = String(book.chapter_count || toc.length || 0);
  panel.querySelector("#stat-annotations").textContent = String(annotations.length || 0);
  panel.querySelector("#stat-time").textContent = formatTimeRead(book);
}

function renderOverview(book, toc, progressChapter, progressPct) {
  panel.querySelector("#overview-progress-fill").style.width = `${progressPct}%`;
  panel.querySelector("#overview-progress-text").textContent = `${progressPct}%`;

  const current = toc.find((t) => Number(t.chapter_idx) === Number(progressChapter));
  const currentLabel = current?.label || current?.title || `Ch ${Number(progressChapter) + 1}`;
  const when = formatRelativeDate(book.last_opened || book.added_at);
  panel.querySelector("#last-read").textContent = `Last read · ${currentLabel}${when ? ` · ${when}` : ""}`;

  const description = panel.querySelector("#description");
  description.innerHTML = formatDescriptionHtml(book.description);

  panel.querySelector("#detail-publisher").textContent = book.publisher || "-";
  panel.querySelector("#detail-published").textContent = formatDate(book.published_at) || "-";
  panel.querySelector("#detail-language").textContent = book.language || "-";
  panel.querySelector("#detail-filesize").textContent = Number.isFinite(book.file_size)
    ? formatFileSize(book.file_size)
    : "-";
  panel.querySelector("#detail-dateadded").textContent = formatDate(book.added_at) || "-";
}

function renderChapters(toc, progressChapter) {
  const list = panel.querySelector("#chapters-list");
  const flat = flattenToc(toc);

  if (!flat.length) {
    list.innerHTML = "<p><em>No chapters available.</em></p>";
    return;
  }

  list.innerHTML = flat.map((entry, idx) => {
    const chapterIdx = Number.isFinite(entry.chapter_idx) ? entry.chapter_idx : idx;
    const read = chapterIdx <= progressChapter;
    const current = chapterIdx === progressChapter;
    const label = entry.label || entry.title || `Chapter ${chapterIdx + 1}`;
    const displayIndex = chapterIdx + 1;
    return `
      <div class="chapter-item ${read ? "read" : "unread"} ${current ? "current" : ""}" data-depth="${entry.depth}">
        <span class="chapter-index">${displayIndex}</span>
        <span class="chapter-title">${esc(label)}</span>
        <span class="chapter-dot"></span>
      </div>
    `;
  }).join("");
}

function renderAnnotations(annotations, toc = []) {
  const list = panel.querySelector("#annotations-list");
  if (!annotations?.length) {
    list.innerHTML = "<p><em>No annotations yet.</em></p>";
    return;
  }

  const chapterTitleByIdx = new Map();
  flattenToc(toc).forEach((entry, idx) => {
    const chapterIdx = Number.isFinite(entry.chapter_idx) ? entry.chapter_idx : idx;
    const label = entry.label || entry.title || "";
    if (label && !chapterTitleByIdx.has(chapterIdx)) chapterTitleByIdx.set(chapterIdx, label);
  });

  const count = annotations.length;
  const summary = `${count} annotation${count === 1 ? "" : "s"}`;

  list.innerHTML = `
    <div class="annotations-summary">${summary}</div>
    ${annotations.map((ann) => {
    const chapterLabel = Number.isFinite(ann.chapter_idx)
      ? `Ch ${ann.chapter_idx + 1}${chapterTitleByIdx.get(ann.chapter_idx) ? `: ${chapterTitleByIdx.get(ann.chapter_idx)}` : ""}`
      : "Chapter";
    return `
      <article class="annotation-item">
        <div class="annotation-bar"></div>
        <div class="annotation-content">
          <blockquote class="annotation-quote">"${esc(ann.quote || "")}"</blockquote>
          ${ann.note ? `<div class="annotation-note">${esc(ann.note)}</div>` : ""}
          <div class="annotation-meta">${esc(chapterLabel)}</div>
        </div>
      </article>
    `;
  }).join("")}
  `;
}

function flattenToc(entries, depth = 0, out = []) {
  if (!Array.isArray(entries)) return out;
  for (const item of entries) {
    out.push({ ...item, depth });
    if (Array.isArray(item.children) && item.children.length) {
      flattenToc(item.children, depth + 1, out);
    }
  }
  return out;
}

function estimateProgress(chapterIdx, chapterTotal) {
  if (!chapterTotal || chapterTotal <= 0) return 0;
  const pct = ((chapterIdx + 1) / chapterTotal) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function toTagList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  return String(value).split(",").map((v) => v.trim()).filter(Boolean);
}

function extractYear(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return String(date.getFullYear());
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatRelativeDate(value) {
  if (!value) return "";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const diff = Date.now() - time;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value);
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatTimeRead(book) {
  const persistedSeconds = Number(book?.reading_seconds);
  let seconds = Number.isFinite(persistedSeconds) ? persistedSeconds : 0;

  // Backward-compatible fallback for older client-side tracking data.
  if (seconds <= 0 && book?.id) {
    const key = `book-time-${book.id}`;
    seconds = parseInt(localStorage.getItem(key) || "0", 10);
  }

  if (!Number.isFinite(seconds) || seconds <= 0) return "-";
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hours <= 0) return `${mins}m`;
  if (mins <= 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

function formatDescriptionHtml(rawDescription) {
  if (!rawDescription || !String(rawDescription).trim()) {
    return "<p><em>No description available.</em></p>";
  }

  const raw = String(rawDescription).trim();
  const hasHtmlTags = /<\/?[a-z][\s\S]*>/i.test(raw);

  if (!hasHtmlTags) {
    const plain = formatPlainDescription(raw);
    return plain || "<p><em>No description available.</em></p>";
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, "text/html");
  const body = doc.body;

  body.querySelectorAll("script, style, iframe, object, embed, link, meta").forEach((el) => el.remove());

  // Convert heading-like nodes to paragraphs so metadata does not create oversized text blocks.
  body.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((el) => {
    const p = doc.createElement("p");
    p.innerHTML = el.innerHTML;
    el.replaceWith(p);
  });

  // Unwrap layout wrappers that commonly appear in EPUB metadata blobs.
  body.querySelectorAll("div, section, article, span, font").forEach((el) => {
    el.replaceWith(...el.childNodes);
  });

  const allowed = new Set(["P", "EM", "STRONG", "B", "I", "U", "BR", "UL", "OL", "LI", "BLOCKQUOTE", "A"]);
  body.querySelectorAll("*").forEach((el) => {
    if (!allowed.has(el.tagName)) {
      el.replaceWith(...el.childNodes);
      return;
    }

    const href = el.tagName === "A" ? (el.getAttribute("href") || "") : "";

    // Drop presentational and unknown attributes from metadata HTML.
    [...el.attributes].forEach((attr) => el.removeAttribute(attr.name));

    if (el.tagName === "A") {
      if (/^(https?:|mailto:)/i.test(href)) {
        el.setAttribute("href", href);
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      } else {
        el.replaceWith(...el.childNodes);
      }
    }
  });

  const normalized = body.innerHTML.trim();
  if (!normalized) return "<p><em>No description available.</em></p>";

  // Ensure root-level text nodes and loose list items become block elements.
  const wrapped = parser.parseFromString(`<div>${normalized}</div>`, "text/html");
  const root = wrapped.body.firstElementChild;
  if (!root) return "<p><em>No description available.</em></p>";

  normalizeDescriptionBlocks(wrapped, root);

  const hasParagraphLike = root.querySelector("p, ul, ol, blockquote");
  if (hasParagraphLike) return root.innerHTML;

  const text = root.textContent?.trim() || "";
  return text ? `<p>${esc(text)}</p>` : "<p><em>No description available.</em></p>";
}

function formatPlainDescription(raw) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let paraLines = [];
  let bulletLines = [];

  function flushParagraph() {
    if (!paraLines.length) return;
    const text = paraLines.join(" ").replace(/\s+/g, " ").trim();
    paraLines = [];
    if (!text) return;
    blocks.push(`<p>${esc(text)}</p>`);
  }

  function flushBullets() {
    if (!bulletLines.length) return;
    const items = bulletLines
      .map((line) => stripBulletPrefix(line))
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `<li>${esc(line)}</li>`)
      .join("");
    bulletLines = [];
    if (!items) return;
    blocks.push(`<ul>${items}</ul>`);
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushBullets();
      continue;
    }

    if (isBulletLine(trimmed)) {
      flushParagraph();
      bulletLines.push(trimmed);
      continue;
    }

    flushBullets();
    paraLines.push(trimmed);
  }

  flushParagraph();
  flushBullets();
  return blocks.join("");
}

function normalizeDescriptionBlocks(doc, root) {
  const blockTags = new Set(["P", "UL", "OL", "BLOCKQUOTE"]);
  let pendingParagraph = [];
  let pendingLooseListItems = [];

  function flushPendingParagraph() {
    if (!pendingParagraph.length) return;
    const text = pendingParagraph.join(" ").replace(/\s+/g, " ").trim();
    pendingParagraph = [];
    if (!text) return;
    const p = doc.createElement("p");
    p.textContent = text;
    root.appendChild(p);
  }

  function flushLooseListItems() {
    if (!pendingLooseListItems.length) return;
    const ul = doc.createElement("ul");
    pendingLooseListItems.forEach((li) => ul.appendChild(li));
    pendingLooseListItems = [];
    root.appendChild(ul);
  }

  const original = [...root.childNodes];
  root.innerHTML = "";

  for (const node of original) {
    if (node.nodeType === Node.TEXT_NODE) {
      const txt = (node.textContent || "").trim();
      if (txt) pendingParagraph.push(txt);
      continue;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node;

    if (el.tagName === "LI") {
      flushPendingParagraph();
      pendingLooseListItems.push(el);
      continue;
    }

    flushLooseListItems();

    if (blockTags.has(el.tagName)) {
      flushPendingParagraph();
      root.appendChild(el);
      continue;
    }

    const text = (el.textContent || "").trim();
    if (text) pendingParagraph.push(text);
  }

  flushLooseListItems();
  flushPendingParagraph();
}

function isBulletLine(line) {
  return /^([*\-•]|\d+[.)])\s+/.test(line);
}

function stripBulletPrefix(line) {
  return line.replace(/^([*\-•]|\d+[.)])\s+/, "");
}
