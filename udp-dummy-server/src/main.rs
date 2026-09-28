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

    udp_task(&args, running);
}

fn udp_task(args: &Args, running: Arc<AtomicBool>) {
    let (address, port) = (args.address.as_str(), args.port);
    let period = Duration::from_secs_f64(1.0 / args.rate.max(1.0));
    let mut start = Instant::now();
    // Pretend the board has already been up for --start-uptime seconds
    // (until its first simulated reboot).
    let mut uptime_offset_us = (args.start_uptime * 1e6) as u64;
    let sock = match UdpSocket::bind((args.bind.as_str(), 0)) {
        Ok(sock) => sock,
        Err(e) => {
            println!("Failed to bind source address {}: {e}", args.bind);
            return;
        }
    };
    if let Err(e) = sock.set_broadcast(true) {
        println!("Failed to set broadcast: {e}");
        running.store(false, Ordering::SeqCst);
        return;
    }
    println!(
        "Sending {} Hz from {} to {address}:{port}",
        args.rate,
        sock.local_addr().map(|a| a.to_string()).unwrap_or_default()
    );
    let endpoint = format!("{address}:{port}");
    let mut last = Instant::now();
    let mut sent = 0;
    let mut lcount = 0;
    let mut total_loop = Duration::ZERO;
    while running.load(Ordering::SeqCst) {
        lcount += 1;
        let now = Instant::now();
        if let Some(after) = args.reboot_after
            && now.duration_since(start).as_secs_f64() >= after
        {
            // Simulate a board reboot: the microsecond clock starts over.
            println!("Simulated reboot: timestamp clock reset");
            start = now;
            uptime_offset_us = 0;
        }
        let elapsed = now.duration_since(start).as_secs_f64();
        if now.duration_since(last) > Duration::from_secs(1) {
            println!(
                "Packet rate: {:.2} packets/sec, average idle: {:.2} ms, elapsed: {:.2} s",
                sent as f64 / now.duration_since(last).as_secs_f64(),
                (total_loop.as_secs_f64() / lcount as f64) * 1000.0,
                elapsed
            );
            last = now;
            sent = 0;
            lcount = 0;
            total_loop = Duration::ZERO;
        }
        let [accel, gyro, mag, baro] = match args.still {
            Some(roll) => still_board(roll),
            None => [
                generate_accel_data(elapsed),
                generate_gyro_data(elapsed),
                generate_mag_data(elapsed),
                generate_baro_data(elapsed),
            ],
        };
        let tstamp = uptime_offset_us + now.duration_since(start).as_micros() as u64;
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
        let sleep_dur = period.saturating_sub(dur);
        total_loop += sleep_dur;
        thread::sleep(sleep_dur);
    }
    println!("UDP task exiting");
}

/// Readings of a motionless board rolled by `roll_deg` about its x axis, in a
/// field pointing north and down (earth frame: x north, z up). Every value is
/// constant, so a client can check each displayed field exactly.
fn still_board(roll_deg: f64) -> [CommonMeasurement; 4] {
    const EARTH_MAG: [f64; 3] = [300.0, 0.0, -500.0]; // mG
    const PRESSURE: f64 = 1000.0; // hPa
    let (s, c) = roll_deg.to_radians().sin_cos();
    let [ex, ey, ez] = EARTH_MAG;
    [
        CommonMeasurement::Accel(0.0, s as f32, c as f32),
        CommonMeasurement::Gyro(0.0, 0.0, 0.0),
        CommonMeasurement::Mag(
            ex as f32,
            (ey * c + ez * s) as f32,
            (-ey * s + ez * c) as f32,
        ),
        CommonMeasurement::Baro(21.5, PRESSURE as f32, altitude_m(PRESSURE) as f32),
    ]
}

/// International barometric formula.
fn altitude_m(pressure_hpa: f64) -> f64 {
    44330.0 * (1.0 - (pressure_hpa / 1013.25).powf(1.0 / 5.255))
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

    let temp = (elapsed * 2.0 * core::f64::consts::PI / TEMP_PERIOD).sin() * 2.0 + 25.0;
    let pres = (elapsed * 2.0 * core::f64::consts::PI / PRES_PERIOD).cos() * 20.0 + 1013.25;
    // Altitude consistent with the pressure (international barometric formula).
    let alt = altitude_m(pres);
    CommonMeasurement::Baro(temp as f32, pres as f32, alt as f32)
}

#[derive(Parser, Debug)]
struct Args {
    /// Port to listen on
    #[clap(short, long, default_value = "8099")]
    port: u16,
    /// Address to send packets to
    #[clap(short, long, default_value = "127.0.0.1")]
    address: String,
    /// Local address to send from. The dashboard identifies a board by its IP,
    /// so run several instances with --bind 127.0.0.2, 127.0.0.3, ... to
    /// simulate several boards on one machine.
    #[clap(short, long, default_value = "0.0.0.0")]
    bind: String,
    /// Samples per second for each sensor
    #[clap(short, long, default_value_t = 50.0)]
    rate: f64,
    /// Restart the timestamp clock every N seconds to simulate a board reboot
    #[clap(long)]
    reboot_after: Option<f64>,
    /// Send a motionless board rolled by this many degrees with constant readings
    #[clap(long)]
    still: Option<f64>,
    /// Start the board's timestamp clock as if it had been up this many seconds
    #[clap(long, default_value_t = 0.0)]
    start_uptime: f64,
}
