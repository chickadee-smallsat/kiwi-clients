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
  let reconnects = 0;

  const deviceStats = {};

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
    const all = Array.from(devices).sort((a, b) => String(a).localeCompare(String(b)));
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
    if (!tabBar || !contentArea) {
      window.location.href = url;
      return;
    }

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
    listEl.innerHTML = '';

    for (const port of ports) {
      const tr = document.createElement('tr');

      const rate = deviceStats[port]?.rate || 0;

      const boardPart = board ? `&board=${encodeURIComponent(board)}` : '';
      const dashUrl = `/dashboard.html?src=${encodeURIComponent(port)}${boardPart}`;
      const view3dUrl = `/3d/?src=${encodeURIComponent(port)}${boardPart}`;

      const tdDevice = document.createElement('td');
      tdDevice.textContent = port;

      const tdRate = document.createElement('td');
      tdRate.textContent = `${rate} pkt/s`;

      const td3d = document.createElement('td');
      const view3dBtn = document.createElement('button');
      view3dBtn.type = 'button';
      view3dBtn.className = 'open3dBtn';
      view3dBtn.textContent = 'Open 3D';
      view3dBtn.addEventListener('click', () => {
        openDeviceTab(
          `device3d-${port}`,
          `3D ${port}`,
          view3dUrl,
          `3D View ${port}`
        );
      });
      td3d.appendChild(view3dBtn);

      const tdOpen = document.createElement('td');
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'deviceNameBtn';
      openBtn.textContent = 'Open Dashboard';
      openBtn.addEventListener('click', () => {
        openDeviceTab(
          `device-${port}`,
          `Device ${port}`,
          dashUrl,
          `Dashboard ${port}`
        );
      });
      tdOpen.appendChild(openBtn);

      tr.appendChild(tdDevice);
      tr.appendChild(tdRate);
      tr.appendChild(td3d);
      tr.appendChild(tdOpen);

      listEl.appendChild(tr);
    }
  }

  function normalizeDeviceData(data) {
    if (!Array.isArray(data)) return [];

    return data
      .map(d => {
        if (typeof d === 'string' || typeof d === 'number') {
          return { port: String(d), rate: deviceStats[String(d)]?.rate || 0 };
        }

        if (d && typeof d === 'object') {
          const port = d.port ?? d.device ?? d.id ?? d.device_id ?? d.deviceId;
          if (port === undefined || port === null || String(port).trim() === '') return null;

          return {
            port: String(port),
            rate: Number.isFinite(Number(d.rate ?? d.packet_rate ?? d.packetRate))
              ? Number(d.rate ?? d.packet_rate ?? d.packetRate)
              : deviceStats[String(port)]?.rate || 0,
          };
        }

        return null;
      })
      .filter(Boolean);
  }

  function setPorts(data) {
    const normalized = normalizeDeviceData(data);

    devices.clear();

    normalized.forEach(d => {
      const id = String(d.port);
      devices.add(id);
      deviceStats[id] = { rate: d.rate };
    });

    Object.keys(deviceStats).forEach(id => {
      if (!devices.has(id)) delete deviceStats[id];
    });

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
        if (Array.isArray(ports)) {
          setPorts(ports);
        }

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

  const es = new EventSource('/devices/events');

  es.onopen = () => {
    setConn('ok', 'connected (waiting for devices…)');
    fetchDevicesOnce();
  };

  es.onmessage = (e) => {
    let parsed;

    try {
      parsed = JSON.parse(e.data);
    } catch {
      return;
    }

    if (Array.isArray(parsed)) {
      setPorts(parsed);
    }
  };

  es.onerror = () => {
    reconnects += 1;
    setConn('bad', `disconnected (retrying…) reconnects: ${reconnects}`);
  };
})();