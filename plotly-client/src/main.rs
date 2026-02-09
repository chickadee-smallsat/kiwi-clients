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
        // Serve static files from the local filesystem in debug mode
        let app = app.service(
            fs::Files::new("", format!("{}/web", env!("CARGO_MANIFEST_DIR")))
                .index_file("index.html")
                .use_last_modified(true),
        );

        #[cfg(not(debug_assertions))]
        // Serve embedded static files in release mode
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

// In release mode, serve embedded assets
#[cfg(not(debug_assertions))]
mod assets {
    use actix_web::{route, web};
    // #[cfg(not(debug_assertions))]
    use actix_web_rust_embed_responder::{EmbedResponse, IntoResponse};
    use rust_embed::{EmbeddedFile, RustEmbed};

    #[derive(RustEmbed)]
    #[folder = "web/"]
    struct Asset;

    // This responder implements both GET and HEAD
    #[route("/{path:.*}", method = "GET", method = "HEAD")]
    // The return type is important, that is the type for this responder
    async fn serve_assets(path: web::Path<String>) -> EmbedResponse<EmbeddedFile> {
        // This is not required, but is likely what you want if you want this
        // to serve `index.html` as the home page.
        let path = if path.is_empty() {
            "index.html"
        } else {
            path.as_str()
        };
        // There are implementations of `.into_response()` for both `EmbeddedFile` and `Option<EmbeddedFile>`.
        // With `Option<EmbeddedFile>`, this responder will also handle sending a 404 response for `None`.
        // If you want to customize the `404` response, you can handle the `None` case yourself: see the
        // `custom-404.rs` test for an example.
        Asset::get(path).into_response()
    }
}
