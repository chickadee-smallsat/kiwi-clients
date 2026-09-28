// Device list: shows every board the server hears from and opens its
// dashboard or 3D view in a tab. Rows are updated in place (the server pushes
// new rates every second), so buttons are never replaced mid-click.
(() => {
  const connPill = document.getElementById('connPill');
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
  const emptyStateEl = document.getElementById('emptyState');

  // A board sends 4 packet types at up to ~50 Hz; the rate bar is scaled to that.
  const FULL_RATE = 250;

  const devices = new Map(); // id -> packets per second
  const rows = new Map(); // id -> { tr, rateNum, fill }
  const tabs = new Map(); // tab key -> { tab, frame }
  let reconnects = 0;

  const board = new URLSearchParams(window.location.search).get('board');

  function applyTheme(theme) {
    for (const el of [document.documentElement, document.body]) {
      el.classList.toggle('light', theme === 'light');
      el.classList.toggle('dark', theme !== 'light');
    }
  }

  function setConn(state, text) {
    connText.textContent = text;
    connPill.dataset.state = state;
  }

  // ── Tabs ────────────────────────────────────────────────────────────────
  function activateTab(key) {
    document.querySelectorAll('.tab').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.tabContent').forEach((el) => el.classList.remove('active'));

    const entry = tabs.get(key);
    if (!entry) {
      devicesTab.classList.add('active');
      devicesView.style.display = '';
      return;
    }
    devicesView.style.display = 'none';
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

  function openDeviceTab(key, label, url, title) {
    if (tabs.has(key)) {
      activateTab(key);
      return;
    }

    const tab = document.createElement('div');
    tab.className = 'tab';
    const text = document.createElement('span');
    text.textContent = label;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tabClose';
    close.setAttribute('aria-label', `Close ${label}`);
    close.textContent = '×';
    tab.append(text, close);
    tab.addEventListener('click', () => activateTab(key));
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      removeTab(key);
    });

    const frame = document.createElement('iframe');
    frame.className = 'tabContent';
    frame.src = url;
    frame.title = title;
    frame.referrerPolicy = 'no-referrer';

    tabBar.appendChild(tab);
    contentArea.appendChild(frame);
    tabs.set(key, { tab, frame });
    activateTab(key);
  }

  // ── Device rows ─────────────────────────────────────────────────────────
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className, onClick) {
    const b = el('button', className, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function createRow(id) {
    const boardPart = board ? `&board=${encodeURIComponent(board)}` : '';
    const src = encodeURIComponent(id);

    const cell = el('div', 'deviceCell');
    const names = el('div');
    names.append(el('div', 'deviceName', id), el('div', 'deviceSub', 'Streaming'));
    cell.append(el('span', 'deviceIcon'), names);

    const rateNum = el('span', 'rateNum');
    const bar = el('div', 'rateBar');
    const fill = el('span');
    bar.appendChild(fill);
    const rateCell = el('div', 'rateCell');
    rateCell.append(rateNum, bar);

    const actions = el('div', 'rowActions');
    actions.append(
      button('Open 3D', 'btnGhost ico icoCube', () =>
        openDeviceTab(`device3d-${id}`, `3D · ${id}`, `/3d/?src=${src}${boardPart}`, `3D view ${id}`)),
      button('Open dashboard', 'btnPrimary ico icoChart', () =>
        openDeviceTab(`device-${id}`, id, `/dashboard.html?src=${src}${boardPart}`, `Dashboard ${id}`)),
    );

    const tr = el('tr');
    for (const content of [cell, rateCell, actions]) {
      const td = el('td');
      td.appendChild(content);
      tr.appendChild(td);
    }
    return { tr, rateNum, fill };
  }

  function render() {
    deviceCountEl.textContent = String(devices.size);
    emptyStateEl.classList.toggle('show', devices.size === 0);

    for (const [id, row] of rows) {
      if (!devices.has(id)) {
        row.tr.remove();
        rows.delete(id);
      }
    }

    const filter = deviceSearch.value.trim();
    const ids = [...devices.keys()].sort((a, b) => a.localeCompare(b));
    for (const id of ids) {
      let row = rows.get(id);
      if (!row) {
        row = createRow(id);
        rows.set(id, row);
      }
      const rate = devices.get(id);
      row.rateNum.textContent = `${rate} pkt/s`;
      row.fill.style.width = `${Math.min(100, (rate / FULL_RATE) * 100)}%`;
      row.tr.hidden = filter !== '' && !id.includes(filter);
      listEl.appendChild(row.tr); // keeps rows sorted; moving a node keeps its listeners
    }
  }

  // Backend contract: GET /devices and /devices/events send [{ id, rate }].
  function setDevices(list) {
    if (!Array.isArray(list)) return;
    devices.clear();
    for (const d of list) {
      if (d && typeof d.id === 'string' && d.id !== '') devices.set(d.id, Number.isFinite(d.rate) ? d.rate : 0);
    }
    render();
  }

  async function refresh() {
    refreshBtn.disabled = true;
    try {
      setDevices(await (await fetch('/devices')).json());
    } catch {
      setConn('bad', 'Server unreachable');
    } finally {
      refreshBtn.disabled = false;
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  const savedTheme = localStorage.getItem('theme') || 'dark';
  themeSelect.value = savedTheme;
  applyTheme(savedTheme);

  if (board) {
    boardNameEl.textContent = board;
    document.title = `Kiwi · ${board}`;
  }

  themeSelect.addEventListener('change', () => {
    localStorage.setItem('theme', themeSelect.value);
    applyTheme(themeSelect.value);
  });

  // Keep every open Kiwi page on the same theme.
  window.addEventListener('storage', (e) => {
    if (e.key !== 'theme' || !e.newValue) return;
    themeSelect.value = e.newValue;
    applyTheme(e.newValue);
  });

  deviceSearch.addEventListener('input', render);
  refreshBtn.addEventListener('click', refresh);
  devicesTab.addEventListener('click', () => activateTab('devices'));

  setConn('warn', 'Connecting…');
  render();

  // The server sends the current list on connect, then every change.
  const es = new EventSource('/devices/events');
  es.onopen = () => setConn('ok', 'Server connected');
  es.onmessage = (e) => {
    try {
      setDevices(JSON.parse(e.data));
    } catch {
      // Ignore a malformed message; the next one replaces the whole list.
    }
  };
  es.onerror = () => {
    reconnects += 1;
    setConn('bad', `Server unreachable · retry ${reconnects}`);
  };
})();
