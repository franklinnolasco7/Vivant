use crate::db::DbPool;
use crate::epub;
use crate::error::{Error, Result};
use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Book {
    pub id: String,
    pub title: String,
    pub author: String,
    pub genre: Option<String>,
    pub description: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub published_at: Option<String>,
    pub file_size: Option<u64>,
    pub file_path: String,
    pub chapter_count: usize,
    /// `data:image/jpeg;base64,…` or None
    pub cover_b64: Option<String>,
    pub reading_seconds: u64,
    pub added_at: String,
    pub last_opened: Option<String>,
    pub progress_chapter: usize,
    pub progress_pct: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Progress {
    pub book_id: String,
    pub chapter_idx: usize,
    pub scroll_pct: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Annotation {
    pub id: String,
    pub book_id: String,
    pub chapter_idx: usize,
    pub quote: String,
    pub quote_html: Option<String>,
    pub note: Option<String>,
    pub color: String,
    pub ann_order: i64,
    pub created_at: String,
}

// ── Books ─────────────────────────────────────────────────────────────────────

pub fn add_book(
    pool: &DbPool,
    title: &str,
    author: &str,
    genre: Option<&str>,
    description: Option<&str>,
    publisher: Option<&str>,
    language: Option<&str>,
    published_at: Option<&str>,
    file_size: Option<u64>,
    file_path: &str,
    chapter_count: usize,
    cover_data: Option<Vec<u8>>,
) -> Result<String> {
    let conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO books (
            id, title, author, genre, description, publisher, language,
            published_at, file_size, file_path, chapter_count, cover_data, added_at
         )
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
         ON CONFLICT(file_path) DO UPDATE SET
           title=excluded.title,
           author=excluded.author,
           genre=excluded.genre,
           description=excluded.description,
           publisher=excluded.publisher,
           language=excluded.language,
           published_at=excluded.published_at,
           file_size=excluded.file_size,
           chapter_count=excluded.chapter_count,
           cover_data=COALESCE(excluded.cover_data, books.cover_data)",
        params![
            id,
            title,
            author,
            genre,
            description,
            publisher,
            language,
            published_at,
            file_size.map(|v| v as i64),
            file_path,
            chapter_count as i64,
            cover_data,
            now
        ],
    )?;
    // Id may differ after ON CONFLICT UPDATE
    let actual_id: String = conn.query_row(
        "SELECT id FROM books WHERE file_path = ?1",
        params![file_path],
        |r| r.get(0),
    )?;
    Ok(actual_id)
}

pub fn all_books(pool: &DbPool) -> Result<Vec<Book>> {
    let conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT b.id, b.title, b.author, b.genre, b.description,
                b.publisher, b.language, b.published_at, b.file_size,
                b.file_path, b.cover_data, b.chapter_count,
                b.reading_seconds, b.added_at, b.last_opened,
                COALESCE(p.chapter_idx, 0),
                COALESCE(
                    CASE
                        WHEN p.book_id IS NULL THEN 0
                        WHEN b.chapter_count <= 1 THEN MIN(100, MAX(0, p.scroll_pct * 100.0))
                        ELSE MIN(100, MAX(0, ((p.chapter_idx + p.scroll_pct) * 100.0) / (b.chapter_count - 1)))
                    END,
                    0
                )
         FROM books b
         LEFT JOIN progress p ON p.book_id = b.id
         ORDER BY b.last_opened DESC, b.added_at DESC",
    )?;
    // For single-chapter books, progress is scroll_pct alone; for multi-chapter, interpolate across chapters

    let rows = stmt.query_map([], |r| {
        let raw: Option<Vec<u8>> = r.get(10)?;
        let cover_b64 = raw.map(|d: Vec<u8>| {
            let mime = detect_mime(&d);
            let mut s = format!("data:{};base64,", mime);
            b64_push(&d, &mut s);
            s
        });
        Ok(Book {
            id:               r.get(0)?,
            title:            r.get(1)?,
            author:           r.get(2)?,
            genre:            r.get(3)?,
            description:      r.get(4)?,
            publisher:        r.get(5)?,
            language:         r.get(6)?,
            published_at:     r.get(7)?,
            file_size:        r.get::<_, Option<i64>>(8)?.map(|v| v as u64),
            file_path:        r.get(9)?,
            chapter_count:    r.get::<_, i64>(11)? as usize,
            cover_b64,
            reading_seconds:  r.get::<_, i64>(12)? as u64,
            added_at:         r.get(13)?,
            last_opened:      r.get(14)?,
            progress_chapter: r.get::<_, i64>(15)? as usize,
            progress_pct:     r.get(16)?,
        })
    })?;

    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn backfill_chapter_counts(pool: &DbPool) -> Result<()> {
    let conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;

    let mut stmt = conn.prepare(
        "SELECT id, file_path, chapter_count FROM books WHERE chapter_count <= 1",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)? as usize,
        ))
    })?;

    let items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    for (id, file_path, old_count) in items {
        let path = std::path::Path::new(&file_path);
        if !path.exists() {
            continue;
        }
        let Ok(meta) = epub::parse_meta(path, false) else {
            continue;
        };
        if meta.chapter_count > old_count {
            let _ = conn.execute(
                "UPDATE books SET chapter_count = ?1 WHERE id = ?2",
                params![meta.chapter_count as i64, id],
            );
        }
    }

    Ok(())
}

pub fn backfill_book_metadata(pool: &DbPool) -> Result<()> {
    let conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;

    let mut stmt = conn.prepare(
        "SELECT id, file_path
         FROM books
         WHERE genre IS NULL
            OR description IS NULL
            OR publisher IS NULL
            OR language IS NULL
            OR published_at IS NULL
            OR file_size IS NULL",
    )?;

    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
        ))
    })?;

    let items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    for (id, file_path) in items {
        let path = std::path::Path::new(&file_path);
        if !path.exists() {
            continue;
        }

        let Ok(meta) = epub::parse_meta(path, false) else {
            continue;
        };

        let _ = conn.execute(
            "UPDATE books
             SET genre = COALESCE(genre, ?1),
                 description = COALESCE(description, ?2),
                 publisher = COALESCE(publisher, ?3),
                 language = COALESCE(language, ?4),
                 published_at = COALESCE(published_at, ?5),
                 file_size = COALESCE(file_size, ?6)
             WHERE id = ?7",
            params![
                meta.genre,
                meta.description,
                meta.publisher,
                meta.language,
                meta.published_at,
                meta.file_size.map(|v| v as i64),
                id,
            ],
        );
    }

    Ok(())
}

pub fn update_book_metadata(
    pool: &DbPool,
    id: &str,
    title: &str,
    author: &str,
    genre: Option<&str>,
    description: Option<&str>,
    publisher: Option<&str>,
    language: Option<&str>,
    published_at: Option<&str>,
) -> Result<()> {
    let conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;
    let updated = conn.execute(
        "UPDATE books SET
           title = ?1,
           author = ?2,
           genre = ?3,
           description = ?4,
           publisher = ?5,
           language = ?6,
           published_at = ?7
         WHERE id = ?8",
        params![
            title,
            author,
            genre,
            description,
            publisher,
            language,
            published_at,
            id
        ],
    )?;
    if updated == 0 {
        return Err(Error::NotFound(format!("book {id}")));
    }
    Ok(())
}

pub fn backfill_book_covers(pool: &DbPool) -> Result<()> {
    let conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;

    let mut stmt = conn.prepare(
        "SELECT id, file_path
         FROM books
         WHERE cover_data IS NULL",
    )?;

    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
        ))
    })?;

    let items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    for (id, file_path) in items {
        let path = std::path::Path::new(&file_path);
        if !path.exists() {
            continue;
        }

        let Ok(meta) = epub::parse_meta(path, true) else {
            continue;
        };

        let Some(cover_data) = meta.cover_data else {
            continue;
        };

        let _ = conn.execute(
            "UPDATE books SET cover_data = ?1 WHERE id = ?2",
            params![cover_data, id],
        );
    }

    Ok(())
}

// ── TOC persistence ───────────────────────────────────────────────────────────

/// Store parsed TOC as JSON so subsequent opens skip EPUB parsing entirely.
pub fn save_book_toc(pool: &DbPool, book_id: &str, toc: &[epub::TocEntry]) -> Result<()> {
    let conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;
    let json = serde_json::to_string(toc).map_err(|e| Error::Db(e.to_string()))?;
    conn.execute(
        "UPDATE books SET toc_json = ?1 WHERE id = ?2",
        params![json, book_id],
    )?;
    Ok(())
}

/// Load cached TOC from DB. Returns None if not yet cached.
pub fn get_book_toc(pool: &DbPool, file_path: &str) -> Result<Option<Vec<epub::TocEntry>>> {
    let conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT toc_json FROM books WHERE file_path = ?1 AND toc_json IS NOT NULL",
    )?;
    let mut rows = stmt.query(params![file_path])?;
    match rows.next()? {
        Some(row) => {
            let json: String = row.get(0)?;
            let entries: Vec<epub::TocEntry> =
                serde_json::from_str(&json).map_err(|e| Error::Db(e.to_string()))?;
            Ok(Some(entries))
        }
        None => Ok(None),
    }
}

/// Backfill TOC JSON for books that were imported before this feature existed.
pub fn backfill_book_toc(pool: &DbPool) -> Result<()> {
    let conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT id, file_path FROM books WHERE toc_json IS NULL",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    for (id, file_path) in items {
        let path = std::path::Path::new(&file_path);
        if !path.exists() {
            continue;
        }
        let Ok(toc) = epub::parse_toc(path) else {
            continue;
        };
        let json = match serde_json::to_string(&toc) {
            Ok(j) => j,
            Err(_) => continue,
        };
        let _ = conn.execute(
            "UPDATE books SET toc_json = ?1 WHERE id = ?2",
            params![json, id],
        );
    }

    Ok(())
}

pub fn touch_book(pool: &DbPool, id: &str) -> Result<()> {
    let conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE books SET last_opened = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    Ok(())
}

// ── Progress ──────────────────────────────────────────────────────────────────

pub fn save_progress(
    pool: &DbPool,
    book_id: &str,
    chapter_idx: usize,
    scroll_pct: f64,
) -> Result<()> {
    let conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO progress (book_id, chapter_idx, scroll_pct, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(book_id) DO UPDATE SET
           chapter_idx = excluded.chapter_idx,
           scroll_pct  = excluded.scroll_pct,
           updated_at  = excluded.updated_at",
        params![book_id, chapter_idx as i64, scroll_pct, now],
    )?;
    Ok(())
}

pub fn get_progress(pool: &DbPool, book_id: &str) -> Result<Option<Progress>> {
    let conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT chapter_idx, scroll_pct FROM progress WHERE book_id = ?1",
    )?;
    let mut rows = stmt.query(params![book_id])?;
    Ok(rows.next()?.map(|r| Progress {
        book_id:     book_id.to_owned(),
        chapter_idx: r.get::<_, i64>(0).unwrap_or(0) as usize,
        scroll_pct:  r.get(1).unwrap_or(0.0),
    }))
}

pub fn add_reading_time(pool: &DbPool, book_id: &str, seconds: u64) -> Result<()> {
    // Skip no-op updates to avoid unnecessary DB round-trips
    if seconds == 0 {
        return Ok(());
    }
    let conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;
    let updated = conn.execute(
        "UPDATE books
         SET reading_seconds = COALESCE(reading_seconds, 0) + ?1,
             last_opened = ?2
         WHERE id = ?3",
        params![seconds as i64, Utc::now().to_rfc3339(), book_id],
    )?;
    if updated == 0 {
        return Err(Error::NotFound(format!("book {book_id}")));
    }
    Ok(())
}

// ── Annotations ───────────────────────────────────────────────────────────────

pub fn add_annotation(
    pool: &DbPool,
    book_id: &str,
    chapter_idx: usize,
    quote: &str,
    quote_html: Option<&str>,
    note: Option<&str>,
    color: &str,
) -> Result<Annotation> {
    let conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;
    let id  = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let ann_order = Utc::now().timestamp();
    conn.execute(
        "INSERT INTO annotations
         (id, book_id, chapter_idx, quote, quote_html, note, color, created_at, ann_order)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![id, book_id, chapter_idx as i64, quote, quote_html, note, color, now, ann_order],
    )?;
    Ok(Annotation {
        id,
        book_id:     book_id.to_owned(),
        chapter_idx,
        quote:       quote.to_owned(),
        quote_html:  quote_html.map(str::to_owned),
        note:        note.map(str::to_owned),
        color:       color.to_owned(),
        ann_order,
        created_at:  now,
    })
}

pub fn get_annotations(pool: &DbPool, book_id: &str) -> Result<Vec<Annotation>> {
    let conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT id, chapter_idx, quote, quote_html, note, color, ann_order, created_at
         FROM annotations
         WHERE book_id = ?1
         ORDER BY ann_order, created_at",
    )?;
    let rows = stmt.query_map(params![book_id], |r| {
        Ok(Annotation {
            id:          r.get(0)?,
            book_id:     book_id.to_owned(),
            chapter_idx: r.get::<_, i64>(1)? as usize,
            quote:       r.get(2)?,
            quote_html:  r.get(3)?,
            note:        r.get(4)?,
            color:       r.get(5)?,
            ann_order:   r.get::<_, i64>(6)?,
            created_at:  r.get(7)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[allow(dead_code)]
pub fn update_annotation_order(
    pool: &DbPool,
    book_id: &str,
    orders: &[(String, i64)],
) -> Result<()> {
    if orders.is_empty() {
        return Ok(());
    }
    let mut conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;
    let tx = conn.transaction().map_err(|e| Error::Db(e.to_string()))?;

    for (id, order) in orders {
        tx.execute(
            "UPDATE annotations SET ann_order = ?1 WHERE id = ?2 AND book_id = ?3",
            params![order, id, book_id],
        )?;
    }

    tx.commit().map_err(|e| Error::Db(e.to_string()))?;
    Ok(())
}

pub fn delete_annotation(pool: &DbPool, id: &str) -> Result<()> {
    let conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;
    let deleted = conn.execute("DELETE FROM annotations WHERE id = ?1", params![id])?;
    if deleted == 0 {
        return Err(Error::NotFound(format!("annotation {id}")));
    }
    Ok(())
}

#[allow(dead_code)]
pub fn delete_books(pool: &DbPool, ids: &[String]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;
    let tx = conn.transaction().map_err(|e| Error::Db(e.to_string()))?;

    for id in ids {
        tx.execute("DELETE FROM books WHERE id = ?1", params![id])?;
        tx.execute("DELETE FROM annotations WHERE book_id = ?1", params![id])?;
        tx.execute("DELETE FROM progress WHERE book_id = ?1", params![id])?;
    }

    tx.commit().map_err(|e| Error::Db(e.to_string()))?;
    Ok(())
}

// ── Minimal base-64 encoder ───────────────────────────────────────────────────

fn b64_push(data: &[u8], out: &mut String) {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut i = 0;
    while i + 2 < data.len() {
        let n = ((data[i] as u32) << 16)
            | ((data[i + 1] as u32) << 8)
            | data[i + 2] as u32;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(T[((n >>  6) & 63) as usize] as char);
        out.push(T[( n        & 63) as usize] as char);
        i += 3;
    }
    if i < data.len() {
        let n = (data[i] as u32) << 16
            | if i + 1 < data.len() { (data[i + 1] as u32) << 8 } else { 0 };
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        if i + 1 < data.len() { out.push(T[((n >> 6) & 63) as usize] as char); }
        else { out.push('='); }
        out.push('=');
    }
}

fn detect_mime(data: &[u8]) -> &'static str {
    if data.is_empty() {
        return "application/octet-stream";
    }

    if data.starts_with(b"\x89PNG") {
        return "image/png";
    } else if data.starts_with(b"\xff\xd8") {
        return "image/jpeg";
    } else if data.starts_with(b"GIF8") {
        return "image/gif";
    } else if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
        return "image/webp";
    } else if data.starts_with(b"BM") {
        return "image/bmp";
    } else if data.starts_with(b"<?xml") || data.starts_with(b"<svg") {
        return "image/svg+xml";
    }

    if let Ok(s) = std::str::from_utf8(&data[..core::cmp::min(100, data.len())]) {
        if s.contains("<svg") {
            return "image/svg+xml";
        }
    }

    "image/jpeg"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use r2d2::Pool;
    use r2d2_sqlite::SqliteConnectionManager;

    fn mem_pool() -> DbPool {
        let manager = SqliteConnectionManager::memory().with_init(|conn| {
            conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
        });
        let pool = Pool::builder().max_size(2).build(manager).expect("test pool");
        db::migrate(&pool).expect("migrations");
        pool
    }

    #[test]
    fn add_book_then_list_library() {
        let pool = mem_pool();
        let file_path = "/tmp/vivant-test-book.epub";

        let id = add_book(
            &pool,
            "Test Title",
            "Test Author",
            None,
            None,
            None,
            None,
            None,
            None,
            file_path,
            12,
            None,
        )
        .expect("add book");

        let books = all_books(&pool).expect("list books");
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].id, id);
        assert_eq!(books[0].title, "Test Title");
        assert_eq!(books[0].author, "Test Author");
        assert_eq!(books[0].chapter_count, 12);
        assert_eq!(books[0].progress_pct, 0.0);
    }

    #[test]
    fn save_progress_then_read_progress() {
        let pool = mem_pool();
        let file_path = "/tmp/vivant-progress-book.epub";

        let id = add_book(
            &pool,
            "Progress Book",
            "Author",
            None,
            None,
            None,
            None,
            None,
            None,
            file_path,
            10,
            None,
        )
        .expect("add book");

        save_progress(&pool, &id, 3, 0.5).expect("save progress");
        let progress = get_progress(&pool, &id).expect("get progress").expect("progress row");

        assert_eq!(progress.book_id, id);
        assert_eq!(progress.chapter_idx, 3);
        assert!((progress.scroll_pct - 0.5).abs() < f64::EPSILON);

        let books = all_books(&pool).expect("list books");
        assert_eq!(books.len(), 1);
        assert!(books[0].progress_pct > 0.0);
    }
}
