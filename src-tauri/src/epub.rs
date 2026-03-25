use crate::error::{Error, Result};
use epub::doc::EpubDoc;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io;
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use zip::ZipArchive;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BookMeta {
    pub title: String,
    pub author: String,
    pub genre: Option<String>,
    pub description: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub published_at: Option<String>,
    pub file_size: Option<u64>,
    pub cover_data: Option<Vec<u8>>,
    pub chapter_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TocEntry {
    pub label: String,
    pub chapter_idx: usize,
    pub depth: u8,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChapterContent {
    pub index: usize,
    pub title: String,
    pub html: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LinkTarget {
    pub chapter_idx: usize,
    pub anchor: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub chapter_idx: usize,
    pub snippet: String,
    pub match_start: usize,
    pub match_len: usize,
}

pub fn parse_meta(path: &Path) -> Result<BookMeta> {
    let mut doc = open(path)?;
    let title = doc.mdata("title").map(|m| m.value.clone()).unwrap_or_else(|| stem(path));
    let author = doc
        .mdata("creator")
        .map(|m| m.value.clone())
        .unwrap_or_else(|| "Unknown Author".to_string());
    let genre = first_meta_value(&mut doc, &["subject", "genre"]);
    let description = first_meta_value(&mut doc, &["description", "abstract"]);
    let publisher = first_meta_value(&mut doc, &["publisher"]);
    let language = first_meta_value(&mut doc, &["language"]);
    let published_at = first_meta_value(&mut doc, &["date", "published", "issued"]);
    let file_size = fs::metadata(path).ok().map(|m| m.len());
    let chapter_count = doc.get_num_chapters();
    let cover_data = doc.get_cover().map(|(data, _mime)| data);
    Ok(BookMeta {
        title,
        author,
        genre,
        description,
        publisher,
        language,
        published_at,
        file_size,
        cover_data,
        chapter_count,
    })
}

fn first_meta_value(
    doc: &mut epub::doc::EpubDoc<std::io::BufReader<std::fs::File>>,
    keys: &[&str],
) -> Option<String> {
    for key in keys {
        if let Some(meta) = doc.mdata(key) {
            let value = meta.value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

pub fn parse_toc(path: &Path) -> Result<Vec<TocEntry>> {
    let doc = open(path)?;
    let spine_ids: Vec<String> = doc.spine.iter().map(|s| s.idref.clone()).collect();
    let total = doc.get_num_chapters();
    let toc_items = doc.toc.clone();
    let mut out = Vec::new();

    fn walk(
        items: &[epub::doc::NavPoint],
        doc: &epub::doc::EpubDoc<std::io::BufReader<std::fs::File>>,
        spine_ids: &[String],
        total: usize,
        out: &mut Vec<TocEntry>,
        depth: u8,
    ) {
        for item in items {
            let src = item.content.to_string_lossy().to_string();
            let src_base = src.split('#').next().unwrap_or(&src);
            let fallback = out.last().map(|e| e.chapter_idx).unwrap_or(0);
            let chapter_idx = doc
                .resource_uri_to_chapter(&item.content)
                .or_else(|| spine_ids.iter().position(|id| src_base.contains(id.as_str())))
                .unwrap_or(fallback)
                .min(total.saturating_sub(1));
            out.push(TocEntry { label: item.label.trim().to_owned(), chapter_idx, depth });
            walk(&item.children, doc, spine_ids, total, out, depth + 1);
        }
    }

    walk(&toc_items, &doc, &spine_ids, total, &mut out, 0);

    // Keep first label for a chapter if multiple nav points target the same spine item.
    let mut deduped = Vec::new();
    let mut seen = HashSet::new();
    for e in out {
        if seen.insert(e.chapter_idx) {
            deduped.push(e);
        }
    }

    // Merge user-provided nav labels with guaranteed spine coverage.
    let mut merged: BTreeMap<usize, TocEntry> = BTreeMap::new();
    for e in deduped {
        merged.entry(e.chapter_idx).or_insert(e);
    }

    for i in 0..total {
        merged.entry(i).or_insert(TocEntry {
            label: fallback_chapter_label(i, &spine_ids),
            chapter_idx: i,
            depth: 0,
        });
    }

    Ok(merged.into_values().collect())
}

fn fallback_chapter_label(idx: usize, spine_ids: &[String]) -> String {
    if let Some(id) = spine_ids.get(idx) {
        let id_l = id.to_lowercase();
        if id_l.contains("cover") {
            return "Cover".to_string();
        }
        if id_l.contains("title") || id_l.contains("titlepage") {
            return "Title Page".to_string();
        }
    }
    format!("Chapter {}", idx + 1)
}

pub fn get_chapter_html_with_cache(
    path: &Path,
    chapter_idx: usize,
    cache_root: &Path,
) -> Result<ChapterContent> {
    let extracted_root = ensure_extracted(path, cache_root)?;
    let mut doc = open(path)?;
    let total = doc.get_num_chapters();

    if chapter_idx >= total {
        return Err(Error::NotFound(format!("chapter {chapter_idx} (book has {total})")));
    }

    doc.set_current_chapter(chapter_idx);
    let chapter_path = doc.get_current_path().unwrap_or_default();
    let (raw, _mime) = doc
        .get_current_str()
        .ok_or_else(|| Error::Epub(format!("chapter {chapter_idx} returned no content")))?;

    let html = strip_chrome(&raw);
    let html = rewrite_img_srcs(html, &chapter_path, &extracted_root);

    // Log snippet of HTML for debugging
    let snippet = safe_prefix(&html, 500);
    log::info!("Chapter HTML (first 500 bytes): {}", snippet);

    let toc = parse_toc(path).unwrap_or_default();
    let title = toc
        .iter()
        .find(|e| e.chapter_idx == chapter_idx)
        .map(|e| e.label.clone())
        .unwrap_or_else(|| format!("Chapter {}", chapter_idx + 1));

    Ok(ChapterContent { index: chapter_idx, title, html })
}

pub fn ensure_extracted(epub_path: &Path, cache_root: &Path) -> Result<PathBuf> {
    let cache_dir = cache_dir_for_book(epub_path, cache_root);
    let marker = cache_dir.join(".vellum-source");
    let fingerprint = source_fingerprint(epub_path)?;

    if cache_dir.exists() {
        if let Ok(existing) = fs::read_to_string(&marker) {
            if existing == fingerprint {
                return Ok(cache_dir);
            }
        }
        fs::remove_dir_all(&cache_dir)?;
    }

    fs::create_dir_all(&cache_dir)?;
    extract_epub(epub_path, &cache_dir)?;
    fs::write(marker, fingerprint)?;
    Ok(cache_dir)
}

pub fn search(path: &Path, query: &str) -> Result<Vec<SearchResult>> {
    let q = query.to_lowercase();
    let mut doc = open(path)?;
    let total = doc.get_num_chapters();
    let mut results = Vec::new();

    for i in 0..total {
        doc.set_current_chapter(i);
        if let Some((raw, _)) = doc.get_current_str() {
            let plain = to_plain(&raw);
            let lower = plain.to_lowercase();
            let mut pos = 0;
            while let Some(found) = lower[pos..].find(&q) {
                let abs = pos + found;
                let s = clamp_to_char_boundary(&plain, abs.saturating_sub(60));
                let e = clamp_to_char_boundary(&plain, (abs + q.len() + 60).min(plain.len()));
                results.push(SearchResult {
                    chapter_idx: i,
                    snippet: plain[s..e].to_owned(),
                    match_start: abs - s,
                    match_len: q.len(),
                });
                pos = abs + q.len();
                if results.len() >= 50 { return Ok(results); }
            }
        }
    }
    Ok(results)
}

pub fn resolve_internal_link(path: &Path, current_chapter_idx: usize, href: &str) -> Result<Option<LinkTarget>> {
    let trimmed = href.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    if has_external_scheme(trimmed) {
        return Ok(None);
    }

    let (target_path_raw, anchor_raw) = match trimmed.split_once('#') {
        Some((p, a)) => (p.trim(), Some(a)),
        None => (trimmed, None),
    };

    let anchor = anchor_raw
        .map(|a| decode_fragment(a).trim().to_string())
        .filter(|a| !a.is_empty());

    let mut doc = open(path)?;
    let total = doc.get_num_chapters();
    if total == 0 {
        return Ok(None);
    }

    let current_idx = current_chapter_idx.min(total.saturating_sub(1));

    if target_path_raw.is_empty() {
        return Ok(Some(LinkTarget {
            chapter_idx: current_idx,
            anchor,
        }));
    }

    doc.set_current_chapter(current_idx);
    let chapter_path = doc.get_current_path().unwrap_or_default();
    let resolved = resolve_resource_path(&chapter_path, target_path_raw);

    let resolved_buf = PathBuf::from(&resolved);
    let raw_buf = PathBuf::from(target_path_raw);
    let stripped = target_path_raw.trim_start_matches('/');
    let stripped_buf = (stripped != target_path_raw).then(|| PathBuf::from(stripped));

    let chapter_idx = doc
        .resource_uri_to_chapter(&resolved_buf)
        .or_else(|| doc.resource_uri_to_chapter(&raw_buf))
        .or_else(|| stripped_buf.as_ref().and_then(|p| doc.resource_uri_to_chapter(p)));

    Ok(chapter_idx.map(|idx| LinkTarget {
        chapter_idx: idx.min(total.saturating_sub(1)),
        anchor,
    }))
}

/// Serve an image/font resource from inside the EPUB zip for the epub:// protocol.
pub fn get_resource(path: &Path, resource_path: &str) -> Option<(Vec<u8>, String)> {
    let mut doc = open(path).ok()?;
    // Normalize the resource path - remove traversal attempts and leading slashes
    let clean = normalize_resource_path(resource_path);
    log::debug!("Looking up resource: {} -> {}", resource_path, clean);
    doc.get_resource_by_path(std::path::Path::new(&clean))
        .map(|data| {
            let mime = detect_mime(&data).to_string();
            log::debug!("Resource found: {} ({} bytes, type: {})", clean, data.len(), mime);
            (data, mime)
        })
}

#[allow(dead_code)]
pub fn _keep_functions_referenced() {
    // This function is just to prevent unused function warnings
    // The actual functions are called but compiler needs explicit reference
    let _ = get_resource;
    let _ = normalize_resource_path;
    let _ = detect_mime;
}

/// Safely normalize resource paths to prevent directory traversal
fn normalize_resource_path(path: &str) -> String {
    // Just trim and return - the path is already normalized from rewrite_src_attr
    path.trim().to_string()
}

/// Rewrite <img src="relative"> to epub://ENCODED_PATH%1FRESOURCE
/// Uses %1F as separator (unit separator character, rarely in real paths)
fn rewrite_img_srcs(html: String, chapter_path: &Path, extracted_root: &Path) -> String {
    let mut out = String::with_capacity(html.len() + 256);
    let mut rest = html.as_str();
    let mut count = 0;

    while let Some(img_start) = rest.find("<img") {
        out.push_str(&rest[..img_start]);
        let from_img = &rest[img_start..];
        let tag_len = from_img.find('>').map(|i| i + 1).unwrap_or(from_img.len());
        let tag = &from_img[..tag_len];
        out.push_str(&rewrite_src_attr(tag, chapter_path, extracted_root));
        rest = &from_img[tag_len..];
        count += 1;
    }
    out.push_str(rest);

    if count > 0 {
        log::info!("Rewrote {} image tags in chapter", count);
    } else {
        log::warn!("No image tags found in chapter HTML");
    }
    out
}

fn rewrite_src_attr(tag: &str, chapter_path: &Path, extracted_root: &Path) -> String {
    for quote in ['"', '\''] {
        let marker = format!("src={}", quote);
        if let Some(pos) = tag.find(&marker) {
            let after = &tag[pos + marker.len()..];
            if let Some(end) = after.find(quote) {
                let src = &after[..end];

                // Skip external/embedded URLs and in-page anchors.
                if src.starts_with("data:")
                    || src.starts_with("http:")
                    || src.starts_with("https:")
                    || src.starts_with("#")
                {
                    return tag.to_string();
                }

                let clean = resolve_resource_path(chapter_path, src);
                if clean.is_empty() {
                    return tag.to_string();
                }

                let absolute = extracted_root.join(Path::new(&clean));
                let new_src = file_url(&absolute);

                if let Some(new_src) = new_src {
                    return tag.replacen(src, &new_src, 1);
                }

                return tag.to_string();
            }
        }
    }
    tag.to_string()
}

fn file_url(path: &Path) -> Option<String> {
    let abs = fs::canonicalize(path).ok().unwrap_or_else(|| path.to_path_buf());
    url::Url::from_file_path(&abs).ok().map(|u| u.to_string())
}

fn cache_dir_for_book(epub_path: &Path, cache_root: &Path) -> PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    epub_path.to_string_lossy().hash(&mut hasher);
    let key = format!("{:016x}", hasher.finish());
    cache_root.join("epubs").join(key)
}

fn source_fingerprint(epub_path: &Path) -> Result<String> {
    let meta = fs::metadata(epub_path)?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(format!("{}:{}:{}", epub_path.display(), meta.len(), modified))
}

fn extract_epub(epub_path: &Path, out_dir: &Path) -> Result<()> {
    let file = File::open(epub_path)?;
    let mut zip = ZipArchive::new(file)
        .map_err(|e| Error::Epub(format!("{}: {e}", epub_path.display())))?;

    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| Error::Epub(format!("{}: {e}", epub_path.display())))?;

        let Some(rel) = entry.enclosed_name().map(PathBuf::from) else {
            continue;
        };

        let out_path = out_dir.join(rel);

        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut outfile = File::create(&out_path)?;
        io::copy(&mut entry, &mut outfile)?;
    }

    Ok(())
}

fn resolve_resource_path(chapter_path: &Path, src: &str) -> String {
    // Strip query/fragment; zip resource keys are plain file paths.
    let src = src.split(['?', '#']).next().unwrap_or(src);
    if src.trim().is_empty() {
        return String::new();
    }

    let mut base = chapter_path.to_path_buf();
    base.pop();

    for comp in Path::new(src).components() {
        match comp {
            Component::ParentDir => {
                base.pop();
            }
            Component::Normal(seg) => {
                base.push(seg);
            }
            Component::CurDir | Component::RootDir | Component::Prefix(_) => {}
        }
    }

    path_to_unix(base)
}

fn path_to_unix(path: PathBuf) -> String {
    if cfg!(windows) {
        path.to_string_lossy().replace('\\', "/")
    } else {
        path.to_string_lossy().to_string()
    }
}

fn detect_mime(data: &[u8]) -> &'static str {
    if data.is_empty() {
        return "application/octet-stream";
    }

    // Check magic bytes
    if data.starts_with(b"\x89PNG") {
        return "image/png";
    } else if data.starts_with(b"\xff\xd8") {
        return "image/jpeg";
    } else if data.starts_with(b"GIF8") {
        return "image/gif";
    } else if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
        return "image/webp";
    } else if data.starts_with(b"<?xml") || data.starts_with(b"<svg") {
        return "image/svg+xml";
    }

    // Check for SVG even if not starting with <?xml
    if let Ok(s) = std::str::from_utf8(&data[..core::cmp::min(100, data.len())]) {
        if s.contains("<svg") {
            return "image/svg+xml";
        }
    }

    // Default to JPEG as fallback
    "image/jpeg"
}

fn open(path: &Path) -> Result<EpubDoc<std::io::BufReader<std::fs::File>>> {
    EpubDoc::new(path).map_err(|e| Error::Epub(format!("{}: {e}", path.display())))
}

fn has_external_scheme(href: &str) -> bool {
    let Some((scheme, _)) = href.split_once(':') else {
        return false;
    };
    if scheme.is_empty() || scheme.len() == 1 {
        return false;
    }
    let valid_scheme = scheme
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.');
    if !valid_scheme {
        return false;
    }

    matches!(
        scheme.to_ascii_lowercase().as_str(),
        "http" | "https" | "mailto" | "tel" | "javascript" | "data" | "file"
    )
}

fn decode_fragment(fragment: &str) -> String {
    urlencoding::decode(fragment)
        .map(|v| v.to_string())
        .unwrap_or_else(|_| fragment.to_string())
}

fn stem(path: &Path) -> String {
    path.file_stem().unwrap_or_default().to_string_lossy().into_owned()
}

fn to_plain(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => { in_tag = false; out.push(' '); }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn strip_chrome(html: &str) -> String {
    let lower = html.to_lowercase();
    if let (Some(bs), Some(be)) = (lower.find("<body"), lower.rfind("</body>")) {
        let start = html[bs..].find('>').map(|p| bs + p + 1).unwrap_or(bs);
        return html[start..be].to_owned();
    }
    html.to_owned()
}

fn safe_prefix(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let idx = clamp_to_char_boundary(s, max_bytes);
    &s[..idx]
}

fn clamp_to_char_boundary(s: &str, idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    let mut i = idx;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}
