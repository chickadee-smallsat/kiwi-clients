//! UDP ingestion: receive `SingleMeasurement` packets from Kiwi boards, group
//! them per device and hand 100 ms batches to the [`Broadcaster`].

use atomic_time::AtomicInstant;
use kiwi_measurements::SingleMeasurement;
use std::{
    collections::HashMap,
    io,
    net::{SocketAddr, SocketAddrV4, ToSocketAddrs},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    net::UdpSocket,
    time::{self, MissedTickBehavior},
};

use crate::broadcast::Broadcaster;

/// How often accumulated measurements are pushed to browsers.
const BATCH_INTERVAL: Duration = Duration::from_millis(100);
/// Receive buffer. Larger than one measurement so an oversized datagram is
/// rejected by the length check instead of failing `recv_from` (Windows
/// reports truncation as an error).
const RECV_BUF_SIZE: usize = 2048;
/// Pause before rebinding after a socket error, and between failed binds.
const REBIND_DELAY: Duration = Duration::from_secs(1);

/// A board is identified by its IP address. The source port is ephemeral and
/// changes on every reboot, so it must not be part of the identity.
pub fn device_id(src: SocketAddr) -> String {
    src.ip().to_string()
}

pub async fn udp_listener_unicast(bind: SocketAddrV4, sink: Arc<Broadcaster>) {
    let datarate = DataRateCounter::default();
    loop {
        let socket = match UdpSocket::bind(bind).await {
            Ok(sock) => sock,
            Err(e) => {
                log::error!("[UDPU] Failed to bind UDP socket {bind}: {e}");
                time::sleep(REBIND_DELAY).await;
                continue;
            }
        };
        log::info!("[UDPU] Listening for UDP packets on {bind}");
        if let Err(e) = udp_receive_data("UDPU", &socket, &sink, &datarate).await {
            log::error!("[UDPU] Socket error, rebinding: {e}");
            time::sleep(REBIND_DELAY).await; // do not spin on a persistent error
        }
    }
}

pub async fn udp_listener_multicast(
    bind: SocketAddrV4,
    group: SocketAddrV4,
    interface: SocketAddrV4,
    sink: Arc<Broadcaster>,
) {
    let datarate = DataRateCounter::default();
    loop {
        let socket = match join_multicast(bind, group, interface) {
            Ok(sock) => sock,
            Err(e) => {
                log::error!("[UDPM] Failed to join {group} on {interface}: {e}");
                time::sleep(REBIND_DELAY).await;
                continue;
            }
        };
        log::info!("[UDPM] Listening for multicast {group} on interface {interface}");
        if let Err(e) = udp_receive_data("UDPM", &socket, &sink, &datarate).await {
            log::error!("[UDPM] Socket error, rejoining: {e}");
            time::sleep(REBIND_DELAY).await; // do not spin on a persistent error
        }
    }
}

fn join_multicast(
    bind: SocketAddrV4,
    group: SocketAddrV4,
    interface: SocketAddrV4,
) -> io::Result<UdpSocket> {
    let socket = socket2::Socket::new(
        socket2::Domain::IPV4,
        socket2::Type::DGRAM,
        Some(socket2::Protocol::UDP),
    )?;
    socket.set_reuse_address(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&SocketAddr::V4(bind).into())?;
    socket.join_multicast_v4(group.ip(), interface.ip())?;
    UdpSocket::from_std(socket.into())
}

async fn udp_receive_data(
    kind: &str,
    socket: &UdpSocket,
    sink: &Broadcaster,
    datarate: &DataRateCounter,
) -> io::Result<()> {
    let mut batches: HashMap<String, Vec<SingleMeasurement>> = HashMap::new();
    let mut counts: HashMap<String, usize> = HashMap::new();

    let mut flush = time::interval(BATCH_INTERVAL);
    flush.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut rate_tick = time::interval(Duration::from_secs(1));
    rate_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let mut invalid = InvalidPacketLog::default();
    let mut buf = [0u8; RECV_BUF_SIZE];
    loop {
        tokio::select! {
            res = socket.recv_from(&mut buf) => {
                let (size, src) = res?;
                if let Some((rate, unit)) = datarate.update(size) {
                    log::info!("[{kind}] Receiving data rate: {rate:.3} {unit}");
                }
                match SingleMeasurement::try_from(&buf[..size]) {
                    Ok(mes) => {
                        let id = device_id(src);
                        sink.mark_seen(&id, Instant::now());
                        *counts.entry(id.clone()).or_default() += 1;
                        batches.entry(id).or_default().push(mes);
                    }
                    Err(e) => {
                        if let Some(suppressed) = invalid.record(Instant::now()) {
                            log::warn!(
                                "[{kind}] Invalid measurement from {src} ({size} bytes): {e:?}                                  ({suppressed} more suppressed in the last second)"
                            );
                        }
                    }
                }
            }
            _ = flush.tick() => flush_batches(&mut batches, sink),
            _ = rate_tick.tick() => sink.update_rates(std::mem::take(&mut counts)),
        }
    }
}

fn flush_batches(batches: &mut HashMap<String, Vec<SingleMeasurement>>, sink: &Broadcaster) {
    for (id, batch) in batches.drain() {
        match serde_json::to_string(&batch) {
            Ok(msg) => sink.broadcast_device(&id, msg),
            Err(e) => log::error!("Failed to serialize measurements for {id}: {e}"),
        }
    }
}

/// Rate-limits invalid-packet warnings: a misbehaving sender must not flood
/// the log. Logs at most once per second, reporting how many were skipped.
#[derive(Default)]
struct InvalidPacketLog {
    last_logged: Option<Instant>,
    suppressed: usize,
}

impl InvalidPacketLog {
    /// Returns `Some(suppressed_count)` when this packet should be logged.
    fn record(&mut self, now: Instant) -> Option<usize> {
        match self.last_logged {
            Some(t) if now.duration_since(t) < Duration::from_secs(1) => {
                self.suppressed += 1;
                None
            }
            _ => {
                self.last_logged = Some(now);
                Some(std::mem::take(&mut self.suppressed))
            }
        }
    }
}

pub struct DataRateCounter {
    count: AtomicUsize,
    start: AtomicInstant,
    rate: f32,
}

impl Default for DataRateCounter {
    fn default() -> Self {
        Self {
            count: AtomicUsize::new(0),
            start: AtomicInstant::now(),
            rate: 1.0,
        }
    }
}

impl DataRateCounter {
    /// Add `bytes`; once per `rate` seconds returns the bit rate since the last report.
    pub fn update(&self, bytes: usize) -> Option<(f32, &'static str)> {
        self.update_at(bytes, Instant::now())
    }

    fn update_at(&self, bytes: usize, nnow: Instant) -> Option<(f32, &'static str)> {
        let start = self
            .start
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |start| {
                (nnow.duration_since(start).as_secs_f32() >= self.rate).then_some(nnow)
            });
        match start {
            Ok(start) => {
                let count = self.count.swap(0, Ordering::SeqCst) + bytes;
                let dur = nnow.duration_since(start).as_secs_f32();
                let bits = (count * 8) as f32 / dur;
                Some(match bits {
                    b if b >= 1024.0 * 1024.0 => (b / 1024.0 / 1024.0, "mbps"),
                    b if b >= 1024.0 => (b / 1024.0, "kbps"),
                    b => (b, "bps"),
                })
            }
            Err(_) => {
                self.count.fetch_add(bytes, Ordering::SeqCst);
                None
            }
        }
    }
}

pub fn cleaner_sockaddr<T: ToSocketAddrs + std::fmt::Debug>(s: T) -> Result<SocketAddrV4, String> {
    s.to_socket_addrs()
        .map_err(|e| format!("Failed to resolve address {s:?}: {e}"))?
        .find_map(|addr| match addr {
            SocketAddr::V4(addr) => Some(addr),
            _ => None,
        })
        .ok_or_else(|| format!("No valid IPv4 address found for {s:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kiwi_measurements::{CommonMeasurement, SINGLE_MEASUREMENT_SIZE};

    #[test]
    fn invalid_packet_warnings_are_rate_limited() {
        let mut log = InvalidPacketLog::default();
        let t0 = Instant::now();
        assert_eq!(log.record(t0), Some(0));
        // A burst within the same second is counted, not logged.
        for i in 1..1000 {
            assert_eq!(log.record(t0 + Duration::from_micros(i)), None);
        }
        assert_eq!(log.record(t0 + Duration::from_secs(1)), Some(999));
        assert_eq!(log.record(t0 + Duration::from_millis(1500)), None);
    }

    #[test]
    fn device_id_ignores_source_port() {
        let a: SocketAddr = "192.168.1.20:50001".parse().unwrap();
        let b: SocketAddr = "192.168.1.20:61234".parse().unwrap();
        assert_eq!(device_id(a), "192.168.1.20");
        assert_eq!(device_id(a), device_id(b));
    }

    #[test]
    fn data_rate_reports_bits_per_second() {
        let c = DataRateCounter::default();
        let t0 = c.start.load(Ordering::SeqCst);
        assert!(c.update_at(1000, t0 + Duration::from_millis(500)).is_none());
        let (rate, unit) = c.update_at(1000, t0 + Duration::from_secs(1)).unwrap();
        // 2000 bytes = 16000 bits over 1 s = 15.625 kbps
        assert_eq!(unit, "kbps");
        assert!((rate - 15.625).abs() < 0.01, "{rate}");
    }

    #[test]
    fn measurement_roundtrip_and_rejects_bad_packets() {
        let m = SingleMeasurement {
            measurement: CommonMeasurement::Accel(0.1, -0.2, 0.98),
            timestamp: 1_600_000_123,
        };
        let bytes: [u8; SINGLE_MEASUREMENT_SIZE] = m.into();
        let back = SingleMeasurement::try_from(&bytes[..]).unwrap();
        assert_eq!(back.timestamp, 1_600_000_123);

        let mut corrupt = bytes;
        corrupt[3] ^= 0xFF;
        assert!(SingleMeasurement::try_from(&corrupt[..]).is_err());
        assert!(SingleMeasurement::try_from(&bytes[..10]).is_err());
    }
}
