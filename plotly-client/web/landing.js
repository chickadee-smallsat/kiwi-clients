(() => {
  const connPill = document.getElementById('connPill');
  const connDot = document.getElementById('connDot');
  const connText = document.getElementById('connText');
  const deviceCountEl = document.getElementById('deviceCount');
  const listEl = document.getElementById('deviceList');
  const themeSelect = document.getElementById('themeSelect');
  const boardNameEl = document.getElementById('boardName');
  const deviceSearch = document.getElementById('deviceSearch');
  const refreshBtn = document.getElementById('refreshBtn');
  const tabBar = document.getElementById('tabBar');
  const contentArea = document.getElementById('contentArea');
  const devicesView = document.getElementById('devicesView');
  const devicesTab = document.querySelector('.tab[data-tab="devices"]');

  const devices = new Set();
  const tabs = new Map();
  // Per-device stats updated from SharedWorker data messages.
  // { device: { bytes: number, packets: number, lastWindowMs: number, dataRate: string, packetRate: string } }
  const deviceStats = new Map();
  let reconnects = 0;

  const params = new URLSearchParams(window.location.search);
  const board = params.get('board');

  function applyTheme(theme) {
    document.body.classList.toggle('light', theme === 'light');
    document.body.classList.toggle('dark', theme !== 'light');
  }

  function initTheme() {
    const saved = localStorage.getItem('theme') || 'dark';
    if (themeSelect) themeSelect.value = saved;
    applyTheme(saved);
  }

  function getCss(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  }

  function setConn(state, text) {
    if (!connText || !connDot || !connPill) return;
    connText.textContent = text;
    const ok = getCss('--ok');
    const warn = getCss('--warn');
    const bad = getCss('--bad');

    if (state === 'ok') {
      connDot.style.background = ok;
      connPill.style.borderColor = ok;
      connText.style.color = '#bfffe2';
      return;
    }

    if (state === 'warn') {
      connDot.style.background = warn;
      connPill.style.borderColor = warn;
      connText.style.color = '#ffe6a8';
      return;
    }

    connDot.style.background = bad;
    connPill.style.borderColor = bad;
    connText.style.color = '#ffb8c0';
  }

  function currentFilter() {
    if (!deviceSearch) return '';
    return String(deviceSearch.value || '').trim();
  }

  function filteredPorts() {
    const q = currentFilter();
    const all = Array.from(devices).sort((a, b) => Number(a) - Number(b));
    if (!q) return all;
    return all.filter((p) => String(p).includes(q));
  }

  function activateTab(key) {
    document.querySelectorAll('.tab').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.tabContent').forEach((el) => el.classList.remove('active'));

    if (key === 'devices') {
      if (devicesTab) devicesTab.classList.add('active');
      if (devicesView) devicesView.style.display = '';
      return;
    }

    if (devicesView) devicesView.style.display = 'none';

    const entry = tabs.get(key);
    if (!entry) {
      if (devicesTab) devicesTab.classList.add('active');
      if (devicesView) devicesView.style.display = '';
      return;
    }

    entry.tab.classList.add('active');
    entry.frame.classList.add('active');
  }

  function removeTab(key) {
    const entry = tabs.get(key);
    if (!entry) return;
    entry.tab.remove();
    entry.frame.remove();
    tabs.delete(key);
    activateTab('devices');
  }

  function openDeviceTab(key, labelText, url, titleText) {
    const tabKey = String(key);

    if (tabs.has(tabKey)) {
      activateTab(tabKey);
      return;
    }

    const tab = document.createElement('div');
    tab.className = 'tab';

    const label = document.createElement('span');
    label.textContent = labelText;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tabClose';
    close.setAttribute('aria-label', `Close ${labelText}`);
    close.textContent = 'x';

    tab.appendChild(label);
    tab.appendChild(close);

    tab.addEventListener('click', () => {
      activateTab(tabKey);
    });

    close.addEventListener('click', (e) => {
      e.stopPropagation();
      removeTab(tabKey);
    });

    const frame = document.createElement('iframe');
    frame.className = 'tabContent';
    frame.src = url;
    frame.title = titleText;
    frame.loading = 'lazy';
    frame.referrerPolicy = 'no-referrer';

    tabBar.appendChild(tab);
    contentArea.appendChild(frame);
    tabs.set(tabKey, { tab, frame });

    activateTab(tabKey);
  }

  function render() {
    if (deviceCountEl) deviceCountEl.textContent = String(devices.size);
    if (!listEl) return;

    const ports = filteredPorts();

    // Build a set of ports currently in the table so we can add/remove rows incrementally
    // without resetting existing rows (which would clear stat cells mid-update).
    const existing = new Set(Array.from(listEl.querySelectorAll('tr[data-port]')).map(r => r.dataset.port));

    // Remove rows for devices that disappeared.
    for (const port of existing) {
      if (!ports.includes(port)) {
        listEl.querySelector(`tr[data-port="${CSS.escape(port)}"]`)?.remove();
        existing.delete(port);
      }
    }

    // Add rows for new devices, preserving order.
    for (const port of ports) {
      if (existing.has(port)) continue;

      const tr = document.createElement('tr');
      tr.dataset.port = port;

      const tdName = document.createElement('td');
      tdName.className = 'devName';
      tdName.textContent = port;
      tr.appendChild(tdName);

      const tdData = document.createElement('td');
      tdData.className = 'devStat';
      tdData.dataset.stat = 'data';
      tdData.textContent = '—';
      tr.appendChild(tdData);

      const tdPkt = document.createElement('td');
      tdPkt.className = 'devStat';
      tdPkt.dataset.stat = 'pkt';
      tdPkt.textContent = '—';
      tr.appendChild(tdPkt);

      const tdPlot = document.createElement('td');
      tdPlot.className = 'devActions';
      const plotBtn = document.createElement('button');
      plotBtn.className = 'devActBtn';
      plotBtn.textContent = 'Plot';
      plotBtn.setAttribute('aria-label', `Open dashboard for device ${port}`);
      plotBtn.addEventListener('click', () => {
        const url = `/dashboard.html?src=${encodeURIComponent(port)}${board ? `&board=${encodeURIComponent(board)}` : ''}`;
        openDeviceTab(port, `Device ${port}`, url, `Device ${port} dashboard`);
      });
      tdPlot.appendChild(plotBtn);
      tr.appendChild(tdPlot);

      const td3d = document.createElement('td');
      td3d.className = 'devActions';
      const btn3d = document.createElement('button');
      btn3d.className = 'devActBtn';
      btn3d.textContent = '3D';
      btn3d.setAttribute('aria-label', `Open 3D view for device ${port}`);
      btn3d.addEventListener('click', () => {
        const key = `${port}-3d`;
        const url = `/3d/?src=${encodeURIComponent(port)}${board ? `&board=${encodeURIComponent(board)}` : ''}`;
        openDeviceTab(key, `3D ${port}`, url, `Device ${port} 3D view`);
      });
      td3d.appendChild(btn3d);
      tr.appendChild(td3d);

      listEl.appendChild(tr);
    }
  }

  const STAT_WINDOW_MS = 2000;

  function updateDeviceStats(device, payloadArray) {
    if (!Array.isArray(payloadArray)) return;
    // Estimate bytes as the JSON representation length (good enough for display).
    const bytes = JSON.stringify(payloadArray).length;
    const packets = payloadArray.length;
    const now = performance.now();

    let s = deviceStats.get(device);
    if (!s) {
      s = { bytes: 0, packets: 0, lastWindowMs: now, dataRate: '—', packetRate: '—' };
      deviceStats.set(device, s);
    }

    s.bytes += bytes;
    s.packets += packets;

    const elapsed = now - s.lastWindowMs;
    if (elapsed >= STAT_WINDOW_MS) {
      const sec = elapsed / 1000;
      const bps = s.bytes / sec;
      const pps = s.packets / sec;

      s.dataRate = bps >= 1024 ? `${(bps / 1024).toFixed(1)} KB/s` : `${bps.toFixed(0)} B/s`;
      s.packetRate = `${pps.toFixed(1)} pkt/s`;

      s.bytes = 0;
      s.packets = 0;
      s.lastWindowMs = now;

      // Update the relevant table cells directly without re-rendering the whole table.
      const row = listEl?.querySelector(`tr[data-port="${CSS.escape(device)}"]`);
      if (row) {
        const dataCell = row.querySelector('[data-stat="data"]');
        const pktCell = row.querySelector('[data-stat="pkt"]');
        if (dataCell) dataCell.textContent = s.dataRate;
        if (pktCell) pktCell.textContent = s.packetRate;
      }
    }
  }

  function addPorts(ports) {
    for (const p of ports) devices.add(String(p));
    render();
  }

  function setPorts(ports) {
    devices.clear();
    for (const p of ports) devices.add(String(p));
    render();
  }
function fetchDevicesOnce() {
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing...';
  }

  return fetch('/devices')
    .then((r) => r.json())
    .then((ports) => {
      if (Array.isArray(ports)) setPorts(ports);

      if (refreshBtn) refreshBtn.textContent = 'Updated';

      setTimeout(() => {
        if (refreshBtn) {
          refreshBtn.disabled = false;
          refreshBtn.textContent = 'Refresh';
        }
      }, 700);
    })
    .catch(() => {
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Retry';
      }
    });
}

  initTheme();

  if (boardNameEl && board) {
    boardNameEl.textContent = board;
    document.title = `${board} - Devices`;
  }

  if (themeSelect) {
    themeSelect.addEventListener('change', () => {
      const v = themeSelect.value || 'dark';
      localStorage.setItem('theme', v);
      applyTheme(v);
    });
  }

  if (deviceSearch) {
    deviceSearch.addEventListener('input', () => {
      render();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      fetchDevicesOnce();
    });
  }

  if (devicesTab) {
    devicesTab.addEventListener('click', () => {
      activateTab('devices');
    });
  }

  setConn('warn', 'connecting…');

  const sw = new SharedWorker('/sse.shared.worker.js');
  const swPort = sw.port;
  swPort.start();

  swPort.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'open') {
      setConn('ok', 'connected (waiting for devices…)');
      fetchDevicesOnce();
    } else if (msg.type === 'devices' && Array.isArray(msg.devices)) {
      setPorts(msg.devices);
      setConn('ok', 'connected');
    } else if (msg.type === 'data') {
      updateDeviceStats(msg.device, msg.payload);
    } else if (msg.type === 'error') {
      reconnects += 1;
      setConn('bad', `disconnected (retrying…) reconnects: ${reconnects}`);
    }
  };

  window.addEventListener('pagehide', () => { swPort.postMessage('disconnect'); });
})();