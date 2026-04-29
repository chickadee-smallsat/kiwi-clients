use std::{net::TcpStream, thread, time::Duration};
use tauri::{Manager, path::BaseDirectory};

fn wait_for_backend() {
    for _ in 0..50 {
        if TcpStream::connect("127.0.0.1:8080").is_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(200));
    }
}

fn start_backend(app: &tauri::App) {
    let backend_path = app
        .path()
        .resolve("plotly-client.exe", BaseDirectory::Resource)
        .expect("Failed to resolve bundled backend path");

    let _child = std::process::Command::new(&backend_path)
        .spawn()
        .expect("Failed to start bundled plotly-client backend");

    wait_for_backend();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            start_backend(app);

            let window = app
                .get_webview_window("main")
                .expect("main window not found");

            window
                .eval(
                    r#"window.location.replace("http://127.0.0.1:8080/dashboard.html?src=5001");"#,
                )
                .expect("failed to load dashboard URL");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
