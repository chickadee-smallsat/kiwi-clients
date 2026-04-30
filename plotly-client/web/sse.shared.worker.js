'use strict';

// One SSE connection shared across all tabs and iframes on the same origin.
// This keeps the total number of persistent HTTP connections constant regardless
// of how many device dashboards or embedded 3D views are open.
//
// Message protocol sent to ports:
//   { type: 'open' }
//   { type: 'error' }
//   { type: 'devices', devices: string[] }
//   { type: 'data', device: string, payload: object[] }

const ports = new Set();
let es = null;
let esState = 'closed'; // 'open' | 'error' | 'closed'
let lastDevices = null; // cache so newly-connected ports get the device list immediately

function broadcast(msg) {
    for (const port of ports) {
        try {
            port.postMessage(msg);
        } catch (_) {
            // Port is gone (tab closed without sending 'disconnect'); remove it.
            ports.delete(port);
        }
    }
}

function connectSSE() {
    if (es) return;

    es = new EventSource('/events');

    es.addEventListener('devices', (e) => {
        try {
            lastDevices = JSON.parse(e.data);
            broadcast({ type: 'devices', devices: lastDevices });
        } catch (_) {}
    });

    es.addEventListener('data', (e) => {
        try {
            // Server sends: {"device":"127.0.0.1:PORT","payload":[...measurements...]}
            const msg = JSON.parse(e.data);
            broadcast({ type: 'data', device: msg.device, payload: msg.payload });
        } catch (_) {}
    });

    es.onopen = () => {
        esState = 'open';
        broadcast({ type: 'open' });
        // Replay last known device list so ports that connected before the SSE
        // opened (or reconnected) don't miss the current state.
        if (lastDevices) broadcast({ type: 'devices', devices: lastDevices });
    };

    es.onerror = () => {
        esState = 'error';
        broadcast({ type: 'error' });
    };
}

self.onconnect = (e) => {
    const port = e.ports[0];
    ports.add(port);
    port.start();

    port.onmessage = (ev) => {
        if (ev.data === 'disconnect') {
            ports.delete(port);
        }
    };

    // Immediately send current state to the new port.
    if (esState === 'open') {
        port.postMessage({ type: 'open' });
        if (lastDevices) port.postMessage({ type: 'devices', devices: lastDevices });
    } else if (esState === 'error') {
        port.postMessage({ type: 'error' });
    }

    connectSSE();
};
