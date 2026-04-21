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

  function makeBtn(label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    return b;
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
    listEl.innerHTML = '';

    for (const port of ports) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '10px';
      row.style.flexWrap = 'wrap';

      const dashBtn = makeBtn(`Open device ${port}`);
      dashBtn.setAttribute('aria-label', `Open dashboard for device ${port}`);
      dashBtn.addEventListener('click', () => {
        const url = `/dashboard.html?src=${encodeURIComponent(port)}${board ? `&board=${encodeURIComponent(board)}` : ''}`;
        openDeviceTab(port, `Device ${port}`, url, `Device ${port} dashboard`);
      });

      const view3dBtn = makeBtn(`3D ${port}`);
      view3dBtn.setAttribute('aria-label', `Open 3D view for device ${port}`);
      view3dBtn.addEventListener('click', () => {
        const key = `${port}-3d`;
        const url = `/3d/?src=${encodeURIComponent(port)}${board ? `&board=${encodeURIComponent(board)}` : ''}`;
        openDeviceTab(key, `3D ${port}`, url, `Device ${port} 3D view`);
      });

      row.appendChild(dashBtn);
      row.appendChild(view3dBtn);
      listEl.appendChild(row);
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
    return fetch('/devices')
      .then((r) => r.json())
      .then((ports) => {
        if (Array.isArray(ports)) setPorts(ports);
      })
      .catch(() => {});
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
    if (Array.isArray(parsed)) addPorts(parsed);
  };

  es.onerror = () => {
    reconnects += 1;
    setConn('bad', `disconnected (retrying…) reconnects: ${reconnects}`);
  };
})();