//! C-callable entry points used by the iOS app shell to run the server in-process instead of as
//! a spawned subprocess (which iOS does not allow). Linked into an `.xcframework` static lib.

use std::sync::{Mutex, OnceLock};

use actix_web::dev::ServerHandle;

use crate::{Args, run_blocking};

static SERVER_HANDLE: OnceLock<Mutex<Option<ServerHandle>>> = OnceLock::new();
static LOG_INIT: OnceLock<()> = OnceLock::new();

fn handle_slot() -> &'static Mutex<Option<ServerHandle>> {
    SERVER_HANDLE.get_or_init(|| Mutex::new(None))
}

/// Starts the HTTP server (bound to `127.0.0.1:http_port`) and the UDP listener
/// (bound to `0.0.0.0:udp_port`) on a background thread. Returns immediately; poll
/// `http://127.0.0.1:<http_port>/devices` from Swift to detect readiness, matching the desktop
/// Electron shell's startup pattern.
///
/// Always tears down any previous instance first (best-effort, see [`kiwi_stop`]), so it's safe
/// to call again after iOS suspends or kills the app's background networking — the Swift side
/// doesn't need to know whether the old server is still alive, just that it wants a fresh one.
/// Always returns 0.
#[unsafe(no_mangle)]
pub extern "C" fn kiwi_start(http_port: u16, udp_port: u16) -> i32 {
    LOG_INIT.get_or_init(|| {
        env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));
    });

    kiwi_stop();

    let args = Args {
        udp_addr: "0.0.0.0".to_string(),
        udp_port,
        http_addr: "127.0.0.1".to_string(),
        http_port,
        no_open: true,
    };

    std::thread::spawn(move || {
        let result = run_blocking(args, |server_handle| {
            *handle_slot().lock().unwrap() = Some(server_handle);
        });
        if let Err(e) = result {
            log::error!("[iOS] server exited with error: {e}");
        }
        *handle_slot().lock().unwrap() = None;
    });

    0
}

/// Stops a server started with [`kiwi_start`]. No-op if none is running.
#[unsafe(no_mangle)]
pub extern "C" fn kiwi_stop() {
    let handle = handle_slot().lock().unwrap().take();
    if let Some(handle) = handle {
        // `ServerHandle::stop` is async; this FFI entry point is synchronous, so drive it to
        // completion on a throwaway single-threaded runtime. Non-graceful (`false`): a stale
        // connection left open by a suspended WKWebView (the exact case `kiwi_start` calls this
        // for) may never close on its own, and a graceful drain would hang waiting for it —
        // taking kiwi_start's restart down with it.
        if let Ok(rt) = tokio::runtime::Builder::new_current_thread().build() {
            rt.block_on(handle.stop(false));
        }
    }
}
