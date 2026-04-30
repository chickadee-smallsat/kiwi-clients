# Kiwi Plotter Electron

This app wraps the Rust `plotly-client` web server in an Electron desktop shell.

## Prerequisites

- Rust toolchain (`cargo`)
- Node.js + npm

## Development

From repository root:

```bash
cd plotly-app
npm install
npm run dev
```

`npm run dev` does the following:

1. Builds Rust release binary: `cargo build --release -p plotly-client`
2. Copies binary into `plotly-app/resources/bin/`
3. Launches Electron and points it at the local server

## Packaging

```bash
cd plotly-app
npm install
npm run dist:linux
```

This produces a Linux AppImage under `plotly-app/dist/`.

Platform-specific build commands:

```bash
npm run dist:linux
npm run dist:win
npm run dist:mac
```

- `dist:linux` builds `AppImage`
- `dist:win` builds `NSIS` installer (`.exe`)
- `dist:mac` builds `dmg` and `zip`

For a generic package (using host defaults):

```bash
npm run dist
```

## CI

GitHub Actions workflow `.github/workflows/electron-build.yml` builds Linux, Windows, and macOS artifacts on every relevant push and pull request.
