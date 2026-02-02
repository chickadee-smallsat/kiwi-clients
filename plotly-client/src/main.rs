use std::{io, sync::Arc};

// use actix_files::NamedFile;
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

    actix_web::rt::spawn({
        let broadcaster = Arc::clone(&data);
        async move {
            let running = Arc::new(std::sync::atomic::AtomicBool::new(true));
            udp::udp_listener_unicast(bindaddr, broadcaster, running).await;
        }
    });

    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::from(Arc::clone(&data)))
            .service(event_stream)
            .service(
                fs::Files::new("", format!("{}/web", env!("CARGO_MANIFEST_DIR")))
                    .index_file("index.html")
                    .use_last_modified(true),
            )
            .wrap(Logger::default())
    })
    .bind((args.http_addr.as_str(), args.http_port))?
    .workers(2)
    .run()
    .await
}

#[get("/events")]
async fn event_stream(broadcaster: web::Data<Broadcaster>) -> impl Responder {
    log::info!("SSE client connected");
    broadcaster.new_client().await
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
