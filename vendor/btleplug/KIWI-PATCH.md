# Local patch to btleplug 0.13.5

Vendored from crates.io and wired in with `[patch.crates-io]` in the workspace
`Cargo.toml`. Drop this directory and the patch entry once upstream fixes it.

## CoreBluetooth: stale Peripheral after a disconnect (macOS/iOS)

On disconnect, `CoreBluetoothInternal::on_peripheral_disconnect` removes the
device from its map, ending the per-device event loop ("Event receiver died,
breaking out of corebluetooth device loop."). The adapter-level
`AdapterManager` keeps the old `Peripheral`, though. When the device is seen
again, the internal layer creates a new entry and sends `DeviceDiscovered` with
a fresh event receiver, but `adapter.rs` ignored it because the id was already
known. The old `Peripheral` could still connect, but its notifications and
advertisement updates went to the dropped receiver, so a reconnect received no
data until the process restarted.

Fix:

- `src/corebluetooth/adapter.rs`: on `DeviceDiscovered`, always build a new
  `Peripheral` from the event receiver and replace the stored one.
- `src/common/adapter_manager.rs`: add `AdapterManager::replace_peripheral`.

## CoreBluetooth: successful disconnects logged as errors

`PeripheralInternal::confirm_disconnect` failed every pending operation with
`Err("Device disconnected")`, including the `disconnect()` request it was
completing, so `Peripheral::disconnect` logged "Shouldn't get anything but Ok!"
after every successful disconnect (it still returned `Ok(())`).

Fix (`src/corebluetooth/internal.rs`): `confirm_disconnect` answers pending
disconnect requests with `Ok` before failing the remaining operations.
