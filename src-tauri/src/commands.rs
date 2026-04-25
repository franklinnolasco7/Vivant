use crate::db::DbPool;
use crate::error::{Error, Result as AppResult};
use crate::{epub, library};
use serde::Deserialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use url::Url;

type CommandResult<T> = std::result::Result<T, String>;

// Bridge internal error type to Tauri serializable format (String)
fn into_command_result<T>(result: AppResult<T>) -> CommandResult<T> {
    result.map_err(|e| e.to_string())
}

// ── Import ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn import_epub(
    app: AppHandle,
    pool: State<'_, DbPool>,
    path: String,
) -> CommandResult<library::Book> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(Error::NotFound(format!("file not found: {path}")).to_string());
    }

    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| Error::Io(e.to_string()).to_string())?;

    // Invalidate cached TOC so re-import picks up any structural changes.
    epub::invalidate_toc_cache(p);

    let path_clone = path.clone();
    let meta = tokio::task::spawn_blocking(move || {
        let p_blocking = std::path::Path::new(&path_clone);
        epub::ensure_extracted(p_blocking, &cache_root)?;
        epub::parse_meta(p_blocking, true)
    })
    .await
    .map_err(|e| Error::Io(e.to_string()).to_string())?
    .map_err(|e| e.to_string())?;

    let id = library::add_book(
        &pool,
        &meta.title,
        &meta.author,
        meta.genre.as_deref(),
        meta.description.as_deref(),
        meta.publisher.as_deref(),
        meta.language.as_deref(),
        meta.published_at.as_deref(),
        meta.file_size,
        &path,
        meta.chapter_count,
        meta.cover_data,
    )
    .map_err(|e| e.to_string())?;

    // Parse and cache TOC in DB at import time so opening the book is instant.
    if let Ok(toc) = epub::parse_toc(p) {
        library::save_book_toc(&pool, &id, &toc).ok();
    }

    library::all_books(&pool)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|b| b.id == id)
        .ok_or_else(|| Error::NotFound("book after import".into()).to_string())
}

// ── Library ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_library(pool: State<'_, DbPool>) -> CommandResult<Vec<library::Book>> {
    library::backfill_chapter_counts(&pool).ok();
    library::backfill_book_metadata(&pool).ok();
    library::backfill_book_covers(&pool).ok();
    library::backfill_book_toc(&pool).ok();
    into_command_result(library::all_books(&pool))
}

#[tauri::command]
#[allow(dead_code)]
pub async fn delete_book(
    pool: State<'_, DbPool>,
    book_id: String,
) -> CommandResult<()> {
    into_command_result(library::delete_book(&pool, &book_id))
}

// ── Reading ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_toc(
    pool: State<'_, DbPool>,
    file_path: String,
) -> CommandResult<Vec<epub::TocEntry>> {
    // Try DB cache first (instant), fall back to EPUB parsing.
    if let Ok(Some(toc)) = library::get_book_toc(&pool, &file_path) {
        return Ok(toc);
    }
    into_command_result(epub::parse_toc(std::path::Path::new(&file_path)))
}

#[tauri::command]
pub async fn get_chapter(
    app: AppHandle,
    file_path: String,
    chapter_idx: usize,
) -> CommandResult<epub::ChapterContent> {
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| Error::Io(e.to_string()).to_string())?;
    into_command_result(epub::get_chapter_html_with_cache(
        std::path::Path::new(&file_path),
        chapter_idx,
        &cache_root,
    ))
}

#[tauri::command]
pub async fn resolve_book_link(
    file_path: String,
    current_chapter_idx: usize,
    href: String,
) -> CommandResult<Option<epub::LinkTarget>> {
    into_command_result(epub::resolve_internal_link(
        std::path::Path::new(&file_path),
        current_chapter_idx,
        &href,
    ))
}

#[tauri::command]
pub async fn open_external_url(app: AppHandle, url: String) -> CommandResult<()> {
    let trimmed = url.trim();
    let parsed = Url::parse(trimmed)
        .map_err(|_| Error::InvalidInput("invalid URL".into()).to_string())?;

    let scheme = parsed.scheme().to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https" | "mailto" | "tel") {
        return Err(Error::InvalidInput("unsupported URL scheme".into()).to_string());
    }

    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| Error::Io(e.to_string()).to_string())
}

// ── Progress ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn save_progress(
    pool: State<'_, DbPool>,
    book_id: String,
    chapter_idx: usize,
    scroll_pct: f64,
) -> CommandResult<()> {
    library::touch_book(&pool, &book_id).ok();
    into_command_result(library::save_progress(&pool, &book_id, chapter_idx, scroll_pct))
}

#[tauri::command]
pub async fn get_progress(
    pool: State<'_, DbPool>,
    book_id: String,
) -> CommandResult<Option<library::Progress>> {
    into_command_result(library::get_progress(&pool, &book_id))
}

#[tauri::command]
pub async fn add_reading_time(
    pool: State<'_, DbPool>,
    book_id: String,
    seconds: u64,
) -> CommandResult<()> {
    into_command_result(library::add_reading_time(&pool, &book_id, seconds))
}

// ── Annotations ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct NewAnnotation {
    pub book_id:     String,
    pub chapter_idx: usize,
    pub quote:       String,
    pub quote_html:  Option<String>,
    pub note:        Option<String>,
    pub color:       Option<String>,
}

#[tauri::command]
pub async fn add_annotation(
    pool: State<'_, DbPool>,
    ann: NewAnnotation,
) -> CommandResult<library::Annotation> {
    if ann.quote.trim().is_empty() {
        return Err(Error::InvalidInput("quote cannot be empty".into()).to_string());
    }
    into_command_result(library::add_annotation(
        &pool, &ann.book_id, ann.chapter_idx,
        &ann.quote, ann.quote_html.as_deref(), ann.note.as_deref(),
        ann.color.as_deref().unwrap_or("amber"),
    ))
}

#[tauri::command]
pub async fn get_annotations(
    pool: State<'_, DbPool>,
    book_id: String,
) -> CommandResult<Vec<library::Annotation>> {
    into_command_result(library::get_annotations(&pool, &book_id))
}

#[tauri::command]
pub async fn delete_annotation(
    pool: State<'_, DbPool>,
    annotation_id: String,
) -> CommandResult<()> {
    into_command_result(library::delete_annotation(&pool, &annotation_id))
}

#[allow(dead_code)]
#[derive(Deserialize)]
pub struct AnnotationOrderUpdate {
    pub id: String,
    pub order: i64,
}

#[allow(dead_code)]
#[tauri::command]
pub async fn update_annotation_order(
    pool: State<'_, DbPool>,
    book_id: String,
    orders: Vec<AnnotationOrderUpdate>,
) -> CommandResult<()> {
    let mapped: Vec<(String, i64)> = orders
        .into_iter()
        .map(|o| (o.id, o.order))
        .collect();
    into_command_result(library::update_annotation_order(&pool, &book_id, &mapped))
}

// ── Search ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn search_book(
    file_path: String,
    query: String,
) -> CommandResult<Vec<epub::SearchResult>> {
    if query.trim().is_empty() {
        return Err(Error::InvalidInput("search query cannot be empty".into()).to_string());
    }
    into_command_result(epub::search(std::path::Path::new(&file_path), &query))
}

// ── Window controls — needs `use tauri::Manager` for get_webview_window ───────

#[tauri::command]
pub async fn window_minimize(app: AppHandle) -> CommandResult<()> {
    app.get_webview_window("main")
        .ok_or_else(|| Error::NotFound("main window".into()).to_string())?
        .minimize()
        .map_err(|e| Error::Io(e.to_string()).to_string())
}

#[tauri::command]
pub async fn window_maximize(app: AppHandle) -> CommandResult<()> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| Error::NotFound("main window".into()).to_string())?;
    // Toggle maximize/unmaximize based on current state
    if w.is_maximized().unwrap_or(false) { w.unmaximize() } else { w.maximize() }
        .map_err(|e| Error::Io(e.to_string()).to_string())
}

#[tauri::command]
pub async fn window_close(app: AppHandle) -> CommandResult<()> {
    app.get_webview_window("main")
        .ok_or_else(|| Error::NotFound("main window".into()).to_string())?
        .close()
        .map_err(|e| Error::Io(e.to_string()).to_string())
}
