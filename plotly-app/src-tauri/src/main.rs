//! Kiwi Plotter desktop app: runs the plotly-client server (HTTP + UDP + BLE)
//! in-process on a background thread and shows its web UI in a Tauri window.

// No console window next to the app on Windows release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io,
    net::{Ipv4Addr, TcpListener},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use plotly_client::ServerHandle;
use tauri::{
    AppHandle, Manager, RunEvent, Theme, Url, WebviewUrl, WebviewWindowBuilder,
    webview::{DownloadEvent, PageLoadEvent},
    window::Color,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const HTTP_HOST: Ipv4Addr = Ipv4Addr::LOCALHOST;
const UDP_PORT: u16 = 8099;
/// How long the server gets to bind its HTTP socket
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
/// How long to wait for the server (and the BLE receiver, which disconnects
/// from devices) to shut down when the app exits
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
/// How long after startup to check that the UDP socket could be bound
const UDP_CHECK_DELAY: Duration = Duration::from_millis(500);

/// The in-process plotly-client server
struct Backend {
    handle: ServerHandle,
    /// Set once the server thread has finished
    stopped: Arc<(Mutex<bool>, Condvar)>,
    /// Set when the app is quitting, so the server stopping is expected
    quitting: Arc<AtomicBool>,
}

impl Backend {
    /// Starts the server on a background thread and waits until its HTTP
    /// socket is bound. Returns the server and its HTTP port.
    fn start(app: &AppHandle) -> Result<(Self, u16), String> {
        let port = free_port().map_err(|e| format!("No free local port for the UI server: {e}"))?;
        let args = plotly_client::Args {
            udp_addr: "0.0.0.0".into(),
            udp_port: UDP_PORT,
            http_addr: HTTP_HOST.to_string(),
            http_port: port,
            no_open: true,
            no_ble: false,
            no_signals: true,
        };
        let (ready_tx, ready_rx) = mpsc::channel::<Result<ServerHandle, String>>();
        let stopped = Arc::new((Mutex::new(false), Condvar::new()));
        let quitting = Arc::new(AtomicBool::new(false));
        thread::Builder::new()
            .name("plotly-client".into())
            .spawn({
                let (ready_tx, stopped, quitting, app) =
                    (ready_tx.clone(), stopped.clone(), quitting.clone(), app.clone());
                move || {
                    let on_ready = ready_tx.clone();
                    let result = plotly_client::run_blocking(args, move |handle| {
                        let _ = on_ready.send(Ok(handle));
                    });
                    // Only reaches the receiver if the server failed before binding
                    let _ = ready_tx.send(Err(match &result {
                        Ok(()) => "the server stopped during startup".into(),
                        Err(e) => e.to_string(),
                    }));
                    let (lock, cvar) = &*stopped;
                    *lock.lock().unwrap() = true;
                    cvar.notify_all();
                    if !quitting.load(Ordering::SeqCst) {
                        backend_died(&app, result);
                    }
                }
            })
            .map_err(|e| format!("Failed to start the server thread: {e}"))?;
        drop(ready_tx);
        let handle = match ready_rx.recv_timeout(STARTUP_TIMEOUT) {
            Ok(Ok(handle)) => handle,
            Ok(Err(e)) => return Err(format!("The plotly-client server failed to start: {e}")),
            Err(_) => return Err("Timed out waiting for the plotly-client server to start".into()),
        };
        Ok((
            Self {
                handle,
                stopped,
                quitting,
            },
            port,
        ))
    }

    /// Stops the server and waits (bounded) for it to finish, so the BLE
    /// receiver gets to disconnect from devices before the process exits.
    fn stop(&self) {
        if self.quitting.swap(true, Ordering::SeqCst) {
            return;
        }
        // Not graceful: open SSE streams never finish on their own, and a
        // graceful stop would wait for them until actix's 30 s timeout.
        tauri::async_runtime::block_on(self.handle.stop(false));
        let (lock, cvar) = &*self.stopped;
        let guard = lock.lock().unwrap();
        let (_guard, timeout) = cvar
            .wait_timeout_while(guard, SHUTDOWN_TIMEOUT, |stopped| !*stopped)
            .unwrap();
        if timeout.timed_out() {
            log::warn!("plotly-client server did not stop within {SHUTDOWN_TIMEOUT:?}");
        }
    }
}

/// The server exited while the app was running: tell the user and quit
fn backend_died(app: &AppHandle, result: io::Result<()>) {
    let detail = match result {
        Ok(()) => "The plotly-client server stopped unexpectedly.".to_string(),
        Err(e) => format!("The plotly-client server stopped unexpectedly:\n\n{e}"),
    };
    let app = app.clone();
    app.clone()
        .dialog()
        .message(detail)
        .title("plotly-client exited")
        .kind(MessageDialogKind::Error)
        .show(move |_| app.exit(1));
}

/// Asks the OS for a free localhost TCP port
fn free_port() -> io::Result<u16> {
    Ok(TcpListener::bind((HTTP_HOST, 0))?.local_addr()?.port())
}

/// Starts the server and opens the main window
fn setup(app: &AppHandle) -> Result<(), String> {
    let (backend, port) = Backend::start(app)?;
    app.manage(backend);

    let url = Url::parse(&format!("http://{HTTP_HOST}:{port}")).expect("valid URL");
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Kiwi Plotter")
        .inner_size(1280.0, 840.0)
        .min_inner_size(980.0, 700.0)
        // Shown once the UI has loaded, like Electron's ready-to-show
        .visible(false)
        .initialization_script("window.plotlyClientMeta = { runtime: 'tauri' };")
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = window.show();
            }
        })
        // CSV/XLSX exports are `<a download>` blob links. The webview saves
        // them to the Downloads folder (adding " (n)" rather than
        // overwriting); tell the user where they went.
        .on_download(|webview, event| {
            if let DownloadEvent::Finished { path, success, .. } = event {
                let dialog = webview.dialog().message(match (&path, success) {
                    (Some(path), true) => format!("Saved to {}", path.display()),
                    _ => "The download failed.".to_string(),
                });
                let kind = if success {
                    MessageDialogKind::Info
                } else {
                    MessageDialogKind::Error
                };
                dialog.title("Export").kind(kind).show(|_| {});
            }
            true
        })
        .build()
        .map_err(|e| format!("Failed to open the main window: {e}"))?;
    // Match the UI's background while it loads
    let background = match window.theme().unwrap_or(Theme::Light) {
        Theme::Dark => Color(0x08, 0x15, 0x21, 0xff),
        _ => Color(0xee, 0xf5, 0xf8, 0xff),
    };
    let _ = window.set_background_color(Some(background));

    // The UDP listener binds in the background; warn if device data can't arrive
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(UDP_CHECK_DELAY);
        if let Some(e) = plotly_client::udp_bind_error() {
            app.dialog()
                .message(format!(
                    "Kiwi Plotter could not listen for device data on UDP port {UDP_PORT}:\n\n{e}\n\n\
                     Make sure no other application is using port {UDP_PORT} and restart Kiwi Plotter."
                ))
                .title(format!("Cannot bind UDP port {UDP_PORT}"))
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
    });
    Ok(())
}

fn main() {
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(e) = setup(&handle) {
                log::error!("{e}");
                let exit = handle.clone();
                handle
                    .dialog()
                    .message(e)
                    .title("Failed to start Kiwi Plotter")
                    .kind(MessageDialogKind::Error)
                    .show(move |_| exit.exit(1));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Tauri app");
    app.run(|app, event| {
        if let RunEvent::Exit = event
            && let Some(backend) = app.try_state::<Backend>()
        {
            backend.stop();
        }
    });
}
