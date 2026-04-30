use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, atomic::{AtomicU64, Ordering}},
    time::Duration,
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
    known_devices: HashSet<String>,
}

impl Broadcaster {
    pub fn create(max_misses: u32) -> Arc<Self> {
        let this = Arc::new(Broadcaster {
            inner: Mutex::new(BroadcasterInner::default()),
            max_misses,
            next_id: AtomicU64::new(0),
        });
        Broadcaster::spawn_ping(Arc::clone(&this));
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

    /// Called the first time a UDP source address is seen.
    /// Inserts the device into the known set and broadcasts the updated list to every SSE client.
    pub async fn register_device(&self, device_id: &str) {
        let payload = {
            let mut inner = self.inner.lock().await;
            if !inner.known_devices.insert(device_id.to_string()) {
                return; // already known — no broadcast needed
            }
            serde_json::to_string(&inner.known_devices.iter().collect::<Vec<_>>()).ok()
        };
        if let Some(payload) = payload {
            self.broadcast_device_list(&payload).await;
        }
    }

    pub async fn known_devices(&self) -> Vec<String> {
        self.inner.lock().await.known_devices.iter().cloned().collect()
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
