use clap::Parser;
use plotly_client::Args as RunArgs;

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

    /// Disable launching a browser on startup
    #[clap(long, default_value_t = false)]
    no_open: bool,
}

impl From<Args> for RunArgs {
    fn from(a: Args) -> Self {
        RunArgs {
            udp_addr: a.udp_addr,
            udp_port: a.udp_port,
            http_addr: a.http_addr,
            http_port: a.http_port,
            no_open: a.no_open,
        }
    }
}

fn main() -> std::io::Result<()> {
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));
    let args = Args::parse();
    plotly_client::run_blocking(args.into(), |_handle| {})
}
