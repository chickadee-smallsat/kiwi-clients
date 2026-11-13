# Kiwi Plotter desktop app

This app wraps the Rust `plotly-client` server in a [Tauri](https://tauri.app) desktop window.
The server (HTTP UI, UDP listener and Bluetooth LE receiver) runs inside the app process on a
background thread, and the window shows its web UI. There is no separate backend binary.

## Prerequisites

- Rust toolchain (`cargo`)
- Node.js + npm (for the Tauri CLI and plotly-client's `kiwi-3d` frontend build)
- Linux only: the WebKitGTK and build dependencies listed in the
  [Tauri prerequisites](https://tauri.app/start/prerequisites/), e.g. on Debian/Ubuntu:

  ```bash
  sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libxdo-dev \
    libssl-dev libdbus-1-dev pkg-config build-essential patchelf file
  ```

## Development

```bash
cd plotly-app
npm install
npm run dev
```

`npm run dev` builds the app in debug mode and opens the window. In debug builds plotly-client
serves `plotly-client/web/` from disk, so UI changes only need a reload.

The app is a member of the repository's Cargo workspace (so it picks up the patched btleplug in
`vendor/`), but not a default member: a plain `cargo build` at the root does not need WebKit.
Build it directly with `cargo build -p kiwi-plotter`.

## Packaging

```bash
cd plotly-app
npm install
npm run dist:linux   # AppImage
npm run dist:win     # NSIS installer (.exe)
npm run dist:mac     # dmg
```

Bundles are written to `target/release/bundle/<type>/` at the repository root. `npm run dist`
builds every bundle type the host supports.

The app version comes from `package.json` (`tauri.conf.json` points at it).

## Exported files

CSV and XLSX exports are saved to the Downloads folder (with ` (n)` added instead of
overwriting an existing file), and the app shows where the file went.

## CI

GitHub Actions workflow `.github/workflows/desktop-build.yml` builds the Linux AppImage, the
Windows x64 and arm64 installers and the macOS dmg. It runs on `v*` tags (attaching the bundles
to a GitHub release) and on manual dispatch.
