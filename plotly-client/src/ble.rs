//! Bluetooth LE receiver: scans for Kiwi devices advertising the Kiwi data
//! service, connects, subscribes to the measurement characteristic and feeds
//! the notified packets into the [`Broadcaster`], exactly like UDP packets.
//!
//! A Kiwi only streams over BLE after its BOOTSEL button has been pressed to
//! switch it from WiFi to Bluetooth mode. It accepts several clients at once
//! and needs no pairing.

use std::{collections::HashSet, sync::Arc, time::Duration};

use btleplug::{
    api::{Central, CentralEvent, CentralState, Manager as _, Peripheral as _, ScanFilter},
    platform::{Adapter, Manager, Peripheral, PeripheralId},
};
use futures_util::StreamExt;
use kiwi_measurements::{CommonMeasurement, SINGLE_MEASUREMENT_SIZE, SingleMeasurement};
use parking_lot::Mutex;
use tokio::{
    sync::watch,
    task::JoinSet,
    time::{self, Instant},
};
use uuid::Uuid;

use crate::{broadcast::Broadcaster, udp::DataRateCounter};

/// Kiwi data service, advertised by the firmware in BLE mode
pub const KIWI_SERVICE_UUID: Uuid = Uuid::from_u128(0x6b697769_0001_4a6e_8f3b_2c9d5e7a1b00);
/// Measurement characteristic: one or more back-to-back `SingleMeasurement`s
/// per notification
pub const KIWI_MEASUREMENT_UUID: Uuid = Uuid::from_u128(0x6b697769_0002_4a6e_8f3b_2c9d5e7a1b00);

/// How long to wait before retrying when no adapter is available or scanning failed
const RETRY_DELAY: Duration = Duration::from_secs(5);
/// How often already-known peripherals are re-checked, in case a discovery
/// event was missed (e.g. a device that came back after disconnecting)
const RESCAN_PERIOD: Duration = Duration::from_secs(5);
/// Timeout for connecting and for service discovery
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Measurements are batched and forwarded to the broadcaster at this period,
/// matching the UDP listener
const FLUSH_PERIOD: Duration = Duration::from_millis(100);
/// How long sessions get to disconnect cleanly on shutdown
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
/// How often a streaming session checks that its link is still up
const LIVENESS_PERIOD: Duration = Duration::from_secs(2);
/// A session that receives nothing for this long is considered dead. The
/// firmware notifies at least an RSSI packet every 2 s while connected.
const IDLE_TIMEOUT: Duration = Duration::from_secs(10);

/// Stop signal: becomes `true` (or the sender is dropped) when the receiver must shut down
pub type Stop = watch::Receiver<bool>;

/// Resolves once `stop` is set
async fn stopped(stop: &mut Stop) {
    let _ = stop.wait_for(|stop| *stop).await;
}

/// Runs the BLE receiver until `stop` is set.
///
/// On shutdown every connected Kiwi is disconnected explicitly: the OS Bluetooth
/// stack would otherwise keep the link up, and the Kiwi would not advertise to
/// other clients until the link times out.
pub async fn ble_listener(sink: Arc<Broadcaster>, stop: Stop) {
    let mut sessions = JoinSet::new();
    let mut stop_wait = stop.clone();
    tokio::select! {
        _ = discover(&sink, &stop, &mut sessions) => {}
        _ = stopped(&mut stop_wait) => {}
    }
    // Sessions watch the same stop signal and disconnect on their own
    let drained = time::timeout(SHUTDOWN_TIMEOUT, async {
        while sessions.join_next().await.is_some() {}
    })
    .await;
    if drained.is_err() {
        log::warn!("[BLE] Timed out waiting for BLE sessions to disconnect");
    }
    sessions.shutdown().await;
    log::trace!("[BLE] Stopped BLE listener");
}

/// Finds a Bluetooth adapter and keeps scanning on it, forever.
async fn discover(sink: &Arc<Broadcaster>, stop: &Stop, sessions: &mut JoinSet<()>) {
    let manager = loop {
        match Manager::new().await {
            Ok(manager) => break manager,
            Err(e) => {
                log::warn!("[BLE] Bluetooth unavailable ({e}), retrying in {RETRY_DELAY:?}");
                time::sleep(RETRY_DELAY).await;
            }
        }
    };
    // Peripherals that currently have a session running
    let active: Arc<Mutex<HashSet<PeripheralId>>> = Arc::default();
    loop {
        let adapter = match manager.adapters().await {
            Ok(adapters) => adapters.into_iter().next(),
            Err(e) => {
                log::warn!("[BLE] Failed to list Bluetooth adapters: {e}");
                None
            }
        };
        let Some(adapter) = adapter else {
            log::warn!("[BLE] No Bluetooth adapter found, retrying in {RETRY_DELAY:?}");
            time::sleep(RETRY_DELAY).await;
            continue;
        };
        let ctx = ScanContext {
            adapter: &adapter,
            sink,
            stop,
            active: &active,
        };
        if let Err(e) = ctx.scan(sessions).await {
            log::warn!("[BLE] Scanning stopped ({e}), retrying in {RETRY_DELAY:?}");
            time::sleep(RETRY_DELAY).await;
        }
    }
}

struct ScanContext<'a> {
    adapter: &'a Adapter,
    sink: &'a Arc<Broadcaster>,
    stop: &'a Stop,
    active: &'a Arc<Mutex<HashSet<PeripheralId>>>,
}

impl ScanContext<'_> {
    /// Scans for Kiwi devices and spawns a session for each one found. Only
    /// returns on error.
    async fn scan(&self, sessions: &mut JoinSet<()>) -> btleplug::Result<()> {
        let adapter = self.adapter;
        let mut events = adapter.events().await?;
        adapter
            .start_scan(ScanFilter {
                services: vec![KIWI_SERVICE_UUID],
            })
            .await?;
        log::info!(
            "[BLE] Scanning for Kiwi devices on {}",
            adapter.adapter_info().await.unwrap_or_default()
        );
        let mut rescan = time::interval(RESCAN_PERIOD);
        loop {
            tokio::select! {
                event = events.next() => match event {
                    Some(
                        CentralEvent::DeviceDiscovered(id)
                        | CentralEvent::DeviceUpdated(id)
                        | CentralEvent::ServicesAdvertisement { id, .. },
                    ) => self.try_start_session(&id, sessions).await,
                    Some(CentralEvent::StateUpdate(state)) => {
                        if state == CentralState::PoweredOff {
                            log::warn!("[BLE] Bluetooth adapter is powered off");
                        } else {
                            log::info!("[BLE] Bluetooth adapter state: {state:?}");
                        }
                    }
                    Some(_) => {}
                    None => {
                        return Err(btleplug::Error::Other("adapter event stream ended".into()));
                    }
                },
                _ = rescan.tick() => {
                    // Reap finished sessions
                    while sessions.try_join_next().is_some() {}
                    for peripheral in adapter.peripherals().await.unwrap_or_default() {
                        self.try_start_session(&peripheral.id(), sessions).await;
                    }
                }
            }
        }
    }

    /// Starts a session for peripheral `id` if it is a Kiwi and none is running yet.
    async fn try_start_session(&self, id: &PeripheralId, sessions: &mut JoinSet<()>) {
        if self.active.lock().contains(id) {
            return;
        }
        let Ok(peripheral) = self.adapter.peripheral(id).await else {
            return;
        };
        // The scan filter is not honoured by every platform, so check again
        let Ok(Some(props)) = peripheral.properties().await else {
            return;
        };
        if !props.services.contains(&KIWI_SERVICE_UUID) {
            return;
        }
        if !self.active.lock().insert(id.clone()) {
            return;
        }
        let name = props.local_name.or(props.advertisement_name);
        let (sink, stop, active, id) = (
            self.sink.clone(),
            self.stop.clone(),
            self.active.clone(),
            id.clone(),
        );
        sessions.spawn(async move {
            let label = name.clone().unwrap_or_else(|| id.to_string());
            if let Err(e) = session(&peripheral, name, &sink, stop).await {
                log::warn!("[BLE] {label}: {e}");
            }
            if time::timeout(SHUTDOWN_TIMEOUT, peripheral.disconnect())
                .await
                .is_err()
            {
                log::warn!("[BLE] {label}: timed out disconnecting");
            }
            active.lock().remove(&id);
            log::info!("[BLE] {label}: disconnected");
        });
    }
}

/// Connects to a Kiwi and streams its measurements until it disconnects or
/// `stop` is set.
async fn session(
    peripheral: &Peripheral,
    name: Option<String>,
    sink: &Broadcaster,
    mut stop: Stop,
) -> btleplug::Result<()> {
    let device_id = format!("BLE {}", peripheral.id());
    let label = name.clone().unwrap_or_else(|| device_id.clone());
    log::info!("[BLE] {label}: connecting");
    if !peripheral.is_connected().await? {
        peripheral.connect_with_timeout(CONNECT_TIMEOUT).await?;
    }
    peripheral
        .discover_services_with_timeout(CONNECT_TIMEOUT)
        .await?;
    let characteristic = peripheral
        .characteristics()
        .into_iter()
        .find(|c| c.uuid == KIWI_MEASUREMENT_UUID && c.service_uuid == KIWI_SERVICE_UUID)
        .ok_or_else(|| btleplug::Error::Other("Kiwi measurement characteristic not found".into()))?;
    // Get the stream before subscribing so no notification is missed
    let mut notifications = peripheral.notifications().await?;
    peripheral.subscribe(&characteristic).await?;
    log::info!("[BLE] {label}: streaming");

    sink.register_device(&device_id).await;
    if let Some(name) = &name {
        // Show the advertised name until the first Id packet arrives
        sink.rename_device(&device_id, name).await;
    }

    let datarate = DataRateCounter::default();
    let mut batch: Vec<SingleMeasurement> = Vec::new();
    let mut warned_short = false;
    let mut next_flush = Instant::now() + FLUSH_PERIOD;
    // The notification stream does not end when the link drops (at least on
    // macOS, btleplug keeps its sender alive), so poll the link state and fall
    // back to an idle timeout to notice a dead session.
    let mut liveness = time::interval(LIVENESS_PERIOD);
    let mut last_rx = Instant::now();
    loop {
        tokio::select! {
            _ = stopped(&mut stop) => break,
            notification = notifications.next() => {
                let Some(notification) = notification else {
                    break; // connection closed
                };
                if notification.uuid != KIWI_MEASUREMENT_UUID {
                    continue;
                }
                last_rx = Instant::now();
                let value = notification.value;
                if let Some((rate, unit)) = datarate.update(value.len()) {
                    log::info!("[BLE] {label}: receiving data rate: {rate:.3} {unit}");
                }
                if value.len() < SINGLE_MEASUREMENT_SIZE {
                    if !warned_short {
                        warned_short = true;
                        log::warn!(
                            "[BLE] {label}: received {} byte notifications, expected {SINGLE_MEASUREMENT_SIZE}; \
                             the ATT MTU was probably not negotiated above the default",
                            value.len()
                        );
                    }
                    continue;
                }
                // A notification carries one or more back-to-back measurements
                for chunk in value.chunks_exact(SINGLE_MEASUREMENT_SIZE) {
                    match SingleMeasurement::try_from(chunk) {
                        Ok(mes) => {
                            sink.register_device(&device_id).await;
                            // Id packets rename the device rather than being buffered as data
                            if let CommonMeasurement::Id(ref id_str) = mes.measurement {
                                sink.rename_device(&device_id, id_str.as_str()).await;
                            } else {
                                batch.push(mes);
                            }
                        }
                        Err(e) => log::warn!("[BLE] {label}: received invalid measurement: {e:?}"),
                    }
                }
            }
            _ = liveness.tick() => {
                if !peripheral.is_connected().await.unwrap_or(false) {
                    log::info!("[BLE] {label}: link lost");
                    break;
                }
                if last_rx.elapsed() > IDLE_TIMEOUT {
                    log::warn!("[BLE] {label}: no data for {IDLE_TIMEOUT:?}, dropping session");
                    break;
                }
            }
            _ = time::sleep_until(next_flush) => {
                next_flush = Instant::now() + FLUSH_PERIOD;
                flush(&device_id, &mut batch, sink).await;
            }
        }
    }
    flush(&device_id, &mut batch, sink).await;
    Ok(())
}

/// Forwards a batch of measurements to the SSE clients
async fn flush(device_id: &str, batch: &mut Vec<SingleMeasurement>, sink: &Broadcaster) {
    if batch.is_empty() {
        return;
    }
    let msg = serde_json::to_string(batch).expect("Failed to serialize measurements");
    sink.broadcast_data(device_id, &msg).await;
    batch.clear();
}
