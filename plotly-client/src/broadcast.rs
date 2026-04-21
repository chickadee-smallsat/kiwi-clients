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
use futures_util::future;
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

pub struct Broadcaster {
    inner: Mutex<BroadcasterInner>,
}

#[derive(Debug, Clone, Default)]
struct BroadcasterInner {
    clients: Vec<mpsc::Sender<sse::Event>>,
    device_clients: HashMap<u16, Vec<mpsc::Sender<sse::Event>>>,
    device_list_clients: Vec<mpsc::Sender<sse::Event>>,
    known_devices: HashMap<u16, Instant>,
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

        let mut ok_device_clients: HashMap<u16, Vec<mpsc::Sender<sse::Event>>> = HashMap::new();
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

        let mut inner = self.inner.lock();
        inner.clients = ok_clients;
        inner.device_clients = ok_device_clients;
        inner.device_list_clients = ok_device_list_clients;
    }

    pub async fn new_client(&self) -> Sse<InfallibleStream<ReceiverStream<sse::Event>>> {
        let (tx, rx) = mpsc::channel(10);
        self.inner.lock().clients.push(tx);
        Sse::from_infallible_receiver(rx)
    }

    pub async fn new_device_client(
        &self,
        port: u16,
    ) -> Sse<InfallibleStream<ReceiverStream<sse::Event>>> {
        let (tx, rx) = mpsc::channel(10);
        let mut inner = self.inner.lock();
        inner.device_clients.entry(port).or_default().push(tx);
        Sse::from_infallible_receiver(rx)
    }

    pub async fn new_device_list_client(&self) -> Sse<InfallibleStream<ReceiverStream<sse::Event>>> {
        let (tx, rx) = mpsc::channel(10);
        self.inner.lock().device_list_clients.push(tx);
        Sse::from_infallible_receiver(rx)
    }

    fn prune_stale_devices_locked(inner: &mut BroadcasterInner) {
        let now = Instant::now();
        inner
            .known_devices
            .retain(|_, last_seen| now.duration_since(*last_seen) <= Duration::from_secs(5));
    }

    pub fn device_seen(&self, port: u16) -> bool {
        let mut inner = self.inner.lock();
        Self::prune_stale_devices_locked(&mut inner);
        let is_new = !inner.known_devices.contains_key(&port);
        inner.known_devices.insert(port, Instant::now());
        is_new
    }

    pub fn known_ports(&self) -> Vec<u16> {
        let mut inner = self.inner.lock();
        Self::prune_stale_devices_locked(&mut inner);
        let mut ports: Vec<u16> = inner.known_devices.keys().copied().collect();
        ports.sort_unstable();
        ports
    }

    pub async fn register_port(&self, port: u16) {
        let is_new = self.device_seen(port);
        if !is_new {
            return;
        }
        let ports = self.known_ports();
        if let Ok(payload) = serde_json::to_string(&ports) {
            self.broadcast_device_list(&payload).await;
        }
    }

    pub async fn broadcast(&self, msg: &str) {
        let clients = self.inner.lock().clients.clone();

        let send_futures = clients
            .iter()
            .map(|client| client.send(sse::Data::new(msg).into()));

        let _ = future::join_all(send_futures).await;
    }

    pub async fn broadcast_device(&self, port: u16, msg: &str) {
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
