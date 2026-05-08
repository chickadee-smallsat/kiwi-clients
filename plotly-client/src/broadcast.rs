use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};

use actix_web::rt::time::interval;
use actix_web_lab::{
    sse::{self, Sse},
    util::InfallibleStream,
};
use futures_util::future;
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

const DEVICE_TIMEOUT: Duration = Duration::from_secs(3);

pub struct Broadcaster {
    inner: Mutex<BroadcasterInner>,
}

#[derive(Debug, Clone, Default)]
struct BroadcasterInner {
    clients: Vec<mpsc::Sender<sse::Event>>,
    device_clients: HashMap<String, Vec<mpsc::Sender<sse::Event>>>,
    device_list_clients: Vec<mpsc::Sender<sse::Event>>,
    known_devices: HashMap<String, Instant>,
    packet_rates: HashMap<String, usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfo {
    pub port: String,
    pub rate: usize,
}

impl Broadcaster {
    pub fn create() -> Arc<Self> {
        let this = Arc::new(Broadcaster {
            inner: Mutex::new(BroadcasterInner::default()),
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

    async fn remove_stale_clients(&self) {
        let (clients, device_clients, device_list_clients) = {
            let inner = self.inner.lock();
            (
                inner.clients.clone(),
                inner.device_clients.clone(),
                inner.device_list_clients.clone(),
            )
        };

        let mut ok_clients = Vec::new();
        for client in clients {
            if client
                .send(sse::Event::Comment("ping".into()))
                .await
                .is_ok()
            {
                ok_clients.push(client.clone());
            }
        }

        let mut ok_device_clients: HashMap<String, Vec<mpsc::Sender<sse::Event>>> = HashMap::new();
        for (port, list) in device_clients {
            let mut ok_list = Vec::new();

            for client in list {
                if client
                    .send(sse::Event::Comment("ping".into()))
                    .await
                    .is_ok()
                {
                    ok_list.push(client.clone());
                }
            }

            if !ok_list.is_empty() {
                ok_device_clients.insert(port, ok_list);
            }
        }

        let mut ok_device_list_clients = Vec::new();
        for client in device_list_clients {
            if client
                .send(sse::Event::Comment("ping".into()))
                .await
                .is_ok()
            {
                ok_device_list_clients.push(client.clone());
            }
        }

        let (devices_changed, device_infos) = {
            let mut inner = self.inner.lock();

            let cutoff = Instant::now() - DEVICE_TIMEOUT;
            let before = inner.known_devices.len();
            inner
                .known_devices
                .retain(|_, last_seen| *last_seen >= cutoff);

            let live_ports: HashSet<String> = inner.known_devices.keys().cloned().collect();
            inner
                .packet_rates
                .retain(|port, _| live_ports.contains(port));

            let devices_changed = before != inner.known_devices.len();
            let device_infos = Self::build_device_infos(&inner);

            inner.clients = ok_clients;
            inner.device_clients = ok_device_clients;
            inner.device_list_clients = ok_device_list_clients;

            (devices_changed, device_infos)
        };

        if devices_changed {
            if let Ok(payload) = serde_json::to_string(&device_infos) {
                self.broadcast_device_list(&payload).await;
            }
        }
    }

    fn build_device_infos(inner: &BroadcasterInner) -> Vec<DeviceInfo> {
        let cutoff = Instant::now() - DEVICE_TIMEOUT;
        inner
            .known_devices
            .iter()
            .filter(|(_, last_seen)| **last_seen >= cutoff)
            .map(|(port, _)| DeviceInfo {
                port: port.clone(),
                rate: inner.packet_rates.get(port).copied().unwrap_or(0),
            })
            .collect()
    }

    pub async fn new_client(&self) -> Sse<InfallibleStream<ReceiverStream<sse::Event>>> {
        // 256-slot buffer: at ~10 SSE events/s a slow browser tab has 25 s
        // of headroom before we drop it at the next 10-s stale-client ping.
        let (tx, rx) = mpsc::channel(256);
        self.inner.lock().clients.push(tx);
        Sse::from_infallible_receiver(rx)
    }

    pub async fn new_device_client(
        &self,
        port: String,
    ) -> Sse<InfallibleStream<ReceiverStream<sse::Event>>> {
        let (tx, rx) = mpsc::channel(256);
        let mut inner = self.inner.lock();
        inner.device_clients.entry(port).or_default().push(tx);
        Sse::from_infallible_receiver(rx)
    }

    pub async fn new_device_list_client(&self) -> Sse<InfallibleStream<ReceiverStream<sse::Event>>> {
        // Device-list events are infrequent; 64 slots is ample.
        let (tx, rx) = mpsc::channel(64);
        self.inner.lock().device_list_clients.push(tx);
        Sse::from_infallible_receiver(rx)
    }

    pub fn mark_device_seen(&self, port: String) -> bool {
        let mut inner = self.inner.lock();
        let is_new = !inner.known_devices.contains_key(&port);
        inner.known_devices.insert(port, Instant::now());
        is_new
    }

    pub fn known_devices(&self) -> Vec<DeviceInfo> {
        let cutoff = Instant::now() - DEVICE_TIMEOUT;

        let mut inner = self.inner.lock();
        inner
            .known_devices
            .retain(|_, last_seen| *last_seen >= cutoff);

        Self::build_device_infos(&inner)
    }

    pub async fn update_packet_rate(&self, port: String, rate: usize) {
        let device_infos = {
            let mut inner = self.inner.lock();
            inner.packet_rates.insert(port, rate);
            Self::build_device_infos(&inner)
        };

        if let Ok(payload) = serde_json::to_string(&device_infos) {
            self.broadcast_device_list(&payload).await;
        }
    }

    pub async fn register_port(&self, port: String) {
        let is_new = self.mark_device_seen(port);

        if is_new {
            let device_infos = self.known_devices();

            if let Ok(payload) = serde_json::to_string(&device_infos) {
                self.broadcast_device_list(&payload).await;
            }
        }
    }

    #[allow(dead_code)]
    pub async fn broadcast(&self, msg: &str) {
        let clients = self.inner.lock().clients.clone();

        let send_futures = clients
            .iter()
            .map(|client| client.send(sse::Data::new(msg).into()));

        let _ = future::join_all(send_futures).await;
    }

    pub async fn broadcast_device(&self, port: String, msg: &str) {
        let clients = self
            .inner
            .lock()
            .device_clients
            .get(&port)
            .cloned()
            .unwrap_or_default();

        let send_futures = clients
            .iter()
            .map(|client| client.send(sse::Data::new(msg).into()));

        let _ = future::join_all(send_futures).await;
    }

    pub async fn broadcast_device_list(&self, msg: &str) {
        let clients = self.inner.lock().device_list_clients.clone();

        let send_futures = clients
            .iter()
            .map(|client| client.send(sse::Data::new(msg).into()));

        let _ = future::join_all(send_futures).await;
    }
}
