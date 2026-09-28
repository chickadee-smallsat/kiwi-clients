# Kiwi mainboard clients

Ground-side software for the Kiwi mainboard: receive sensor packets over UDP,
show them live, and record them to Excel.

```
Kiwi board ──UDP──▶ plotly-client (Rust) ──SSE──▶ browser dashboard / 3D view
                                                    ▲
             Electron (plotly-app) or Tauri (kiwi-desktop) wrap it as a desktop app
```

## Components

| Directory | Purpose |
|---|---|
| `plotly-client/` | **The server.** Listens for `kiwi-measurements` packets (UDP 8099, unicast or `--multicast-group`), groups them per board, and streams 100 ms JSON batches to browsers. Serves the web UI (embedded in release builds). |
| `plotly-client/web/` | **The dashboard.** Device list (`index.html`), per-device live plots with recording and Excel export (`dashboard.html`). `kiwi-protocol.js` is the single decoder of the wire format; `recorder.js` owns recording and export. |
| `plotly-client/kiwi-3d/` | **3D attitude view** (Three.js + our own tested Madgwick filter in `src/madgwick.js`), built by `build.rs` into `web/3d`. |
| `udp-dummy-server/` | **Simulated board** for development and tests. `--bind 127.0.0.2` simulates a second board, `--reboot-after N` a board reboot, `--still <roll°>` a motionless board with exact constant readings, `--rate` the sample rate. |
| `plotly-app/` | **Electron desktop app** (released by CI for Windows x64/ARM64, macOS, Linux). |
| `kiwi-desktop/` | **Tauri desktop / Android app.** Desktop bundles the server; Android connects to a PC running `plotly-client --http-addr 0.0.0.0`. |
| `python-client/` | **Standalone Python viewer** (matplotlib) with Excel/NetCDF logging. Needs Python 3.13+. |
| `tests/` | Web unit tests (`unit/`) and browser end-to-end tests (`e2e/`). |

## Data conventions

- A board is identified by its **IP address** (stable across reboots).
- `timestamp` is **microseconds since the board booted**. When it jumps backwards
  the board rebooted: the dashboard starts a new *session* and clears its plots.
- Values are shown and exported exactly as the firmware reports them (sensor frame):
  accel **g**, gyro **deg/s**, mag **mG**, temperature **°C**, pressure **hPa**, altitude **m**.
- Recordings capture every received sample, independent of plot settings, pause,
  or the tab being in the background. The Excel file has one sheet per sensor
  (`ACCEL`, `GYRO`, `MAG`, `BARO`, plus `HUMI`/`PROBES` when present) with
  `session`, `device_time_us`, `elapsed_s` (from recording start) and
  `host_received` columns.

## Run

```bash
cargo run -p plotly-client          # server + opens http://localhost:8080
cargo run -p udp-dummy-server       # in another terminal: a simulated board
```

Useful server flags: `--udp-port`, `--http-port`, `--http-addr 0.0.0.0` (allow other
machines), `--multicast-group <ip>`, `--no-open`.

## Lint and test

| Suite | Command | What it covers |
|---|---|---|
| Lint | `cargo clippy --workspace --all-targets -- -D warnings`, `npm run lint`, `ruff check python-client` | Rust, JavaScript/TypeScript and Python static analysis (unused code, likely bugs) |
| Rust | `cargo test --workspace` | Device registry, non-blocking fan-out, packet validation, data rate |
| Web unit | `npm run test:unit` | Wire-format decoding, timestamps, reboot detection, Excel sheet shaping, orientation filter maths |
| Python | `python -m pytest python-client/tests` | Decoder against hand-built and real Rust-encoded packets; Excel/NetCDF logs save every sample exactly once |
| End-to-end | `cargo build --workspace && npx playwright test` | Real server + 5 simulated boards + Chromium: every displayed field checked against ground truth (tiles, plots, units, live values, attitude, 3D orientation, gauges, recording and Excel contents), plus routing, reboot handling and UI behaviour |

CI (`.github/workflows/ci.yml`) runs all of these plus `cargo fmt --check` on
every push and pull request.
