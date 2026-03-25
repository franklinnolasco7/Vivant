#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod epub;
mod error;
mod library;

use tauri::Manager;

#[tokio::main]
async fn main() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol("epub", |_ctx, request| {
            let uri = request.uri().to_string();
            let without_scheme = uri.trim_start_matches("epub://");

            if let Some(sep_pos) = without_scheme.find(':') {
                let encoded_book = &without_scheme[..sep_pos];
                let resource_path_raw = &without_scheme[sep_pos + 1..];

                let book_path = match urlencoding::decode(encoded_book) {
                    Ok(decoded) => decoded.to_string(),
                    Err(_) => {
                        return tauri::http::Response::builder()
                            .status(400)
                            .body(b"invalid encoding".to_vec())
                            .unwrap();
                    }
                };

                let p = std::path::Path::new(&book_path);
                if !p.exists() {
                    return tauri::http::Response::builder()
                        .status(404)
                        .body(b"book not found".to_vec())
                        .unwrap();
                }

                let resource_path = match urlencoding::decode(resource_path_raw) {
                    Ok(decoded) => decoded.to_string(),
                    Err(_) => resource_path_raw.to_string(),
                };

                match epub::get_resource(p, &resource_path) {
                    Some((data, mime)) => tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(data)
                        .unwrap(),
                    None => tauri::http::Response::builder()
                        .status(404)
                        .body(b"resource not found".to_vec())
                        .unwrap(),
                }
            } else {
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

            // Initialise pool and register as managed state —
            // every command receives it via State<'_, DbPool>
            let pool = db::init(&app_dir).expect("failed to initialise database");
            app.manage(pool);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::import_epub,
            commands::get_library,
            commands::delete_book,
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
        .expect("error while running Vellum");
}
