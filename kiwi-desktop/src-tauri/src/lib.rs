//! Kiwi Dashboard shell.
//!
//! Desktop: starts the bundled `plotly-client` backend on a free local port,
//! shows `app/index.html` (a loading screen) until it answers, then navigates
//! the window to the dashboard. The backend is killed when the app exits.
//!
//! Mobile: no backend is bundled; `app/index.html` asks for the address of a
//! PC running `plotly-client --http-addr 0.0.0.0`.

#[cfg(not(mobile))]
mod backend {
    use std::{
        net::{TcpListener, TcpStream},
        path::PathBuf,
        process::{Child, Command},
        sync::Mutex,
        thread,
        time::{Duration, Instant},
    };
    use tauri::{path::BaseDirectory, Manager};

    const READY_TIMEOUT: Duration = Duration::from_secs(15);

    /// Handle to the running backend, stored in Tauri state so it can be killed on exit.
    #[derive(Default)]
    pub struct Backend(pub Mutex<Option<Child>>);

    fn exe_name() -> &'static str {
        if cfg!(windows) {
            "plotly-client.exe"
        } else {
            "plotly-client"
        }
    }

    /// The backend to launch.
    ///
    /// Debug builds run from the repo and always use the current workspace
    /// release build, never a stale copy left in the build folder. Packaged
    /// apps use the copy bundled as a resource (the build scripts bundle it as
    /// `resources/<exe>`, which Tauri keeps as a relative path).
    fn locate(app: &tauri::AppHandle) -> Option<PathBuf> {
        if cfg!(debug_assertions) {
            let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/release")
                .join(exe_name());
            return dev.is_file().then_some(dev);
        }
        [format!("resources/{}", exe_name()), exe_name().to_owned()]
            .iter()
            .filter_map(|p| app.path().resolve(p, BaseDirectory::Resource).ok())
            .find(|p| p.is_file())
    }

    fn free_port() -> std::io::Result<u16> {
        Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
    }

    /// Wait until the backend accepts connections; fail early if it exits.
    fn wait_ready(child: &mut Child, port: u16) -> Result<(), String> {
        let deadline = Instant::now() + READY_TIMEOUT;
        while Instant::now() < deadline {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                return Ok(());
            }
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("Backend exited during startup ({status})."));
            }
            thread::sleep(Duration::from_millis(200));
        }
        Err(format!(
            "Backend did not answer on port {port} within {READY_TIMEOUT:?}."
        ))
    }

    fn start(app: &tauri::AppHandle) -> Result<u16, String> {
        let exe = locate(app).ok_or_else(|| {
            format!(
                "{} not found. Build it with `cargo build --release -p plotly-client`.",
                exe_name()
            )
        })?;
        let port = free_port().map_err(|e| format!("No free local port: {e}"))?;

        let mut cmd = Command::new(&exe);
        cmd.args([
            "--http-addr",
            "127.0.0.1",
            "--http-port",
            &port.to_string(),
            "--no-open",
        ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not start {}: {e}", exe.display()))?;
        let ready = wait_ready(&mut child, port);
        // Keep the handle even on failure so exit still cleans it up.
        *app.state::<Backend>().0.lock().unwrap() = Some(child);
        ready.map(|()| port)
    }

    /// Start the backend off the UI thread, then point the window at it.
    pub fn launch(app: &tauri::AppHandle) {
        let app = app.clone();
        thread::spawn(move || {
            let Some(win) = app.get_webview_window("main") else {
                return;
            };
            let script = match start(&app) {
                Ok(port) => format!("window.location.replace('http://127.0.0.1:{port}/')"),
                Err(e) => {
                    eprintln!("[kiwi] {e}");
                    let msg = serde_json::to_string(&e).unwrap_or_default();
                    format!("window.kiwiBackendFailed && window.kiwiBackendFailed({msg})")
                }
            };
            let _ = win.eval(&script);
        });
    }

    pub fn stop(app: &tauri::AppHandle) {
        if let Some(mut child) = app.state::<Backend>().0.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(not(mobile))]
    let builder = builder.manage(backend::Backend::default()).setup(|app| {
        backend::launch(app.handle());
        Ok(())
    });

    let app = builder
        .build(tauri::generate_context!())
        .expect("Kiwi Dashboard failed to start");

    app.run(|_handle, _event| {
        #[cfg(not(mobile))]
        if let tauri::RunEvent::Exit = _event {
            backend::stop(_handle);
        }
    });
}
