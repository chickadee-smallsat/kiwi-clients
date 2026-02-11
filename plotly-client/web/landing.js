(() => {
  const connPill = document.getElementById('connPill');
  const connDot = document.getElementById('connDot');
  const connText = document.getElementById('connText');
  const deviceCountEl = document.getElementById('deviceCount');
  const listEl = document.getElementById('deviceList');
  const themeSelect = document.getElementById('themeSelect');
  const boardNameEl = document.getElementById('boardName');

  const devices = new Set();
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

  function render() {
    if (deviceCountEl) deviceCountEl.textContent = String(devices.size);
    if (!listEl) return;

    listEl.innerHTML = '';
    for (const port of Array.from(devices).sort((a, b) => Number(a) - Number(b))) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = `Open device ${port}`;
      btn.addEventListener('click', () => {
        const url = `/dashboard.html?src=${encodeURIComponent(port)}${board ? `&board=${encodeURIComponent(board)}` : ''}`;
        window.open(url, '_blank', 'noopener,noreferrer');
      });
      listEl.appendChild(btn);
    }
  }

  function addPorts(ports) {
    for (const p of ports) devices.add(String(p));
    render();
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

  setConn('warn', 'connecting…');

  const es = new EventSource('/devices/events');

  es.onopen = () => {
    setConn('ok', 'connected (waiting for devices…)');
    fetch('/devices')
      .then((r) => r.json())
      .then((ports) => {
        if (Array.isArray(ports)) addPorts(ports);
      })
      .catch(() => {});
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