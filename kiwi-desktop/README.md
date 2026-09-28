# Kiwi Dashboard (Tauri)

Native shell around the `plotly-client` dashboard.

- **Desktop** (Windows/Linux/macOS): bundles `plotly-client`, starts it on a free
  local port with `--no-open`, shows `app/index.html` while it boots, then loads
  the dashboard. The backend is stopped when the window closes.
- **Android**: no backend is bundled. `app/index.html` asks for the address of a
  PC running `plotly-client --http-addr 0.0.0.0` on the same network.

## Build

| Target  | Command |
|---------|---------|
| Windows | `./scripts/build-windows.ps1` |
| Linux   | `./scripts/build-linux.sh` |
| Android | `./scripts/build-android.ps1 [-Release]` |

Each desktop script builds `plotly-client` in release mode, copies it to
`src-tauri/resources/`, and runs `tauri build`.

For development, build the backend once (`cargo build --release -p plotly-client`
from the repo root) and run `npm run dev`; the shell finds the binary in
`target/release/`.
