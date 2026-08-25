import SwiftUI
import WebKit

// Matches the Rust server's own defaults (see plotly-client's Args); fixed rather than
// dynamically chosen since only one instance of this app runs per device.
private let httpPort: UInt16 = 8080
private let udpPort: UInt16 = 8099
private let startupTimeout: TimeInterval = 15

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var serverReady = false
    @State private var statusMessage = "Starting Kiwi Plotter…"
    @State private var reloadToken = 0

    var body: some View {
        ZStack {
            if serverReady {
                WebView(url: URL(string: "http://127.0.0.1:\(httpPort)")!, reloadToken: reloadToken)
                    .ignoresSafeArea()
            } else {
                VStack(spacing: 12) {
                    ProgressView()
                    Text(statusMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .task {
            await startServerAndWaitUntilReady()
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active, serverReady else { return }
            Task { await ensureServerStillRunning() }
        }
    }

    // Mirrors the Electron shell's startup sequence (spawn backend, poll until it responds,
    // then point the web view at it) — see plotly-app/main.cjs's waitForServer.
    private func startServerAndWaitUntilReady() async {
        reloadToken += 1
        _ = kiwi_start(httpPort, udpPort)

        let deadline = Date().addingTimeInterval(startupTimeout)
        let devicesURL = URL(string: "http://127.0.0.1:\(httpPort)/devices")!

        while Date() < deadline {
            if await isServerReachable(devicesURL) {
                serverReady = true
                return
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }

        statusMessage = "Failed to start the Kiwi Plotter backend."
    }

    // iOS suspends or outright kills an app's background networking (the UDP listener
    // especially), and nothing tells the backend to come back on its own. Called whenever the
    // app returns to the foreground: if the server is still answering, leave it alone (avoids
    // flashing the loading screen on every foreground); if not, restart it from scratch exactly
    // like a cold launch, including reloading the web view onto the fresh server instance.
    private func ensureServerStillRunning() async {
        let devicesURL = URL(string: "http://127.0.0.1:\(httpPort)/devices")!
        if await isServerReachable(devicesURL) { return }

        serverReady = false
        statusMessage = "Reconnecting…"
        await startServerAndWaitUntilReady()
    }

    private func isServerReachable(_ url: URL) async -> Bool {
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        guard let (_, response) = try? await URLSession.shared.data(for: request) else {
            return false
        }
        guard let http = response as? HTTPURLResponse else { return false }
        return http.statusCode < 500
    }
}

struct WebView: UIViewRepresentable {
    let url: URL
    var reloadToken: Int

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView()
        webView.load(URLRequest(url: url))
        context.coordinator.lastReloadToken = reloadToken
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        guard context.coordinator.lastReloadToken != reloadToken else { return }
        context.coordinator.lastReloadToken = reloadToken
        uiView.load(URLRequest(url: url))
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var lastReloadToken = 0
    }
}
