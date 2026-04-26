mod commands;
mod db;
mod epub;
mod error;
mod library;

use tauri::Manager;

pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol("epub", |_ctx, request| {
            let uri = request.uri().to_string();
            log::debug!("EPUB protocol request: {}", uri);

            // Format: epub://[encoded_path_with_slashes]:resource/path
            // We use ':' as a simple separator instead of special characters
            let without_scheme = uri.trim_start_matches("epub://");

            if let Some(sep_pos) = without_scheme.find(':') {
                let encoded_book = &without_scheme[..sep_pos];
                let resource_path_raw = &without_scheme[sep_pos + 1..];

                let book_path = match urlencoding::decode(encoded_book) {
                    Ok(decoded) => decoded.to_string(),
                    Err(_) => {
                        log::warn!("Failed to decode book path: {}", encoded_book);
                        return tauri::http::Response::builder()
                            .status(400)
                            .body(b"invalid encoding".to_vec())
                            .unwrap();
                    }
                };

                let resource_path = match urlencoding::decode(resource_path_raw) {
                    Ok(decoded) => decoded.to_string(),
                    Err(_) => resource_path_raw.to_string(),
                };

                log::debug!("Book path: {}, Resource: {}", book_path, resource_path);

                let p = std::path::Path::new(&book_path);
                if !p.exists() {
                    log::warn!("Book file not found: {}", book_path);
                    return tauri::http::Response::builder()
                        .status(404)
                        .body(b"book not found".to_vec())
                        .unwrap();
                }

                match epub::get_resource(p, &resource_path) {
                    Some((data, mime)) => {
                        log::debug!("Served {}: {} bytes, type {}", resource_path, data.len(), mime);
                        tauri::http::Response::builder()
                            .status(200)
                            .header("Content-Type", mime)
                            .header("Access-Control-Allow-Origin", "*")
                            .body(data)
                            .unwrap()
                    }
                    None => {
                        log::warn!("Resource not found: {} in {}", resource_path, book_path);
                        tauri::http::Response::builder()
                            .status(404)
                            .body(b"resource not found".to_vec())
                            .unwrap()
                    }
                }
            } else {
                log::warn!("Malformed epub:// URI (no separator): {}", uri);
                tauri::http::Response::builder()
                    .status(400)
                    .body(b"invalid epub:// URI format".to_vec())
                    .unwrap()
            }
        })
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&app_dir)?;
            let pool = db::init(&app_dir).expect("failed to initialise database");
            app.manage(pool);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::import_epub,
            commands::get_library,
            commands::delete_books,
            commands::update_book_metadata,
            commands::get_chapter,
            commands::get_toc,
            commands::resolve_book_link,
            commands::open_external_url,
            commands::save_progress,
            commands::get_progress,
            commands::add_reading_time,
            commands::add_annotation,
            commands::get_annotations,
            commands::delete_annotation,
            commands::search_book,
            commands::window_minimize,
            commands::window_maximize,
            commands::window_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vivant");
}
