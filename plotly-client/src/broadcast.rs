use std::{
    collections::HashMap,
    sync::{Arc, atomic::{AtomicU64, Ordering}},
    time::{Duration, Instant},
};

use actix_web::rt::time::interval;
use actix_web_lab::{
    sse::{self, Sse},
    util::InfallibleStream,
};
use tokio::sync::{Mutex, mpsc};
use tokio_stream::wrappers::ReceiverStream;

#[derive(Debug)]
struct ClientEntry {
    tx: mpsc::Sender<sse::Event>,
    misses: u32,
}

impl ClientEntry {
    fn new(tx: mpsc::Sender<sse::Event>) -> Self {
        Self { tx, misses: 0 }
    }
}

pub struct Broadcaster {
    inner: Mutex<BroadcasterInner>,
    max_misses: u32,
    next_id: AtomicU64,
}

#[derive(Debug, Default)]
struct BroadcasterInner {
    /// Internal u64 key is only used for stale-client eviction; never exposed to callers.
    clients: HashMap<u64, ClientEntry>,
    /// Maps device ID → last time a UDP packet was received from that device.
    known_devices: HashMap<String, Instant>,
    /// Maps device ID → friendly name from the Id measurement packet.
    device_names: HashMap<String, String>,
}

/// Device entry returned by the `/devices` endpoint and the `devices` SSE event.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceInfo {
    /// UDP source address (e.g. `"192.168.1.5:8099"`).
    pub id: String,
    /// Friendly name from the `Id` measurement, or the address if not yet received.
    pub name: String,
}

/// Build the JSON payload for the `devices` SSE event / HTTP response from a locked inner state.
fn build_devices_json(inner: &BroadcasterInner) -> Option<String> {
    let entries: Vec<DeviceInfo> = inner.known_devices.keys().map(|id| {
        let name = inner.device_names.get(id).cloned().unwrap_or_else(|| id.clone());
        DeviceInfo { id: id.clone(), name }
    }).collect();
    serde_json::to_string(&entries).ok()
}

impl Broadcaster {
    pub fn create(max_misses: u32) -> Arc<Self> {
        let this = Arc::new(Broadcaster {
            inner: Mutex::new(BroadcasterInner::default()),
            max_misses,
            next_id: AtomicU64::new(0),
        });
        Broadcaster::spawn_ping(Arc::clone(&this));
        Broadcaster::spawn_device_watchdog(Arc::clone(&this));
        this
    }

    fn spawn_ping(this: Arc<Self>) {
        actix_web::rt::spawn(async move {
            let mut interval = interval(Duration::from_secs(10));
            loop {
                interval.tick().await;
                this.remove_stale_clients().await;
            }
        });
    }

    /// Evicts devices that have not sent a UDP packet in the last 10 seconds and broadcasts the
    /// updated device list if anything changed.
    fn spawn_device_watchdog(this: Arc<Self>) {
        const DEVICE_TIMEOUT: Duration = Duration::from_secs(10);
        actix_web::rt::spawn(async move {
            let mut ticker = interval(Duration::from_secs(5));
            loop {
                ticker.tick().await;
                let now = Instant::now();
                let payload = {
                    let mut inner = this.inner.lock().await;
                    let before = inner.known_devices.len();
                    inner.known_devices.retain(|_, last_seen| {
                        now.duration_since(*last_seen) < DEVICE_TIMEOUT
                    });
                    if inner.known_devices.len() == before {
                        continue; // nothing changed
                    }
                    // Also prune names for evicted devices.
                    let active: std::collections::HashSet<String> =
                        inner.known_devices.keys().cloned().collect();
                    inner.device_names.retain(|id, _| active.contains(id));
                    build_devices_json(&inner)
                };
                if let Some(payload) = payload {
                    this.broadcast_device_list(&payload).await;
                }
            }
        });
    }

    /// Pings every client; marks closed channels as misses, evicts those over the limit.
    /// Uses `try_send` so the ping loop never blocks on a slow (but alive) client.
    async fn remove_stale_clients(&self) {
        use mpsc::error::TrySendError;
        let max_misses = self.max_misses;
        let mut inner = self.inner.lock().await;

        for entry in inner.clients.values_mut() {
            match entry.tx.try_send(sse::Event::Comment("ping".into())) {
                Ok(()) | Err(TrySendError::Full(_)) => { entry.misses = 0; }
                Err(TrySendError::Closed(_)) => { entry.misses += 1; }
            }
        }
        inner.clients.retain(|_, e| e.misses < max_misses);
    }

    /// Creates a new SSE client and returns the stream directly.
    /// No client-ID handshake; routing is done client-side via the device field on each message.
    pub async fn new_client(&self) -> Sse<InfallibleStream<ReceiverStream<sse::Event>>> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel(100);
        self.inner.lock().await.clients.insert(id, ClientEntry::new(tx));
        Sse::from_infallible_receiver(rx)
    }

    /// Updates the last-seen timestamp for `device_id`.
    /// If this is the first time the device has been seen, broadcasts the updated device list.
    pub async fn register_device(&self, device_id: &str) {
        let now = Instant::now();
        let payload = {
            let mut inner = self.inner.lock().await;
            let is_new = inner.known_devices.insert(device_id.to_string(), now).is_none();
            if !is_new {
                return; // timestamp refreshed; no broadcast needed
            }
            build_devices_json(&inner)
        };
        if let Some(payload) = payload {
            self.broadcast_device_list(&payload).await;
        }
    }

    /// Records the friendly name for a device from an `Id` measurement packet.
    /// Broadcasts a `rename` SSE event if the name is new or changed.
    pub async fn rename_device(&self, device_id: &str, name: &str) {
        let changed = {
            let mut inner = self.inner.lock().await;
            let prev = inner.device_names.get(device_id).map(|s| s.as_str());
            if prev == Some(name) {
                false
            } else {
                inner.device_names.insert(device_id.to_string(), name.to_string());
                true
            }
        };
        if !changed {
            return;
        }
        let device_json = serde_json::to_string(device_id).unwrap_or_default();
        let name_json = serde_json::to_string(name).unwrap_or_default();
        let msg = format!(r#"{{"device":{device_json},"name":{name_json}}}"#);
        let inner = self.inner.lock().await;
        for entry in inner.clients.values() {
            let _ = entry.tx.try_send(sse::Data::new(msg.as_str()).event("rename").into());
        }
    }

    pub async fn known_devices(&self) -> Vec<DeviceInfo> {
        let inner = self.inner.lock().await;
        inner.known_devices.keys().map(|id| {
            let name = inner.device_names.get(id).cloned().unwrap_or_else(|| id.clone());
            DeviceInfo { id: id.clone(), name }
        }).collect()
    }

    /// Broadcasts device measurement data to ALL SSE clients tagged with the source device ID.
    /// Clients perform device filtering on their end — no server-side subscription state needed.
    pub async fn broadcast_data(&self, device_id: &str, payload_json: &str) {
        let device_json = serde_json::to_string(device_id).unwrap_or_default();
        let msg = format!(r#"{{"device":{},"payload":{}}}"#, device_json, payload_json);
        let inner = self.inner.lock().await;
        for entry in inner.clients.values() {
            let _ = entry.tx.try_send(sse::Data::new(msg.as_str()).event("data").into());
        }
    }

    /// Broadcasts the device list to ALL SSE clients using named event `"devices"`.
    pub async fn broadcast_device_list(&self, devices_json: &str) {
        let inner = self.inner.lock().await;
        for entry in inner.clients.values() {
            let _ = entry.tx.try_send(sse::Data::new(devices_json).event("devices").into());
        }
    }
}
