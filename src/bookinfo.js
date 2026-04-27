/** Book info panel: slides in from right and displays rich book details. */

import { esc, fallbackCover, toast } from "./ui.js";
import * as coverCache from "./cover-cache.js";
import * as format from "./format.js";
import * as api from "./api.js";

let currentBook = null;

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
              <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>
            </svg>
          </button>
          <button class="bookinfo-btn bookinfo-btn-icon" id="bookinfo-close-main" title="Close" aria-label="Close">
            <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
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
        <div class="bookinfo-stat-label">Sections</div>
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
      <button class="bookinfo-tab-btn" data-tab="chapters">Sections</button>
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
    if (currentBook) showEditDialog(currentBook);
  });

  panel.querySelectorAll(".bookinfo-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("open")) {
      e.preventDefault();
      close();
    }
  });
}

/** Populate and open panel. */
export function show(book, toc = [], annotations = [], progress = {}, options = {}) {
  if (!panel) init();
  if (!panel) return;

  currentBook = book;

  progress = progress || {};
  onContinue = options.onContinue;

  const progressChapter = Number.isFinite(progress.chapter_idx)
    ? progress.chapter_idx
    : Number.isFinite(book.progress_chapter)
      ? book.progress_chapter
      : 0;
  const progressPct = Number.isFinite(book.progress_pct)
    ? Math.max(0, Math.min(100, Math.round(book.progress_pct)))
    : format.estimateProgress(progressChapter, toc.length || book.chapter_count || 1);

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
  const coverUrl = coverCache.getCoverUrl(book.id, book.cover_b64);
  cover.innerHTML = coverUrl
    ? `<img src="${coverUrl}" alt="${esc(book.title || "Book cover")}" decoding="sync" />`
    : fallbackCover(book.title || "Untitled");

  panel.querySelector("#bookinfo-title").textContent = book.title || "Untitled";

  const year = format.extractYear(book.published_at || book.added_at);
  const author = book.author || "Unknown author";
  panel.querySelector("#bookinfo-authorline").textContent = year ? `${author} · ${year}` : author;

  const tags = panel.querySelector("#bookinfo-tags");
  const genreTags = format.toTagList(book.genre);
  tags.innerHTML = (genreTags.length ? genreTags : ["EPUB"]).slice(0, 3)
    .map((tag) => `<span class="bookinfo-tag">${esc(tag)}</span>`)
    .join("");
}

function renderStats(book, toc, annotations, progressPct) {
  panel.querySelector("#stat-progress").textContent = `${progressPct}%`;
  panel.querySelector("#stat-pages").textContent = String(book.chapter_count || toc.length || 0);
  panel.querySelector("#stat-annotations").textContent = String(annotations.length || 0);
  panel.querySelector("#stat-time").textContent = format.formatTimeRead(book);
}

function renderOverview(book, toc, progressChapter, progressPct) {
  panel.querySelector("#overview-progress-fill").style.width = `${progressPct}%`;
  panel.querySelector("#overview-progress-text").textContent = `${progressPct}%`;

  const current = toc.find((t) => Number(t.chapter_idx) === Number(progressChapter));
  const currentLabel = current?.label || current?.title || `Sec ${Number(progressChapter) + 1}`;
  const when = format.formatRelativeDate(book.last_opened || book.added_at);
  panel.querySelector("#last-read").textContent = `Last read · ${currentLabel}${when ? ` · ${when}` : ""}`;

  const description = panel.querySelector("#description");
  description.innerHTML = format.formatDescriptionHtml(book.description);

  panel.querySelector("#detail-publisher").textContent = book.publisher || "-";
  panel.querySelector("#detail-published").textContent = format.formatDate(book.published_at) || "-";
  panel.querySelector("#detail-language").textContent = book.language || "-";
  panel.querySelector("#detail-filesize").textContent = Number.isFinite(book.file_size)
    ? format.formatFileSize(book.file_size)
    : "-";
  panel.querySelector("#detail-dateadded").textContent = format.formatDate(book.added_at) || "-";
}

function renderChapters(toc, progressChapter) {
  const list = panel.querySelector("#chapters-list");
  const flat = flattenToc(toc);

  if (!flat.length) {
    list.innerHTML = "<p><em>No sections available.</em></p>";
    return;
  }

  list.innerHTML = flat.map((entry, idx) => {
    const chapterIdx = Number.isFinite(entry.chapter_idx) ? entry.chapter_idx : idx;
    const read = chapterIdx <= progressChapter;
    const current = chapterIdx === progressChapter;
    const label = entry.label || entry.title || `Section ${chapterIdx + 1}`;
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
    const rawLabel = chapterTitleByIdx.get(ann.chapter_idx) || "";
    const isFallback = /^Section \d+$/.test(rawLabel);
    const chapterLabel = Number.isFinite(ann.chapter_idx)
      ? `Sec ${ann.chapter_idx + 1}${(rawLabel && !isFallback) ? `: ${rawLabel}` : ""}`
      : "Section";
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


async function showEditDialog(book) {
  const dialog = document.createElement("dialog");
  dialog.className = "book-edit-dialog";
  dialog.innerHTML = `
    <form method="dialog" class="book-edit-form" novalidate>
      <h3 class="book-edit-title">Edit Book Details</h3>
      <div class="book-edit-grid">
        <label><span>Title</span> <input type="text" name="title" value="${esc(book.title || "")}" title="Book title" placeholder="Book title" required /></label>
        <label><span>Author</span> <input type="text" name="author" value="${esc(book.author || "")}" title="Book author. No numbers allowed." placeholder="Author name" pattern="^[^0-9]*$" /></label>
        <label><span>Genre</span> <input type="text" name="genre" value="${esc(book.genre || "")}" title="Comma-separated genres. No numbers allowed." placeholder="e.g. Science Fiction, Drama" pattern="^[^0-9]*$" /></label>
        <label><span>Publisher</span> <input type="text" name="publisher" value="${esc(book.publisher || "")}" title="Book publisher" placeholder="Publisher name" /></label>
        <label><span>Language</span> <input type="text" name="language" value="${esc(book.language || "")}" title="Language code (e.g. en) or name. No numbers allowed." placeholder="e.g. en, fr, es" pattern="^[^0-9]*$" /></label>
        <label><span>Published</span> <input type="text" name="published_at" placeholder="YYYY-MM-DD or YYYY" value="${esc(book.published_at || "")}" pattern="^\\d{4}(?:-\\d{2})?(?:-\\d{2})?(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)?$" title="Please enter a valid year (YYYY), date (YYYY-MM-DD), or ISO datetime" /></label>
        <label class="book-edit-fullwidth"><span>Description</span> <textarea name="description" rows="4" title="Book description" placeholder="Brief description or synopsis...">${esc(book.description || "")}</textarea></label>
      </div>
      <div class="book-edit-actions">
        <button type="button" class="nav-btn" id="edit-cancel">Cancel</button>
        <button type="submit" class="nav-btn">Save</button>
      </div>
    </form>
  `;

  document.body.appendChild(dialog);

  const form = dialog.querySelector("form");
  const inputs = form.querySelectorAll("input, textarea");

  function clearCustomError(input) {
    const err = input.parentElement.querySelector(".custom-val-err");
    if (err) err.remove();
  }

  function showCustomError(input) {
    clearCustomError(input);
    const err = document.createElement("div");
    err.className = "custom-val-err";
    err.textContent = input.title || input.validationMessage;
    input.parentElement.appendChild(err);
  }

  inputs.forEach(input => {
    input.addEventListener("invalid", (e) => {
      e.preventDefault();
      showCustomError(input);
    });
    input.addEventListener("input", () => {
      if (input.validity.valid) {
        clearCustomError(input);
      }
    });
  });

  dialog.querySelector("#edit-cancel").addEventListener("click", () => {
    dialog.close();
  });

  dialog.addEventListener("close", () => {
    dialog.remove();
  });

  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
    }
  });

  dialog.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;

    const langInput = form.elements.language;
    const langVal = langInput.value.trim();
    const langMap = {
      abkhazian: "ab", afar: "aa", afrikaans: "af", akan: "ak", albanian: "sq",
      amharic: "am", arabic: "ar", aragonese: "an", armenian: "hy", assamese: "as",
      avaric: "av", avestan: "ae", aymara: "ay", azerbaijani: "az", bambara: "bm",
      bashkir: "ba", basque: "eu", belarusian: "be", bengali: "bn", bihari: "bh",
      bislama: "bi", bosnian: "bs", breton: "br", bulgarian: "bg", burmese: "my",
      catalan: "ca", chamorro: "ch", chechen: "ce", chichewa: "ny", chinese: "zh",
      mandarin: "zh", cantonese: "yue", chuvash: "cv", cornish: "kw", corsican: "co",
      cree: "cr", croatian: "hr", czech: "cs", danish: "da", divehi: "dv",
      dutch: "nl", flemish: "nl", dzongkha: "dz", english: "en", esperanto: "eo",
      estonian: "et", ewe: "ee", faroese: "fo", fijian: "fj", finnish: "fi",
      french: "fr", fula: "ff", galician: "gl", georgian: "ka", german: "de",
      greek: "el", guarani: "gn", gujarati: "gu", haitian: "ht", hausa: "ha",
      hebrew: "he", herero: "hz", hindi: "hi", "hiri motu": "ho", hungarian: "hu",
      interlingua: "ia", indonesian: "id", interlingue: "ie", irish: "ga", igbo: "ig",
      inupiaq: "ik", ido: "io", icelandic: "is", italian: "it", inuktitut: "iu",
      japanese: "ja", javanese: "jv", kalaallisut: "kl", kannada: "kn", kanuri: "kr",
      kashmiri: "ks", kazakh: "kk", khmer: "km", kikuyu: "ki", kinyarwanda: "rw",
      kirghiz: "ky", komi: "kv", kongo: "kg", korean: "ko", kurdish: "ku",
      kwanyama: "kj", latin: "la", luxembourgish: "lb", luganda: "lg",
      limburgish: "li", lingala: "ln", lao: "lo", lithuanian: "lt",
      "luba-katanga": "lu", latvian: "lv", manx: "gv", macedonian: "mk",
      malagasy: "mg", malay: "ms", malayalam: "ml", maltese: "mt", maori: "mi",
      marathi: "mr", marshallese: "mh", mongolian: "mn", nauru: "na", navajo: "nv",
      ndonga: "nd", nepali: "ne", norwegian: "no", "sichuan yi": "ii", occitan: "oc",
      ojibwa: "oj", oromo: "om", oriya: "or", ossetian: "os", pali: "pi",
      pashto: "ps", persian: "fa", farsi: "fa", polish: "pl", portuguese: "pt",
      punjabi: "pa", quechua: "qu", romanian: "ro", romansh: "rm", rundi: "rn",
      russian: "ru", "northern sami": "se", samoan: "sm", sango: "sg",
      sanskrit: "sa", sardinian: "sc", serbian: "sr", shona: "sn", sindhi: "sd",
      sinhala: "si", slovak: "sk", slovenian: "sl", somali: "so",
      "southern sotho": "st", spanish: "es", sundanese: "su", swahili: "sw",
      swati: "ss", swedish: "sv", tamil: "ta", telugu: "te", tajik: "tg",
      thai: "th", tigrinya: "ti", tibetan: "bo", turkmen: "tk", tagalog: "tl",
      filipino: "tl", tswana: "tn", tonga: "to", turkish: "tr", tsonga: "ts",
      tatar: "tt", twi: "tw", tahitian: "ty", uighur: "ug", ukrainian: "uk",
      urdu: "ur", uzbek: "uz", venda: "ve", vietnamese: "vi", volapük: "vo",
      walloon: "wa", welsh: "cy", wolof: "wo", "western frisian": "fy", xhosa: "xh",
      yiddish: "yi", yoruba: "yo", zhuang: "za", zulu: "zu",
      "scottish gaelic": "gd", gaelic: "gd", breton: "br"
    };

    if (langVal) {
      if (/\\d/.test(langVal)) {
        langInput.setCustomValidity("Language cannot contain numbers");
      } else {
        const lowerLang = langVal.toLowerCase();
        if (!langMap[lowerLang] && !Object.values(langMap).includes(lowerLang)) {
          langInput.setCustomValidity("Invalid language. Must be a valid language name or code.");
        } else {
          langInput.setCustomValidity("");
        }
      }
    } else {
      langInput.setCustomValidity("");
    }

    if (!form.checkValidity()) return;
    const formData = new FormData(form);

    const title = formData.get("title").trim();
    const author = formData.get("author").trim();
    const rawGenre = formData.get("genre").trim();
    const genre = rawGenre ? rawGenre.split(",").map(g => g.trim()).filter(Boolean).join(", ") : null;
    const publisher = formData.get("publisher").trim() || null;
    const publishedAt = formData.get("published_at").trim() || null;

    let language = langVal || null;
    if (language) {
      const lowerLang = language.toLowerCase();
      language = langMap[lowerLang] ? langMap[lowerLang] : lowerLang;
    }

    const update = {
      id: book.id,
      title,
      author: author || "Unknown Author",
      genre,
      description: formData.get("description").trim() || null,
      publisher,
      language,
      published_at: publishedAt,
    };

    try {
      await api.updateBookMetadata(update);
      Object.assign(book, update);
      renderHero(book);
      // Hack: we don't have toc and progress around, but we can just update the elements manually or close/re-open panel.
      panel.querySelector("#bookinfo-title").textContent = book.title || "Untitled";
      const year = format.extractYear(book.published_at || book.added_at);
      const author = book.author || "Unknown author";
      panel.querySelector("#bookinfo-authorline").textContent = year ? `${author} · ${year}` : author;
      
      const tags = panel.querySelector("#bookinfo-tags");
      const genreTags = format.toTagList(book.genre);
      tags.innerHTML = (genreTags.length ? genreTags : ["EPUB"]).slice(0, 3)
        .map((tag) => `<span class="bookinfo-tag">${esc(tag)}</span>`)
        .join("");

      panel.querySelector("#detail-publisher").textContent = book.publisher || "-";
      panel.querySelector("#detail-published").textContent = format.formatDate(book.published_at) || "-";
      panel.querySelector("#detail-language").textContent = book.language || "-";
      
      const description = panel.querySelector("#description");
      description.innerHTML = format.formatDescriptionHtml(book.description);
      
      dialog.close();
      dialog.remove();
      toast("Book details updated");
      document.dispatchEvent(new CustomEvent("vivant:library-changed"));
    } catch (err) {
      toast("Failed to update: " + err.message);
    }
  });

  dialog.showModal();
}
