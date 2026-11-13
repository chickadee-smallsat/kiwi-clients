use std::{io, sync::Arc};

#[cfg(debug_assertions)]
use actix_files as fs;
use actix_web::{App, HttpServer, Responder, get, middleware::Logger, web};

mod ble;
mod broadcast;
mod udp;
#[cfg(target_os = "ios")]
mod ios;
use self::broadcast::Broadcaster;

/// Handle for stopping a running server, passed to `on_ready` (re-exported so
/// embedding shells don't need their own actix-web dependency)
pub use actix_web::dev::ServerHandle;

/// The most recent error binding the UDP socket device data arrives on, or
/// `None` once it is bound. The listener keeps retrying in the background.
pub fn udp_bind_error() -> Option<String> {
    udp::UDP_BIND_ERROR.lock().clone()
}

#[derive(Debug, Clone)]
pub struct Args {
    /// Address to bind the UDP socket to
    pub udp_addr: String,
    /// Port to bind the UDP socket to
    pub udp_port: u16,
    /// Address to bind the HTTP server to
    pub http_addr: String,
    /// Port to bind the HTTP server to
    pub http_port: u16,
    /// Disable launching a browser on startup
    pub no_open: bool,
    /// Disable the Bluetooth LE receiver
    pub no_ble: bool,
    /// Don't let actix-web handle SIGINT/SIGTERM by stopping the server. Set
    /// when embedded in an app, which owns the process and stops the server
    /// itself through the [`ServerHandle`].
    pub no_signals: bool,
}

/// Starts the HTTP server, the UDP listener and (unless disabled) the Bluetooth LE
/// receiver, and runs until the server stops.
///
/// `on_ready` is invoked once the `HttpServer` has been bound, with a handle that can be used
/// to stop the server from another thread (see [`ServerHandle::stop`]).
pub async fn run_async(args: Args, on_ready: impl FnOnce(ServerHandle)) -> io::Result<()> {
    let bindaddr =
        udp::cleaner_sockaddr((args.udp_addr.as_str(), args.udp_port)).expect("Invalid UDP bind address");

    let data = Broadcaster::create(3);

    log::info!(
        "starting HTTP server at http://{}:{}",
        args.http_addr, args.http_port
    );

    #[cfg(not(target_os = "ios"))]
    if !args.no_open
        && let Err(e) = open::that(format!("http://localhost:{}", args.http_port))
    {
        log::warn!("Failed to open browser: {}", e)
    }

    actix_web::rt::spawn({
        let broadcaster = Arc::clone(&data);
        async move {
            let running = Arc::new(std::sync::atomic::AtomicBool::new(true));
            udp::udp_listener_unicast(bindaddr, broadcaster, running).await;
        }
    });
    // The BLE receiver is stopped explicitly once the HTTP server exits, so it
    // can disconnect from devices while the runtime is still alive.
    let (ble_stop, ble_stop_rx) = tokio::sync::watch::channel(false);
    let ble_task = (!args.no_ble).then(|| {
        let broadcaster = Arc::clone(&data);
        actix_web::rt::spawn(ble::ble_listener(broadcaster, ble_stop_rx))
    });

    let server = HttpServer::new(move || {
        let app = App::new()
            .app_data(web::Data::from(Arc::clone(&data)))
            .service(event_stream)
            .service(devices_list);

        #[cfg(debug_assertions)]
        let app = app.service(
            fs::Files::new("", format!("{}/web", env!("CARGO_MANIFEST_DIR")))
                .index_file("index.html")
                .use_last_modified(true),
        );

        #[cfg(not(debug_assertions))]
        let app = app.service(assets::serve_assets);

        app.wrap(Logger::default())
    })
    .bind((args.http_addr.as_str(), args.http_port))?
    .workers(2);
    let server = if args.no_signals { server.disable_signals() } else { server }.run();

    on_ready(server.handle());
    let result = server.await;
    let _ = ble_stop.send(true);
    if let Some(ble_task) = ble_task {
        let _ = ble_task.await;
    }
    result
}

/// Blocking wrapper around [`run_async`] that owns its own actix runtime.
///
/// Intended for callers that don't already own a `System`/Tokio runtime — the desktop CLI entry
/// point and the iOS FFI entry point both use this.
pub fn run_blocking(args: Args, on_ready: impl FnOnce(ServerHandle) + Send + 'static) -> io::Result<()> {
    actix_web::rt::System::new().block_on(run_async(args, on_ready))
}

#[get("/events")]
async fn event_stream(broadcaster: web::Data<Broadcaster>) -> impl Responder {
    broadcaster.new_client().await
}

#[get("/devices")]
async fn devices_list(broadcaster: web::Data<Broadcaster>) -> impl Responder {
    web::Json(broadcaster.known_devices().await)
}

#[cfg(not(debug_assertions))]
mod assets {
    use actix_web::{HttpResponse, Result, route, web};
    use rust_embed::RustEmbed;

    #[derive(RustEmbed)]
    #[folder = "web/"]
    struct Asset;

    fn content_type_for(path: &str) -> &'static str {
        if path.ends_with(".html") {
            "text/html; charset=utf-8"
        } else if path.ends_with(".js") {
            "application/javascript; charset=utf-8"
        } else if path.ends_with(".css") {
            "text/css; charset=utf-8"
        } else if path.ends_with(".glb") {
            "model/gltf-binary"
        } else if path.ends_with(".json") {
            "application/json; charset=utf-8"
        } else if path.ends_with(".svg") {
            "image/svg+xml"
        } else if path.ends_with(".png") {
            "image/png"
        } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
            "image/jpeg"
        } else if path.ends_with(".ico") {
            "image/x-icon"
        } else if path.ends_with(".wasm") {
            "application/wasm"
        } else {
            "application/octet-stream"
        }
    }

    #[route("/{path:.*}", method = "GET", method = "HEAD")]
    async fn serve_assets(path: web::Path<String>) -> Result<HttpResponse> {
        let raw_path = path.into_inner();

        let path = if raw_path.is_empty() {
            "index.html".to_string()
        } else if raw_path.ends_with('/') {
            format!("{}index.html", raw_path)
        } else if !raw_path.contains('.') {
            format!("{}/index.html", raw_path)
        } else {
            raw_path
        };

        match Asset::get(&path) {
            Some(content) => Ok(HttpResponse::Ok()
                .insert_header(("Content-Type", content_type_for(&path)))
                .body(content.data.into_owned())),
            None => Ok(HttpResponse::NotFound().finish()),
        }
    }
}
