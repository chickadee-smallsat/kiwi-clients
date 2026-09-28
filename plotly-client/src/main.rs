use std::{io, sync::Arc};

#[cfg(debug_assertions)]
use actix_files as fs;
use actix_web::{App, HttpServer, Responder, get, middleware::Logger, web};

mod broadcast;
mod udp;
use self::broadcast::Broadcaster;

#[actix_web::main]
async fn main() -> io::Result<()> {
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));
    let args = Args::parse();

    let bindaddr =
        udp::cleaner_sockaddr((args.udp_addr, args.udp_port)).expect("Invalid UDP bind address");

    let data = Broadcaster::create();

    let listener = Arc::clone(&data);
    match args.multicast_group {
        Some(group) => {
            let group = udp::cleaner_sockaddr((group.as_str(), args.udp_port))
                .expect("Invalid multicast group address");
            let iface = udp::cleaner_sockaddr((args.multicast_iface.as_str(), 0))
                .expect("Invalid multicast interface address");
            actix_web::rt::spawn(udp::udp_listener_multicast(
                bindaddr, group, iface, listener,
            ));
        }
        None => {
            actix_web::rt::spawn(udp::udp_listener_unicast(bindaddr, listener));
        }
    }

    let server = HttpServer::new(move || {
        let app = App::new()
            .app_data(web::Data::from(Arc::clone(&data)))
            .service(devices_stream)
            .service(devices_list)
            .service(device_stream);

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
    .workers(2)
    .run();

    // Open the browser only once the port is bound, so the first load cannot fail.
    let url = format!("http://localhost:{}", args.http_port);
    log::info!("HTTP server listening at {url}");
    if !args.no_open
        && let Err(e) = open::that(&url)
    {
        log::warn!("Failed to open browser: {e}")
    }

    server.await
}

#[get("/devices/events")]
async fn devices_stream(broadcaster: web::Data<Broadcaster>) -> impl Responder {
    log::debug!("Device list SSE client connected");
    broadcaster.new_device_list_client()
}

#[get("/devices")]
async fn devices_list(broadcaster: web::Data<Broadcaster>) -> impl Responder {
    web::Json(broadcaster.known_devices())
}

#[get("/devices/{device_id}/events")]
async fn device_stream(
    broadcaster: web::Data<Broadcaster>,
    device_id: web::Path<String>,
) -> impl Responder {
    let device_id = device_id.into_inner();
    log::debug!("Device SSE client connected for device {device_id}");
    broadcaster.new_device_client(device_id)
}

use clap::Parser;

#[derive(Parser, Debug)]
struct Args {
    /// Address to bind the UDP socket to
    #[clap(long, default_value = "0.0.0.0")]
    udp_addr: String,

    /// Port to bind the UDP socket to
    #[clap(long, default_value = "8099")]
    udp_port: u16,

    /// Join this IPv4 multicast group (on --udp-port) instead of plain unicast
    #[clap(long)]
    multicast_group: Option<String>,

    /// Local interface address used to join the multicast group
    #[clap(long, default_value = "0.0.0.0")]
    multicast_iface: String,

    /// Address to bind the HTTP server to. Use 0.0.0.0 to let other machines
    /// (e.g. the Android app) open the dashboard.
    #[clap(long, default_value = "127.0.0.1")]
    http_addr: String,

    /// Port to bind the HTTP server to
    #[clap(long, default_value = "8080")]
    http_port: u16,

    /// Disable launching a browser on startup
    #[clap(long, default_value_t = false)]
    no_open: bool,
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
        } else if path.ends_with(".woff2") {
            "font/woff2"
        } else if path.ends_with(".wasm") {
            "application/wasm"
        } else {
            "application/octet-stream"
        }
    }

    /// Cache policy per asset type:
    /// - HTML → no-cache (always revalidate; routing pages must stay fresh)
    /// - Hashed bundles (index-*.js) → immutable, 1 year
    /// - Versioned vendor files (plotly-x.y.z.min.js, xlsx, vendor/ fonts and libraries) → 7 days
    /// - App JS/CSS (plot.js, styles.css) → no-cache (no content hash in name)
    fn cache_control_for(path: &str) -> &'static str {
        if path.ends_with(".html") || path.is_empty() {
            "no-cache, must-revalidate"
        } else if path.contains("/assets/index-") && path.ends_with(".js") {
            // Vite-hashed bundle — content never changes for this filename
            "public, max-age=31536000, immutable"
        } else if path.contains(".min.js")
            || path.starts_with("vendor/")
            || path.ends_with(".glb")
            || path.ends_with(".wasm")
        {
            // Versioned vendor files — safe to cache for a week
            "public, max-age=604800"
        } else {
            // App source (plot.js, styles.css) — no content-hash, revalidate each time
            "no-cache, must-revalidate"
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
                .insert_header(("Cache-Control", cache_control_for(&path)))
                .body(content.data.into_owned())),
            None => Ok(HttpResponse::NotFound().finish()),
        }
    }
}
