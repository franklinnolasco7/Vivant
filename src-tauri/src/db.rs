use crate::error::{Error, Result};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::params;
use std::path::Path;

pub type DbPool = Pool<SqliteConnectionManager>;

pub fn init(app_dir: &Path) -> Result<DbPool> {
    let manager = SqliteConnectionManager::file(app_dir.join("vivant.db"))
        .with_init(|conn| {
            conn.execute_batch("
                PRAGMA journal_mode = WAL;
                PRAGMA foreign_keys = ON;
                PRAGMA synchronous   = NORMAL;
                PRAGMA busy_timeout  = 5000;
            ")
        });

    let pool = Pool::builder()
        .max_size(4)
        .build(manager)
        .map_err(|e| Error::Db(e.to_string()))?;

    migrate(&pool)?;
    Ok(pool)
}

pub fn migrate(pool: &DbPool) -> Result<()> {
    let conn = pool.get().map_err(|e| Error::Db(e.to_string()))?;

    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS _migrations (
            version    INTEGER PRIMARY KEY,
            applied_at TEXT    NOT NULL
        );
    ")?;

    let migrations: &[(i64, &str)] = &[
        (1, "
            CREATE TABLE IF NOT EXISTS books (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL,
                author      TEXT NOT NULL DEFAULT '',
                file_path   TEXT NOT NULL UNIQUE,
                cover_data  BLOB,
                added_at    TEXT NOT NULL,
                last_opened TEXT
            );
            CREATE TABLE IF NOT EXISTS progress (
                book_id     TEXT    NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                chapter_idx INTEGER NOT NULL DEFAULT 0,
                scroll_pct  REAL    NOT NULL DEFAULT 0,
                updated_at  TEXT    NOT NULL,
                PRIMARY KEY (book_id)
            );
            CREATE TABLE IF NOT EXISTS annotations (
                id          TEXT    PRIMARY KEY,
                book_id     TEXT    NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                chapter_idx INTEGER NOT NULL,
                quote       TEXT    NOT NULL,
                note        TEXT,
                color       TEXT    NOT NULL DEFAULT 'amber',
                created_at  TEXT    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_ann_book ON annotations(book_id);
        "),
        (2, "
            ALTER TABLE books ADD COLUMN chapter_count INTEGER NOT NULL DEFAULT 1;
        "),
        (3, "
            ALTER TABLE books ADD COLUMN genre TEXT;
            ALTER TABLE books ADD COLUMN description TEXT;
            ALTER TABLE books ADD COLUMN publisher TEXT;
            ALTER TABLE books ADD COLUMN language TEXT;
            ALTER TABLE books ADD COLUMN published_at TEXT;
            ALTER TABLE books ADD COLUMN file_size INTEGER;
        "),
        (4, "
            ALTER TABLE books ADD COLUMN reading_seconds INTEGER NOT NULL DEFAULT 0;
        "),
        (5, "
            ALTER TABLE annotations ADD COLUMN quote_html TEXT;
        "),
        (6, "
            ALTER TABLE annotations ADD COLUMN ann_order INTEGER NOT NULL DEFAULT 0;
            UPDATE annotations
            SET ann_order = COALESCE(CAST(strftime('%s', created_at) AS INTEGER), 0)
            WHERE ann_order = 0;
            CREATE INDEX IF NOT EXISTS idx_ann_order ON annotations(book_id, ann_order);
        "),
    ];

    let now = chrono::Utc::now().to_rfc3339();

    for (version, sql) in migrations {
        let already: bool = conn.query_row(
            "SELECT COUNT(*) FROM _migrations WHERE version = ?1",
            params![version],
            |r| r.get::<_, i64>(0),
        )? > 0;

        if !already {
            conn.execute_batch(sql)?;
            conn.execute(
                "INSERT INTO _migrations (version, applied_at) VALUES (?1, ?2)",
                params![version, now],
            )?;
        }
    }

    Ok(())
}
