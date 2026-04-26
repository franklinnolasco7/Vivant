/** Centralizes all Tauri command calls and normalizes backend errors. */
import { invoke } from "@tauri-apps/api/core";

// --- Helpers ---

/**
 * Wrap invoke call: map structured Rust { kind, message } errors to plain strings.
 * Simplifies error handling on frontend (don't need to check error.kind everywhere).
 */
async function call(cmd, args = {}) {
  try {
    return await invoke(cmd, args);
  } catch (err) {
    // Structured error from our thiserror enum
    if (err && typeof err === "object" && err.message) {
      throw new Error(`[${err.kind ?? "Error"}] ${err.message}`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// --- Library ---

/** Returns all books ordered by last_opened DESC. */
export const getLibrary = () => call("get_library");

/**
 * Import an EPUB file by absolute path.
 * @param {string} path  Absolute filesystem path to the .epub file
 * @returns {Promise<Book>}
 */
export const importEpub = (path) => call("import_epub", { path });

/**
 * Delete multiple books from the library.
 * @param {string[]} bookIds
 */
export const deleteBooks = (bookIds) => call("delete_books", { bookIds });

/**
 * Update book metadata.
 * @param {{ id:string, title:string, author:string, genre?:string|null, description?:string|null, publisher?:string|null, language?:string|null, published_at?:string|null }} update
 */
export const updateBookMetadata = (update) => call("update_book_metadata", { update });

// --- Reading ---

/**
 * @param {string} filePath
 * @returns {Promise<TocEntry[]>}
 */
export const getToc = (filePath) => call("get_toc", { filePath });

/**
 * @param {string} filePath
 * @param {number} chapterIdx
 * @returns {Promise<ChapterContent>}
 */
export const getChapter = (filePath, chapterIdx) =>
  call("get_chapter", { filePath, chapterIdx });

/**
 * Resolve an EPUB hyperlink against the current chapter.
 * @param {string} filePath
 * @param {number} currentChapterIdx
 * @param {string} href
 * @returns {Promise<LinkTarget|null>}
 */
export const resolveBookLink = (filePath, currentChapterIdx, href) =>
  call("resolve_book_link", { filePath, currentChapterIdx, href });

/**
 * Open an external URL in the system default handler (browser/mail app/etc).
 * @param {string} url
 */
export const openExternalUrl = (url) => call("open_external_url", { url });

// --- Progress ---

export const saveProgress = (bookId, chapterIdx, scrollPct) =>
  call("save_progress", { bookId, chapterIdx, scrollPct });

export const getProgress = (bookId) => call("get_progress", { bookId });
export const addReadingTime = (bookId, seconds) => call("add_reading_time", { bookId, seconds });

// --- Annotations ---

/**
 * @param {{ bookId, chapterIdx, quote, quoteHtml?, note?, color? }} ann
 * @returns {Promise<Annotation>}
 */
export const addAnnotation = ({ bookId, chapterIdx, quote, quoteHtml, note, color }) =>
  call("add_annotation", {
    ann: {
      book_id: bookId,
      chapter_idx: chapterIdx,
      quote,
      quote_html: quoteHtml ?? null,
      note,
      color,
    },
  });

export const getAnnotations = (bookId) => call("get_annotations", { bookId });

export const updateAnnotationOrder = (bookId, orders) =>
  call("update_annotation_order", { bookId, orders });

export const deleteAnnotation = (annotationId) =>
  call("delete_annotation", { annotationId });

// --- Search ---

/**
 * @param {string} filePath
 * @param {string} query
 * @returns {Promise<SearchResult[]>}
 */
export const searchBook = (filePath, query) =>
  call("search_book", { filePath, query });

// --- Window controls ---

export const windowMinimize = () => call("window_minimize");
export const windowMaximize = () => call("window_maximize");
export const windowClose = () => call("window_close");

// --- JSDoc types for editor IntelliSense ---

/**
 * @typedef {{ id:string, title:string, author:string, file_path:string,
 *             genre?:string|null, description?:string|null, publisher?:string|null,
 *             language?:string|null, published_at?:string|null, file_size?:number|null,
 *             reading_seconds?:number,
 *             cover_b64:string|null, added_at:string, last_opened:string|null,
 *             progress_chapter:number, progress_pct:number }} Book
 *
 * @typedef {{ label:string, chapter_idx:number, depth:number, anchor?:string|null }} TocEntry
 *
 * @typedef {{ index:number, title:string, html:string }} ChapterContent

 * @typedef {{ chapter_idx:number, anchor?:string|null }} LinkTarget
 *
 * @typedef {{ id:string, book_id:string, chapter_idx:number,
 *             quote:string, quote_html:string|null, note:string|null, color:string,
 *             ann_order:number, created_at:string }} Annotation
 *
 * @typedef {{ chapter_idx:number, snippet:string,
 *             match_start:number, match_len:number }} SearchResult
 */
