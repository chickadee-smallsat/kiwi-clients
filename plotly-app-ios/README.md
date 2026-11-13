# KiwiPlotter (iOS)

A SwiftUI app that listens for Kiwi device measurement broadcasts on the local
network and plots them, backed by the Rust `plotly-client` core via
`KiwiClient.xcframework`.

## Prerequisites

- A Mac with Xcode installed (not just the Command Line Tools) — Xcode is
  available from the App Store. After installing, point the command line
  tools at it:

  ```sh
  sudo xcode-select -s /Applications/Xcode.app
  ```

- [XcodeGen](https://github.com/yonaskolb/XcodeGen) to generate the
  `.xcodeproj` from `project.yml`:

  ```sh
  brew install xcodegen
  ```

- `Frameworks/KiwiClient.xcframework` present in this directory. It's
  gitignored (it's a build artifact, not source), so if it's missing you need
  to rebuild it from `plotly-client`:

  ```sh
  cd ../plotly-client
  cargo build --release --target aarch64-apple-ios --lib
  cargo build --release --target aarch64-apple-ios-sim --lib
  xcodebuild -create-xcframework \
    -library ../target/aarch64-apple-ios/release/libplotly_client.a -headers include \
    -library ../target/aarch64-apple-ios-sim/release/libplotly_client.a -headers include \
    -output ../plotly-app-ios/Frameworks/KiwiClient.xcframework
  ```

  (`plotly-client` is a member of the Cargo workspace rooted at `kiwi-clients/`,
  so build output lands in `kiwi-clients/target/`, not `plotly-client/target/`
  — hence the `../target/...` paths above.)

  (Skip this if the xcframework is already sitting in `Frameworks/`.)

- An iPhone running iOS 17+ and a cable (or Wi-Fi syncing already set up) to
  connect it to the Mac.

## 1. Generate the Xcode project

From this directory:

```sh
xcodegen generate
```

This reads `project.yml` and (re)creates `KiwiPlotter.xcodeproj`. Re-run this
any time `project.yml` changes.

## 2. Open the project

```sh
open KiwiPlotter.xcodeproj
```

## 3. Sign in with your Apple ID (once per Mac)

`project.yml` already sets `CODE_SIGN_STYLE: Automatic` and a
`DEVELOPMENT_TEAM`, so Xcode just needs an account to sign with:

- Xcode → Settings → Accounts → **+** → add your Apple ID.
- A free Apple ID works, but apps signed with a free account re-sign
  themselves out after 7 days, so you'll need to rebuild periodically unless
  you're on the paid Apple Developer Program.

## 4. Prepare the iPhone

- Plug the iPhone into the Mac with a cable (or pair it over Wi-Fi:
  Window → Devices and Simulators → check "Connect via network").
- Unlock the phone and tap **Trust This Computer** if prompted.
- Enable Developer Mode on the phone (required on iOS 16+): Settings →
  Privacy & Security → Developer Mode → on, then let it reboot and confirm.

## 5. Select the device and run

- In Xcode's toolbar, click the run-destination picker (next to the scheme
  name) and choose your iPhone from the list.
- Press **Cmd+R** (or the ▶ button) to build and install.

## 6. Trust the developer certificate on first install

The first launch will fail with an "Untrusted Developer" prompt on the phone.
On the iPhone: Settings → General → VPN & Device Management → select your
developer/team certificate → **Trust**. Then relaunch the app from the home
screen (or Cmd+R from Xcode again).

## 7. Allow local network access

KiwiPlotter needs to listen for Kiwi device broadcasts on your Wi-Fi network.
On first launch, iOS will prompt for local network permission — allow it (or
enable it later under Settings → KiwiPlotter → Local Network).

At this point the app is installed and running on the phone; subsequent
runs from Xcode (Cmd+R) will just rebuild and reinstall over it.
