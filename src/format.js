import { esc } from "./ui.js";

export function estimateProgress(chapterIdx, chapterTotal) {
  if (!chapterTotal || chapterTotal <= 0) return 0;
  const pct = ((chapterIdx + 1) / chapterTotal) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

export function toTagList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  return String(value).split(",").map((v) => v.trim()).filter(Boolean);
}

export function extractYear(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return String(date.getFullYear());
}

export function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatRelativeDate(value) {
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

export function formatFileSize(bytes) {
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

export function formatTimeRead(book) {
  const persistedSeconds = Number(book?.reading_seconds);
  let seconds = Number.isFinite(persistedSeconds) ? persistedSeconds : 0;

  // Migration: old client-side timer key may contain data before backend tracking
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

export function formatDescriptionHtml(rawDescription) {
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

  // Strip dangerous elements; keep semantic tags (p, strong, em, a, lists, quotes)
  body.querySelectorAll("script, style, iframe, object, embed, link, meta").forEach((el) => el.remove());

  // Headings become paragraphs to prevent metadata from creating oversized text blocks
  body.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((el) => {
    const p = doc.createElement("p");
    p.innerHTML = el.innerHTML;
    el.replaceWith(p);
  });

  // Remove layout wrappers (commonly added by EPUB exporters for styling)
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

    // Only keep href on links; strip all other attributes from sanitized metadata HTML
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
