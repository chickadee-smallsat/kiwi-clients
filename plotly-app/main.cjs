const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const HTTP_HOST = '127.0.0.1';
const STARTUP_TIMEOUT_MS = 15000;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, HTTP_HOST, () => {
      const { port } = srv.address();
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on('error', reject);
  });
}

let backendProcess = null;

function binaryName() {
  return process.platform === 'win32' ? 'plotly-client.exe' : 'plotly-client';
}

function resolveBinaryPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', binaryName());
  }
  return path.resolve(__dirname, '..', 'target', 'release', binaryName());
}

function waitForServer(url, timeoutMs) {
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });

      req.on('error', retry);
      req.setTimeout(1000, () => {
        req.destroy();
      });
    };

    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error('Timed out while waiting for plotly-client HTTP server'));
        return;
      }
      setTimeout(attempt, 250);
    };

    attempt();
  });
}

async function startBackend() {
  const binPath = resolveBinaryPath();

  if (!fs.existsSync(binPath)) {
    throw new Error(
      `Rust binary not found at ${binPath}. Run \"npm run build:rust && npm run prepare:bin\" first.`
    );
  }

  const port = await getFreePort();

  backendProcess = spawn(
    binPath,
    [
      '--http-addr',
      HTTP_HOST,
      '--http-port',
      String(port),
      '--no-open'
    ],
    {
      stdio: 'ignore',
      windowsHide: true,
      detached: false
    }
  );

  backendProcess.once('exit', (code, signal) => {
    if (!app.isQuitting) {
      dialog.showErrorBox(
        'plotly-client exited',
        `The backend process stopped unexpectedly (code: ${code}, signal: ${signal}).`
      );
      app.quit();
    }
  });

  await waitForServer(`http://${HTTP_HOST}:${port}`, STARTUP_TIMEOUT_MS);
  return port;
}

function stopBackend() {
  if (!backendProcess || backendProcess.killed) {
    return;
  }

  backendProcess.kill('SIGTERM');
}

async function createMainWindow() {
  const port = await startBackend();

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 700,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  await win.loadURL(`http://${HTTP_HOST}:${port}`);
}

app.on('before-quit', () => {
  app.isQuitting = true;
  stopBackend();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.whenReady().then(async () => {
  try {
    await createMainWindow();
  } catch (err) {
    dialog.showErrorBox('Failed to start Kiwi Plotter', String(err));
    app.quit();
  }
});
