use atomic_time::AtomicInstant;
use kiwi_measurements::{SINGLE_MEASUREMENT_SIZE, SingleMeasurement};
use std::{
    net::{SocketAddr, SocketAddrV4, ToSocketAddrs},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{net::UdpSocket, time};

use crate::broadcast::Broadcaster;

// Unicast UDP listener
///
/// This function listens for UDP packets on a specified address and port.
///
/// # Arguments
/// * `address` - The address to listen on.
/// * `port` - The port to listen on.
/// * `sink` - The broadcast channel to send received data to.
/// * `running` - A flag to indicate if the listener should keep running.
///
/// # Returns
/// This function does not return a value. It runs indefinitely until `running` is set to false.
///
pub async fn udp_listener_unicast(
    bind: SocketAddrV4,
    sink: Arc<Broadcaster>,
    running: Arc<AtomicBool>,
) {
    let datarate = DataRateCounter::default();
    while running.load(Ordering::Relaxed) {
        log::trace!("[UDPU] Listening for UDP packets from {bind}");
        let socket = match UdpSocket::bind(bind).await {
            Ok(sock) => sock,
            Err(e) => {
                log::error!("[UDPU] Failed to bind UDP socket: {e}");
                time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };

        // Receive data
        if udp_receive_data("UDPU", &socket, &sink, running.clone(), &datarate)
            .await
            .is_err()
        {
            continue;
        }
    }
    log::trace!("[UDPU] Stopping UDP listener");
}

/// Multicast UDP listener
/// This function listens for UDP packets on a specified multicast address and port.
/// # Arguments
/// * `bind` - The address to bind the socket to.
/// * `address` - The multicast address to listen on.
/// * `port` - The port to listen on.
/// * `interface` - The network interface to bind to.
/// * `sink` - The broadcast channel to send received data to.
/// * `running` - A flag to indicate if the listener should keep running.
///
/// # Returns
/// This function does not return a value. It runs indefinitely until `running` is set to false.
///
/// # Panics
/// This function will panic if the addreses are invalid, or IPv4 is not used.
#[allow(dead_code)]
pub async fn udp_listener_multicast(
    bind: SocketAddrV4,
    address: SocketAddrV4,
    interface: SocketAddrV4,
    sink: Arc<Broadcaster>,
    running: Arc<AtomicBool>,
) {
    let iface = interface.ip();
    let datarate = DataRateCounter::default();

    while running.load(Ordering::Relaxed) {
        log::trace!("[UDPM] Listening for UDP packets from {address} on interface {interface}",);
        let socket = match UdpSocket::bind(bind).await {
            Ok(sock) => sock,
            Err(e) => {
                log::error!("[UDPM] Failed to bind UDP socket: {e}");
                time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        let socket = match socket.into_std() {
            Ok(socket) => socket,
            Err(e) => {
                log::error!("[UDPM] Failed to convert UdpSocket to std::net::UdpSocket: {e}");
                time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        let socket = socket2::Socket::from(socket);
        if let Err(e) = socket.set_reuse_address(true) {
            log::error!("[UDPM] Failed to set socket to reuse address: {e}");
            time::sleep(Duration::from_secs(1)).await;
            continue;
        }

        if let Err(e) = socket.join_multicast_v4(address.ip(), iface) {
            log::error!("[UDPM] Failed to join multicast group: {e}");
            time::sleep(Duration::from_secs(1)).await;
            continue;
        };
        log::trace!("[UDPM] Successfully joined multicast group");

        let socket = match UdpSocket::from_std(socket.into()) {
            Ok(sock) => sock,
            Err(e) => {
                log::error!("[UDPM] Failed to convert std::net::UdpSocket back to UdpSocket: {e}");
                panic!("[UDPM] Cannot continue without a valid UdpSocket");
            }
        };

        // Receive data
        if udp_receive_data("UDPM", &socket, &sink, running.clone(), &datarate)
            .await
            .is_err()
        {
            continue;
        }
    }
    log::trace!("[UDPM] Stopping UDP listener");
}

async fn udp_receive_data(
    kind: &str,
    socket: &UdpSocket,
    sink: &Broadcaster,
    running: Arc<AtomicBool>,
    datarate: &DataRateCounter,
) -> Result<(), ()> {
    // Receive data
    let mut buf = Vec::new();
    let mut xmit = false;
    'receive: while running.load(Ordering::Relaxed) {
        let start = Instant::now();
        if xmit {
            // Timeout, check if we need to send the buffer
            if !buf.is_empty() {
                sink.broadcast(
                    &serde_json::to_string(&buf).expect("Failed to serialize measurements"),
                )
                .await;
                buf.clear();
            } else {
                log::trace!("[{kind}] No data received, continuing to listen");
                Err(())?; // Exit if no data received
            }
            xmit = false;
        }
        // Inner loop to fill the buffer, and send it when full or timeout
        while running.load(Ordering::Relaxed) {
            let mut sbuf = [0u8; SINGLE_MEASUREMENT_SIZE]; // 16KB buffer for receiving
            tokio::select! {
                res = socket.recv_from(&mut sbuf) => {
                    match res {
                        Ok((size, _src)) => {
                            if let Some((rate, unit)) = datarate.update(size) {
                                log::info!("[{kind}] Receiving data rate: {rate:.3} {unit}");
                            }
                            if let Ok(mes) = SingleMeasurement::try_from(&sbuf[..size]).inspect_err(|e| {
                                log::warn!("[{kind}] Received invalid measurement: {e:?}");
                            }) {
                                buf.push(mes);
                            }
                        }
                        Err(_) => {
                            Err(())?; // Exit on error
                        }
                    }
                    if start.elapsed() >= Duration::from_millis(100) {
                        xmit = true;
                        continue 'receive;
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(100)) => {
                    xmit = true;
                    continue 'receive;
                }
            }
        }
    }
    Ok(())
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
    pub fn update(&self, bytes: usize) -> Option<(f32, &str)> {
        let nnow = Instant::now();
        match self
            .start
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |start| {
                if nnow.duration_since(start).as_secs_f32() >= self.rate {
                    Some(nnow)
                } else {
                    None
                }
            })
            .ok()
        {
            Some(start) => {
                let count = self.count.swap(0, Ordering::SeqCst) + bytes;
                if count == 0 {
                    None
                } else {
                    let dur = nnow.duration_since(start).as_secs_f32();
                    let bytes = (count * 8) as f32;
                    Some(match bytes {
                        b if b >= 1024.0 * 1024.0 => (bytes / 1024.0 / 1024.0 / dur, "mbps"),
                        b if b >= 1024.0 => (bytes / 1024.0 / dur, "kbps"),
                        b => (b / dur, "bps"),
                    })
                }
            }
            None => {
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
