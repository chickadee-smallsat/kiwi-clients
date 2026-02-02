use std::{
    net::UdpSocket,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use clap::Parser;
use kiwi_measurements::{CommonMeasurement, SingleMeasurement};

fn main() {
    let args = Args::parse();
    let running = Arc::new(AtomicBool::new(true));

    ctrlc::set_handler({
        let running = running.clone();
        move || {
            println!("Received Ctrl-C signal");
            running.store(false, Ordering::SeqCst);
        }
    })
    .expect("Error setting Ctrl-C handler");

    udp_task(&args.address, args.port, running);
}

fn udp_task(address: &str, port: u16, running: Arc<AtomicBool>) {
    let start = Instant::now();
    let sock = UdpSocket::bind("127.0.0.1:0".to_string()).unwrap();
    if let Err(e) = sock.set_broadcast(true) {
        println!("Failed to set broadcast: {e}");
        running.store(false, Ordering::SeqCst);
        return;
    }
    println!("UDP socket bound on port {port}");
    let endpoint = format!("{address}:{port}");
    let mut last = Instant::now();
    let mut sent = 0;
    let mut lcount = 0;
    let mut total_loop = Duration::ZERO;
    while running.load(Ordering::SeqCst) {
        lcount += 1;
        let now = Instant::now();
        let elapsed = now.duration_since(start).as_secs_f64();
        if now.duration_since(last) > Duration::from_secs(1) {
            println!(
                "Packet rate: {:.2} packets/sec, average loop: {:.2} ms, elapsed: {:.2} s",
                sent as f64 / now.duration_since(last).as_secs_f64(),
                (total_loop.as_secs_f64() / lcount as f64) * 1000.0,
                elapsed
            );
            last = now;
            sent = 0;
            lcount = 0;
            total_loop = Duration::ZERO;
        }
        let accel = generate_accel_data(elapsed);
        let gyro = generate_gyro_data(elapsed);
        let mag = generate_mag_data(elapsed);
        let baro = generate_baro_data(elapsed);
        let tstamp = now.duration_since(start).as_micros() as u64;
        for mes in [accel, gyro, mag, baro] {
            let mes = SingleMeasurement {
                timestamp: tstamp,
                measurement: mes,
            };
            if sock
                .send_to(&core::convert::Into::<[u8; _]>::into(mes), &endpoint)
                .is_ok()
            {
                sent += 1;
            }
        }
        let dur = Instant::now().duration_since(now);
        let sleep_dur = Duration::from_millis(20).saturating_sub(dur);
        total_loop += sleep_dur;
        thread::sleep(sleep_dur);
    }
    println!("UDP task exiting");
}

fn generate_accel_data(elapsed: f64) -> CommonMeasurement {
    const THETA_PERIOD: f64 = 10.0; // seconds
    const PHI_PERIOD: f64 = 2.0; // seconds
    const G_PERIOD: f64 = 30.0; // seconds

    let g = (elapsed * 2.0 * core::f64::consts::PI / G_PERIOD).sin() * 0.1 + 0.9;
    let theta = elapsed * 2.0 * core::f64::consts::PI / THETA_PERIOD;
    let phi = elapsed * 2.0 * core::f64::consts::PI / PHI_PERIOD;
    let z = (theta).cos() * g;
    let x = (theta).sin() * (phi).cos() * g;
    let y = (theta).sin() * (phi).sin() * g;
    CommonMeasurement::Accel(x as f32, y as f32, z as f32)
}

fn generate_gyro_data(elapsed: f64) -> CommonMeasurement {
    const OMEGA: f64 = 2.0 * core::f64::consts::PI / 5.0; // radians per second
    const RATE: f64 = 0.25; // degrees per second

    let x = (RATE * (elapsed * OMEGA).cos()) as f32;
    let y = (RATE * (elapsed * OMEGA).sin()) as f32;
    let z = 0.0;
    CommonMeasurement::Gyro(x, y, z)
}

fn generate_mag_data(elapsed: f64) -> CommonMeasurement {
    const THETA_PERIOD: f64 = 10.0; // seconds
    const PHI_PERIOD: f64 = 3.0; // seconds
    const G_PERIOD: f64 = 30.0; // seconds

    let g = (elapsed * 2.0 * core::f64::consts::PI / G_PERIOD).sin() * 10.0 + 600.0;
    let theta = elapsed * 2.0 * core::f64::consts::PI / THETA_PERIOD;
    let phi = elapsed * 2.0 * core::f64::consts::PI / PHI_PERIOD;
    let z = (theta).cos() * g;
    let x = (theta).sin() * (phi).cos() * g;
    let y = (theta).sin() * (phi).sin() * g;
    CommonMeasurement::Mag(x as f32, y as f32, z as f32)
}

fn generate_baro_data(elapsed: f64) -> CommonMeasurement {
    const TEMP_PERIOD: f64 = 15.0; // seconds
    const PRES_PERIOD: f64 = 20.0; // seconds
    const ALT_PERIOD: f64 = 25.0; // seconds

    let temp = (elapsed * 2.0 * core::f64::consts::PI / TEMP_PERIOD).sin() * 2.0 + 25.0;
    let pres = (elapsed * 2.0 * core::f64::consts::PI / PRES_PERIOD).cos() * 20.0 + 1013.25;
    let alt = ((elapsed * 2.0 * core::f64::consts::PI / ALT_PERIOD).cos()).cosh() * 1000.0 + 100.0;
    CommonMeasurement::Baro(temp as f32, pres as f32, alt as f32)
}

#[derive(Parser, Debug)]
struct Args {
    /// Port to listen on
    #[clap(short, long, default_value = "8099")]
    port: u16,
    /// Address to broadcast to
    #[clap(short, long, default_value = "127.0.0.1")]
    address: String,
}
