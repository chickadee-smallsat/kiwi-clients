'use strict';

// Opens a MessagePort-like connection carrying the same protocol as sse.shared.worker.js:
//   { type: 'open' }
//   { type: 'error' }
//   { type: 'devices', devices: {id: string, name: string}[] }
//   { type: 'data', device: string, payload: object[] }
//   { type: 'rename', device: string, name: string }
//
// Uses a SharedWorker (one SSE connection shared across all tabs/iframes on the origin) when the
// browser supports it. Falls back to a private EventSource when it doesn't (iOS WKWebView has no
// SharedWorker) — there each context already owns its own connection, so sharing isn't needed.
function openSseConnection() {
    if (typeof SharedWorker !== 'undefined') {
        const sw = new SharedWorker('/sse.shared.worker.js');
        return sw.port;
    }

    let handler = null;
    const port = {
        start() {},
        postMessage() {},
        set onmessage(fn) { handler = fn; },
        get onmessage() { return handler; },
    };
    const emit = (msg) => { if (handler) handler({ data: msg }); };

    let lastDevices = null;
    const es = new EventSource('/events');

    es.addEventListener('devices', (e) => {
        try {
            lastDevices = JSON.parse(e.data);
            emit({ type: 'devices', devices: lastDevices });
        } catch (_) {}
    });

    es.addEventListener('rename', (e) => {
        try {
            const msg = JSON.parse(e.data);
            if (lastDevices && Array.isArray(lastDevices)) {
                const entry = lastDevices.find((d) => d.id === msg.device);
                if (entry) entry.name = msg.name;
            }
            emit({ type: 'rename', device: msg.device, name: msg.name });
        } catch (_) {}
    });

    es.addEventListener('data', (e) => {
        try {
            const msg = JSON.parse(e.data);
            emit({ type: 'data', device: msg.device, payload: msg.payload });
        } catch (_) {}
    });

    es.onopen = () => emit({ type: 'open' });
    es.onerror = () => emit({ type: 'error' });

    return port;
}
