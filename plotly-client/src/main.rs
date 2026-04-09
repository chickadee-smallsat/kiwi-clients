use std::{io, sync::Arc};

#[cfg(debug_assertions)]
use actix_files as fs;
use actix_web::{get, middleware::Logger, web, App, HttpServer, Responder};

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

    log::info!(
        "starting HTTP server at http://localhost:{}",
        args.http_port
    );

    if let Err(e) = open::that(format!("http://localhost:{}", args.http_port)) {
        log::warn!("Failed to open browser: {}", e)
    }

    actix_web::rt::spawn({
        let broadcaster = Arc::clone(&data);
        async move {
            let running = Arc::new(std::sync::atomic::AtomicBool::new(true));
            udp::udp_listener_unicast(bindaddr, broadcaster, running).await;
        }
    });

    HttpServer::new(move || {
        let app = App::new()
            .app_data(web::Data::from(Arc::clone(&data)))
            .service(event_stream)
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
    .run()
    .await
}

#[get("/events")]
async fn event_stream(broadcaster: web::Data<Broadcaster>) -> impl Responder {
    #[cfg(debug_assertions)]
    log::info!("SSE client connected");
    #[cfg(not(debug_assertions))]
    log::debug!("SSE client connected");
    broadcaster.new_client().await
}

#[get("/devices/events")]
async fn devices_stream(broadcaster: web::Data<Broadcaster>) -> impl Responder {
    #[cfg(debug_assertions)]
    log::info!("Device list SSE client connected");
    #[cfg(not(debug_assertions))]
    log::debug!("Device list SSE client connected");
    broadcaster.new_device_list_client().await
}

#[get("/devices")]
async fn devices_list(broadcaster: web::Data<Broadcaster>) -> impl Responder {
    web::Json(broadcaster.known_ports())
}

#[get("/devices/{port}/events")]
async fn device_stream(
    broadcaster: web::Data<Broadcaster>,
    port: web::Path<u16>,
) -> impl Responder {
    #[cfg(debug_assertions)]
    log::info!("Device SSE client connected for port {}", *port);
    #[cfg(not(debug_assertions))]
    log::debug!("Device SSE client connected for port {}", *port);

    broadcaster.new_device_client(*port).await
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

    /// Address to bind the HTTP server to
    #[clap(long, default_value = "127.0.0.1")]
    http_addr: String,

    /// Port to bind the HTTP server to
    #[clap(long, default_value = "8080")]
    http_port: u16,
}

#[cfg(not(debug_assertions))]
mod assets {
    use actix_web::{route, web, HttpResponse, Result};
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