//! Fan-out of device data to browser clients over Server-Sent Events.
//!
//! Every operation here is synchronous and non-blocking: messages are queued
//! with `try_send`, so a slow or frozen browser tab can never stall the UDP
//! receive loop. A client whose queue is full (or whose connection closed) is
//! dropped; the browser's `EventSource` reconnects on its own.

use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use actix_web::rt::time::interval;
use actix_web_lab::{
    sse::{self, Sse},
    util::InfallibleStream,
};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::mpsc::{self, error::TrySendError};
use tokio_stream::wrappers::ReceiverStream;

/// A device disappears from the list after this long without a packet.
pub const DEVICE_TIMEOUT: Duration = Duration::from_secs(3);
/// How often stale devices and dead clients are pruned.
const PRUNE_INTERVAL: Duration = Duration::from_secs(2);
/// Per-client queue for measurement batches. Batches go out every 100 ms, so
/// this is ~25 s of headroom before a stalled client is dropped.
const DEVICE_CLIENT_QUEUE: usize = 256;
/// Device-list updates are at most ~1/s per device.
const LIST_CLIENT_QUEUE: usize = 64;

type Client = mpsc::Sender<sse::Event>;
pub type SseStream = Sse<InfallibleStream<ReceiverStream<sse::Event>>>;

pub struct Broadcaster {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    device_clients: HashMap<String, Vec<Client>>,
    device_list_clients: Vec<Client>,
    devices: HashMap<String, DeviceState>,
}

struct DeviceState {
    last_seen: Instant,
    /// Valid packets received during the last full second.
    rate: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeviceInfo {
    pub id: String,
    pub rate: usize,
}

/// Queue `event` on every client, keeping only the ones that accepted it.
/// Returns how many were dropped for being too slow (closed ones are not counted).
fn send_all(clients: &mut Vec<Client>, event: &sse::Event) -> usize {
    let mut slow = 0;
    clients.retain(|c| match c.try_send(event.clone()) {
        Ok(()) => true,
        Err(TrySendError::Full(_)) => {
            slow += 1;
            false
        }
        Err(TrySendError::Closed(_)) => false,
    });
    slow
}

impl Inner {
    fn device_infos(&self) -> Vec<DeviceInfo> {
        let mut list: Vec<_> = self
            .devices
            .iter()
            .map(|(id, d)| DeviceInfo {
                id: id.clone(),
                rate: d.rate,
            })
            .collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    fn publish_device_list(&mut self) {
        let Ok(payload) = serde_json::to_string(&self.device_infos()) else {
            return;
        };
        send_all(
            &mut self.device_list_clients,
            &sse::Data::new(payload).into(),
        );
    }

    /// Forget devices not seen since `cutoff`. Returns true if any were removed.
    fn expire_devices(&mut self, cutoff: Instant) -> bool {
        let before = self.devices.len();
        self.devices.retain(|_, d| d.last_seen >= cutoff);
        before != self.devices.len()
    }
}

impl Broadcaster {
    /// Create a broadcaster and start its background prune task.
    pub fn create() -> Arc<Self> {
        let this = Arc::new(Self::new());
        let pruner = Arc::clone(&this);
        actix_web::rt::spawn(async move {
            let mut tick = interval(PRUNE_INTERVAL);
            loop {
                tick.tick().await;
                pruner.prune(Instant::now());
            }
        });
        this
    }

    fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
        }
    }

    /// Drop devices that timed out and clients whose connection is gone.
    fn prune(&self, now: Instant) {
        let mut inner = self.inner.lock();
        let ping: sse::Event = sse::Event::Comment("ping".into());

        send_all(&mut inner.device_list_clients, &ping);
        inner.device_clients.retain(|_, list| {
            send_all(list, &ping);
            !list.is_empty()
        });

        if inner.expire_devices(now - DEVICE_TIMEOUT) {
            inner.publish_device_list();
        }
    }

    pub fn new_device_client(&self, id: String) -> SseStream {
        Sse::from_infallible_receiver(self.subscribe_device(id))
    }

    /// Subscribe to the device list. The current list is sent immediately.
    pub fn new_device_list_client(&self) -> SseStream {
        Sse::from_infallible_receiver(self.subscribe_device_list())
    }

    fn subscribe_device(&self, id: String) -> mpsc::Receiver<sse::Event> {
        let (tx, rx) = mpsc::channel(DEVICE_CLIENT_QUEUE);
        self.inner
            .lock()
            .device_clients
            .entry(id)
            .or_default()
            .push(tx);
        rx
    }

    fn subscribe_device_list(&self) -> mpsc::Receiver<sse::Event> {
        let (tx, rx) = mpsc::channel(LIST_CLIENT_QUEUE);
        let mut inner = self.inner.lock();
        if let Ok(payload) = serde_json::to_string(&inner.device_infos()) {
            let _ = tx.try_send(sse::Data::new(payload).into());
        }
        inner.device_list_clients.push(tx);
        rx
    }

    pub fn known_devices(&self) -> Vec<DeviceInfo> {
        let mut inner = self.inner.lock();
        inner.expire_devices(Instant::now() - DEVICE_TIMEOUT);
        inner.device_infos()
    }

    /// Record that a packet arrived from `id`. Announces new devices.
    pub fn mark_seen(&self, id: &str, now: Instant) {
        let mut inner = self.inner.lock();
        match inner.devices.get_mut(id) {
            Some(d) => d.last_seen = now,
            None => {
                inner.devices.insert(
                    id.to_owned(),
                    DeviceState {
                        last_seen: now,
                        rate: 0,
                    },
                );
                inner.publish_device_list();
            }
        }
    }

    /// Store per-device packet rates for the last second and publish them.
    pub fn update_rates(&self, rates: HashMap<String, usize>) {
        let mut inner = self.inner.lock();
        for d in inner.devices.values_mut() {
            d.rate = 0;
        }
        for (id, rate) in rates {
            if let Some(d) = inner.devices.get_mut(&id) {
                d.rate = rate;
            }
        }
        inner.publish_device_list();
    }

    /// Send a JSON batch to every client watching `id`.
    pub fn broadcast_device(&self, id: &str, msg: String) {
        let mut inner = self.inner.lock();
        if let Some(list) = inner.device_clients.get_mut(id) {
            let slow = send_all(list, &sse::Data::new(msg).into());
            if slow > 0 {
                log::warn!("Dropped {slow} client(s) of device {id} that fell too far behind");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(cap: usize) -> (Client, mpsc::Receiver<sse::Event>) {
        mpsc::channel(cap)
    }

    #[test]
    fn new_device_is_listed_and_expires() {
        let b = Broadcaster::new();
        let t0 = Instant::now();
        b.mark_seen("10.0.0.5", t0);
        assert_eq!(
            b.known_devices(),
            vec![DeviceInfo {
                id: "10.0.0.5".into(),
                rate: 0
            }]
        );

        b.prune(t0 + DEVICE_TIMEOUT + Duration::from_millis(1));
        assert!(b.known_devices().is_empty());
    }

    #[test]
    fn rates_apply_only_to_known_devices_and_reset() {
        let b = Broadcaster::new();
        let now = Instant::now();
        b.mark_seen("a", now);
        b.mark_seen("b", now);

        b.update_rates(HashMap::from([("a".into(), 50), ("ghost".into(), 9)]));
        let list = b.known_devices();
        assert_eq!(
            list[0],
            DeviceInfo {
                id: "a".into(),
                rate: 50
            }
        );
        assert_eq!(
            list[1],
            DeviceInfo {
                id: "b".into(),
                rate: 0
            }
        );

        // A device that sent nothing in the next second reads 0, not a stale value.
        b.update_rates(HashMap::new());
        assert!(b.known_devices().iter().all(|d| d.rate == 0));
    }

    #[test]
    fn broadcast_reaches_only_matching_device() {
        let b = Broadcaster::new();
        let mut rx_a = b.subscribe_device("a".into());
        let mut rx_b = b.subscribe_device("b".into());

        b.broadcast_device("a", "[1]".into());
        assert!(rx_a.try_recv().is_ok());
        assert!(rx_b.try_recv().is_err());
    }

    #[test]
    fn full_client_is_dropped_without_blocking() {
        let b = Broadcaster::new();
        let (slow, _rx_slow) = client(1);
        let (fast, mut rx_fast) = client(8);
        b.inner
            .lock()
            .device_clients
            .insert("a".into(), vec![slow, fast]);

        // The slow client's single slot fills, the second send drops it.
        b.broadcast_device("a", "1".into());
        b.broadcast_device("a", "2".into());
        assert_eq!(b.inner.lock().device_clients["a"].len(), 1);
        assert!(rx_fast.try_recv().is_ok());
        assert!(rx_fast.try_recv().is_ok());
    }

    #[test]
    fn closed_clients_are_pruned() {
        let b = Broadcaster::new();
        drop(b.subscribe_device("a".into()));
        b.prune(Instant::now());
        assert!(b.inner.lock().device_clients.is_empty());
    }

    #[test]
    fn list_client_gets_current_list_on_subscribe() {
        let b = Broadcaster::new();
        b.mark_seen("a", Instant::now());
        let mut rx = b.subscribe_device_list();
        assert!(rx.try_recv().is_ok());
        // New devices are announced to subscribers.
        b.mark_seen("b", Instant::now());
        assert!(rx.try_recv().is_ok());
    }
}
