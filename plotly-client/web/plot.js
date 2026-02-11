(() => {
  const connPill = document.getElementById('connPill');
  const connDot = document.getElementById('connDot');
  const connText = document.getElementById('connText');
  const reconnectsEl = document.getElementById('reconnects');
  const lastSeenEl = document.getElementById('lastSeen');
  const bufCountEl = document.getElementById('bufCount');
  const bufMaxEl = document.getElementById('bufMax');

  const pauseBtn = document.getElementById('pauseBtn');
  const windowInput = document.getElementById('windowSec');
  const rateInput = document.getElementById('rateHz');
  const streamSelect = document.getElementById('streamSelect');

  const themeSelect = document.getElementById('themeSelect');
  const paletteSelect = document.getElementById('paletteSelect');
  const boardNameEl = document.getElementById('boardName');

  const recordBtn = document.getElementById('recordBtn');
  const stopBtn = document.getElementById('stopBtn');
  const exportBtn = document.getElementById('exportBtn');
  const recCountEl = document.getElementById('recCount');

  const tEl = document.getElementById('t');
  const xEl = document.getElementById('x');
  const yEl = document.getElementById('y');
  const zEl = document.getElementById('z');
  const magEl = document.getElementById('mag');
  const thetaEl = document.getElementById('theta');
  const phiEl = document.getElementById('phi');

  const accelDiv = document.getElementById('accelPlot');
  const gyroDiv = document.getElementById('gyroPlot');
  const magDiv = document.getElementById('magPlot');
  const tempDiv = document.getElementById('tempPlot');
  const pressureDiv = document.getElementById('pressurePlot');
  const altitudeDiv = document.getElementById('altitudePlot');
  const thetaGDiv = document.getElementById('thetaGPlot');
  const thetaMDiv = document.getElementById('thetaMPlot');
  const phiMDiv = document.getElementById('phiMPlot');
  const dialDiv = document.getElementById('dial');

  const params = new URLSearchParams(location.search);
  const deviceKey = params.get('src') || 'all';
  const devicePort = deviceKey === 'all' ? null : Number(deviceKey);
  const board = params.get('board');

  let paused = false;
  let reconnects = 0;
  let lastSeenMs = null;

  let windowSec = toInt(windowInput?.value, 2);
  let rateHz = toInt(rateInput?.value, 60);
  let maxPoints = Math.max(1, Math.round(windowSec * rateHz));
  let bufferedPoints = 0;

  const recorder = {
    isRecording: false,
    startedAt: null,
    rows: [],
  };

  let uiStream = streamSelect ? streamSelect.value : 'all';
  let uiStreams = new Set();

  const FRAME_MS = 33;
  let pending = [];
  let lastFrameMs = 0;

  const draw = {
    accel: { ts: [], x: [], y: [], z: [], mag: [], theta: [] },
    gyro: { ts: [], x: [], y: [], z: [], mag: [] },
    mag: { ts: [], x: [], y: [], z: [], mag: [], theta: [], phi: [] },
    temp: { ts: [], v: [] },
    pressure: { ts: [], v: [] },
    altitude: { ts: [], v: [] },
  };

  const dialStats = document.getElementById('dialStats');
  if (dialStats) dialStats.open = false;

  function toInt(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : fallback;
  }

  function getCss(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  }

  function setConn(state, text) {
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

  function fmtTime(ms) {
    if (!ms) return '-';
    return new Date(ms).toLocaleTimeString();
  }

  function updateLastSeen() {
    lastSeenMs = Date.now();
    lastSeenEl.textContent = fmtTime(lastSeenMs);
  }

  setInterval(() => {
    if (!lastSeenMs) return;
    const age = Date.now() - lastSeenMs;
    if (age > 2000) setConn('warn', `connected (${deviceKey}) (stale…)`);
  }, 500);

  function isVectorSensor(s) {
    return s === 'accel' || s === 'gyro' || s === 'mag';
  }

  function applySettings() {
    windowSec = Math.max(1, Math.min(10, toInt(windowInput?.value, 2)));
    rateHz = Math.max(1, Math.min(240, toInt(rateInput?.value, 60)));
    if (windowInput) windowInput.value = String(windowSec);
    if (rateInput) rateInput.value = String(rateHz);
    maxPoints = Math.max(1, Math.round(windowSec * rateHz));
    bufMaxEl.textContent = String(maxPoints);
  }

  function getSelectedStreams() {
    const set = new Set();
    if (!streamSelect) return set;
    for (const opt of Array.from(streamSelect.selectedOptions || [])) {
      if (opt && opt.value) set.add(opt.value);
    }
    return set;
  }

  function shouldDraw(sensor) {
    if (uiStreams.size) return uiStreams.has(sensor);
    return uiStream === 'all' || uiStream === sensor;
  }

  function plotVisible(div) {
    if (!div) return false;
    const d = div.closest('details');
    if (!d) return true;
    return !!d.open;
  }

  const THEMES = {
    dark: {
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: '#e8eefc' },
      xaxis: { gridcolor: 'rgba(255,255,255,0.12)' },
      yaxis: { gridcolor: 'rgba(255,255,255,0.12)' },
    },
    light: {
      paper_bgcolor: '#ffffff',
      plot_bgcolor: '#ffffff',
      font: { color: '#0b1220' },
      xaxis: { gridcolor: 'rgba(0,0,0,0.12)' },
      yaxis: { gridcolor: 'rgba(0,0,0,0.12)' },
    },
  };

  const PALETTES = {
    default: ['#7aa2ff', '#7dffcb', '#ffb86c', '#ff6b81', '#c792ea', '#ffd166'],
    colorblind: ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#CC79A7', '#56B4E9'],
  };

  function applyTheme(theme) {
    document.body.classList.toggle('light', theme === 'light');
    document.body.classList.toggle('dark', theme !== 'light');
  }

  function applyThemeToPlots(theme) {
    const t = THEMES[theme] || THEMES.dark;
    const divs = [accelDiv, gyroDiv, magDiv, tempDiv, pressureDiv, altitudeDiv, thetaGDiv, thetaMDiv, phiMDiv];
    for (const div of divs) {
      if (!div) continue;
      Plotly.relayout(div, {
        paper_bgcolor: t.paper_bgcolor,
        plot_bgcolor: t.plot_bgcolor,
        font: t.font,
        xaxis: { ...(t.xaxis || {}) },
        yaxis: { ...(t.yaxis || {}) },
      });
    }
    Plotly.relayout(dialDiv, {
      paper_bgcolor: t.paper_bgcolor,
      plot_bgcolor: t.plot_bgcolor,
    });
  }

  function applyPaletteToPlots(paletteKey) {
    const colors = PALETTES[paletteKey] || PALETTES.default;

    function applyVector(div) {
      if (!div) return;
      Plotly.restyle(
        div,
        { line: [{ color: colors[0] }, { color: colors[1] }, { color: colors[2] }, { color: colors[3] }] },
        [0, 1, 2, 3]
      );
    }

    function applyScalar(div, color) {
      if (!div) return;
      Plotly.restyle(div, { line: { color } }, [0]);
    }

    applyVector(accelDiv);
    applyVector(gyroDiv);
    applyVector(magDiv);
    applyScalar(tempDiv, colors[0]);
    applyScalar(pressureDiv, colors[1]);
    applyScalar(altitudeDiv, colors[2]);
    applyScalar(thetaGDiv, colors[3]);
    applyScalar(thetaMDiv, colors[4] || colors[0]);
    applyScalar(phiMDiv, colors[5] || colors[1]);
  }

  function initThemeAndPalette() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    const savedPalette = localStorage.getItem('palette') || 'default';
    if (themeSelect) themeSelect.value = savedTheme;
    if (paletteSelect) paletteSelect.value = savedPalette;
    applyTheme(savedTheme);
    applyThemeToPlots(savedTheme);
    applyPaletteToPlots(savedPalette);
  }

  const baseLayout = {
    margin: { l: 52, r: 12, t: 16, b: 40 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    xaxis: { title: '', showgrid: true, zeroline: false, tickfont: { size: 13 }, titlefont: { size: 14 } },
    yaxis: { title: '', showgrid: true, zeroline: false, tickfont: { size: 13 }, titlefont: { size: 14 } },
    showlegend: true,
    legend: { orientation: 'h', font: { size: 13 } },
    font: { size: 14 },
  };

  const config = { displayModeBar: false, responsive: true };

  function initVectorPlot(div, title) {
    const traces = [
      { name: 'x', mode: 'lines', x: [], y: [] },
      { name: 'y', mode: 'lines', x: [], y: [] },
      { name: 'z', mode: 'lines', x: [], y: [] },
      { name: 'mag', mode: 'lines', x: [], y: [] },
    ];
    const layout = structuredClone(baseLayout);
    layout.yaxis.title = title;
    Plotly.newPlot(div, traces, layout, config);
  }

  function initScalarPlot(div, title) {
    const traces = [{ name: 'value', mode: 'lines', x: [], y: [] }];
    const layout = structuredClone(baseLayout);
    layout.yaxis.title = title;
    Plotly.newPlot(div, traces, layout, config);
  }

  function initDial() {
    const traces = [{ name: 'dir', mode: 'lines+markers', x: [0, 1], y: [0, 0] }];
    const layout = {
      margin: { l: 20, r: 20, t: 10, b: 20 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      xaxis: { range: [-1.2, 1.2], showgrid: true, zeroline: true, scaleanchor: 'y', tickfont: { size: 12 } },
      yaxis: { range: [-1.2, 1.2], showgrid: true, zeroline: true, tickfont: { size: 12 } },
      showlegend: false,
    };
    Plotly.newPlot(dialDiv, traces, layout, config);
  }

  function renderDial(phi_deg) {
    const a = (phi_deg - 90) * (Math.PI / 180);
    const x = Math.cos(a);
    const y = Math.sin(a);
    Plotly.restyle(dialDiv, { x: [[0, x]], y: [[0, y]] }, [0]);
  }

  initVectorPlot(accelDiv, 'accel');
  initVectorPlot(gyroDiv, 'gyro');
  initVectorPlot(magDiv, 'mag');
  initScalarPlot(tempDiv, 'temp');
  initScalarPlot(pressureDiv, 'pressure');
  initScalarPlot(altitudeDiv, 'altitude');
  initScalarPlot(thetaGDiv, 'theta (gravity)');
  initScalarPlot(thetaMDiv, 'theta (mag)');
  initScalarPlot(phiMDiv, 'phi (mag)');
  initDial();

  if (boardNameEl && board) {
    boardNameEl.textContent = board;
    document.title = board;
  }

  uiStreams = getSelectedStreams();

  function updateRecorderUI() {
    recCountEl.textContent = String(recorder.rows.length);
    recordBtn.disabled = recorder.isRecording;
    stopBtn.disabled = !recorder.isRecording;
    exportBtn.disabled = recorder.rows.length === 0;
  }

  function recordRow(item) {
    recorder.rows.push({
      ts_ms: item.ts_ms,
      sensor: item.sensor,
      x: item.x,
      y: item.y,
      z: item.z,
      value: item.value,
    });
  }

  function updateValuePanel(item) {
    if (!isVectorSensor(item.sensor)) return;
    tEl.textContent = fmtTime(item.ts_ms);
    xEl.textContent = item.x.toFixed(3);
    yEl.textContent = item.y.toFixed(3);
    zEl.textContent = item.z.toFixed(3);
    magEl.textContent = item.mag.toFixed(3);
    thetaEl.textContent = item.theta_deg.toFixed(1);
    phiEl.textContent = item.phi_deg.toFixed(1);
  }

  function handleItem(item) {
    bufferedPoints = Math.min(bufferedPoints + 1, maxPoints);
    bufCountEl.textContent = String(bufferedPoints);

    if (recorder.isRecording) {
      recordRow(item);
      updateRecorderUI();
    }
    if (paused) return;

    const ts = item.ts_ms;

    if (item.sensor === 'accel' && shouldDraw('accel') && plotVisible(accelDiv)) {
      draw.accel.ts.push(ts);
      draw.accel.x.push(item.x);
      draw.accel.y.push(item.y);
      draw.accel.z.push(item.z);
      draw.accel.mag.push(item.mag);
      draw.accel.theta.push(item.theta_deg);
    } else if (item.sensor === 'gyro' && shouldDraw('gyro') && plotVisible(gyroDiv)) {
      draw.gyro.ts.push(ts);
      draw.gyro.x.push(item.x);
      draw.gyro.y.push(item.y);
      draw.gyro.z.push(item.z);
      draw.gyro.mag.push(item.mag);
    } else if (item.sensor === 'mag' && shouldDraw('mag') && plotVisible(magDiv)) {
      draw.mag.ts.push(ts);
      draw.mag.x.push(item.x);
      draw.mag.y.push(item.y);
      draw.mag.z.push(item.z);
      draw.mag.mag.push(item.mag);
      draw.mag.theta.push(item.theta_deg);
      draw.mag.phi.push(item.phi_deg);
    } else if (item.sensor === 'temp' && shouldDraw('temp') && plotVisible(tempDiv)) {
      draw.temp.ts.push(ts);
      draw.temp.v.push(item.value);
    } else if (item.sensor === 'pressure' && shouldDraw('pressure') && plotVisible(pressureDiv)) {
      draw.pressure.ts.push(ts);
      draw.pressure.v.push(item.value);
    } else if (item.sensor === 'altitude' && shouldDraw('altitude') && plotVisible(altitudeDiv)) {
      draw.altitude.ts.push(ts);
      draw.altitude.v.push(item.value);
    }
  }

  function yyyymmdd_hhmmss(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    const Y = d.getFullYear();
    const M = pad(d.getMonth() + 1);
    const D = pad(d.getDate());
    const h = pad(d.getHours());
    const m = pad(d.getMinutes());
    const s = pad(d.getSeconds());
    return `${Y}${M}${D}_${h}${m}${s}`;
  }

  applySettings();
  updateRecorderUI();
  initThemeAndPalette();

  windowInput?.addEventListener('change', () => {
    applySettings();
    bufferedPoints = 0;
    setConn('ok', `connected (${deviceKey})`);
  });

  rateInput?.addEventListener('change', () => {
    applySettings();
    bufferedPoints = 0;
    setConn('ok', `connected (${deviceKey})`);
  });

  streamSelect?.addEventListener('change', () => {
    uiStreams = getSelectedStreams();
    uiStream = streamSelect.value;
  });

  themeSelect?.addEventListener('change', () => {
    const v = themeSelect.value || 'dark';
    localStorage.setItem('theme', v);
    applyTheme(v);
    applyThemeToPlots(v);
  });

  paletteSelect?.addEventListener('change', () => {
    const v = paletteSelect.value || 'default';
    localStorage.setItem('palette', v);
    applyPaletteToPlots(v);
  });

  pauseBtn?.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  });

  recordBtn?.addEventListener('click', () => {
    recorder.isRecording = true;
    recorder.startedAt = Date.now();
    recorder.rows.length = 0;
    updateRecorderUI();
  });

  stopBtn?.addEventListener('click', () => {
    recorder.isRecording = false;
    updateRecorderUI();
  });

  exportBtn?.addEventListener('click', async () => {
    if (!recorder.rows.length) return;

    if (!window.XLSX) {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      await new Promise((r, j) => {
        s.onload = r;
        s.onerror = j;
        document.head.appendChild(s);
      });
    }

    const wb = XLSX.utils.book_new();

    const vecSensors = ['accel', 'gyro', 'mag'];
    for (const s of vecSensors) {
      const rows = recorder.rows.filter((r) => r.sensor === s);
      const shaped = rows.map((r) => ({ ts_ms: r.ts_ms, x: r.x, y: r.y, z: r.z }));
      const ws = XLSX.utils.json_to_sheet(shaped);
      XLSX.utils.book_append_sheet(wb, ws, s.toUpperCase());
    }

    const baroRows = recorder.rows.filter((r) => r.sensor === 'temp' || r.sensor === 'pressure' || r.sensor === 'altitude');
    const map = new Map();
    for (const r of baroRows) {
      let row = map.get(r.ts_ms);
      if (!row) {
        row = { ts_ms: r.ts_ms, temp: null, pressure: null, altitude: null };
        map.set(r.ts_ms, row);
      }
      if (r.sensor === 'temp') row.temp = r.value;
      else if (r.sensor === 'pressure') row.pressure = r.value;
      else if (r.sensor === 'altitude') row.altitude = r.value;
    }
    const baroShaped = Array.from(map.values()).sort((a, b) => a.ts_ms - b.ts_ms);
    const wsBaro = XLSX.utils.json_to_sheet(baroShaped);
    XLSX.utils.book_append_sheet(wb, wsBaro, 'BARO');

    const startedAt = recorder.startedAt ?? Date.now();
    const base = board ? board.replace(/[^\w\-]+/g, '_') : 'kiwi';
    const filename = `${base}_${deviceKey}_${yyyymmdd_hhmmss(startedAt)}.xlsx`;
    XLSX.writeFile(wb, filename);
  });

  setConn('warn', 'connecting…');
  reconnectsEl.textContent = '0';
  lastSeenEl.textContent = '-';
  bufMaxEl.textContent = String(maxPoints);
  bufCountEl.textContent = '0';

  const workerSrc = `
    function normalizeTimestampToMs(t) {
      const n = Number(t);
      if (!Number.isFinite(n)) return Date.now();
      if (n > 1e18) return Math.round(n / 1e6);
      if (n > 1e15) return Math.round(n / 1e3);
      if (n > 1e12) return Math.round(n);
      return Math.round(n * 1000);
    }

    function safeNum(v) {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }

    function isVectorSensor(s) {
      return s === 'accel' || s === 'gyro' || s === 'mag';
    }

    function magnitude(x, y, z) {
      return Math.sqrt(x*x + y*y + z*z);
    }

    function toDeg(rad) {
      return (rad * 180) / Math.PI;
    }

    function anglesDeg(x, y, z) {
      const phi = toDeg(Math.atan2(y, x));
      const rho = Math.sqrt(x*x + y*y);
      const theta = toDeg(Math.atan2(rho, z));
      return { phi_deg: phi, theta_deg: theta };
    }

    function normalizeItem(raw) {
      const type = (raw.sensor ?? '').toString().toLowerCase();
      const ts_ms = normalizeTimestampToMs(raw.ts);

      if (isVectorSensor(type)) {
        const x = safeNum(raw.x);
        const y = safeNum(raw.y);
        const z = safeNum(raw.z);
        if (x === null || y === null || z === null) return null;

        const mag = magnitude(x, y, z);
        const ang = anglesDeg(x, y, z);

        return { sensor: type, ts_ms, x, y, z, mag, theta_deg: ang.theta_deg, phi_deg: ang.phi_deg, value: null };
      }

      if (type === 'temp' || type === 'pressure' || type === 'altitude') {
        const value = safeNum(raw.value);
        if (value === null) return null;
        return { sensor: type, ts_ms, x: null, y: null, z: null, mag: null, theta_deg: null, phi_deg: null, value };
      }

      return null;
    }

    function unpackSerde(raw) {
      if (!raw || !raw.measurement || typeof raw.timestamp !== 'number') return null;

      const keys = Object.keys(raw.measurement);
      if (keys.length !== 1) return null;

      const variant = keys[0];
      const values = raw.measurement[variant];
      const ts = raw.timestamp;

      if (Array.isArray(values) && values.length === 3 && variant !== 'Baro') {
        return { sensor: variant.toLowerCase(), x: values[0], y: values[1], z: values[2], ts };
      }

      if (variant === 'Baro' && Array.isArray(values) && values.length === 3) {
        return [
          { sensor: 'temp', value: values[0], ts },
          { sensor: 'pressure', value: values[1], ts },
          { sensor: 'altitude', value: values[2], ts },
        ];
      }

      return null;
    }

    self.onmessage = (ev) => {
      const text = ev.data;
      let parsed;
      try { parsed = JSON.parse(text); } catch { return; }

      const items = Array.isArray(parsed) ? parsed : [parsed];
      const out = [];

      for (const raw of items) {
        const unpacked = unpackSerde(raw);
        if (!unpacked) continue;
        const list = Array.isArray(unpacked) ? unpacked : [unpacked];
        for (const u of list) {
          const item = normalizeItem(u);
          if (item) out.push(item);
        }
      }

      if (out.length) self.postMessage(out);
    };
  `;

  const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'application/javascript' })));

  const MAX_PENDING = 20000;
  function enqueue(item) {
    pending.push(item);
    if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
  }

  worker.onmessage = (ev) => {
    const batch = ev.data;
    for (const item of batch) enqueue(item);
  };

  const esUrl = devicePort ? `/devices/${devicePort}/events` : '/events';
  const es = new EventSource(esUrl);

  es.onopen = () => {
    setConn('ok', `connected (${deviceKey})`);
  };

  es.onmessage = (e) => {
    worker.postMessage(e.data);
  };

  es.onerror = () => {
    reconnects += 1;
    reconnectsEl.textContent = String(reconnects);
    setConn('bad', 'disconnected (auto-retrying…)');
  };

  function flush() {
    if (draw.accel.ts.length) {
      Plotly.extendTraces(
        accelDiv,
        { x: [draw.accel.ts, draw.accel.ts, draw.accel.ts, draw.accel.ts], y: [draw.accel.x, draw.accel.y, draw.accel.z, draw.accel.mag] },
        [0, 1, 2, 3],
        maxPoints
      );
      if (thetaGDiv && plotVisible(thetaGDiv)) {
        Plotly.extendTraces(thetaGDiv, { x: [draw.accel.ts], y: [draw.accel.theta] }, [0], maxPoints);
      }
      draw.accel.ts.length = 0;
      draw.accel.x.length = 0;
      draw.accel.y.length = 0;
      draw.accel.z.length = 0;
      draw.accel.mag.length = 0;
      draw.accel.theta.length = 0;
    }

    if (draw.gyro.ts.length) {
      Plotly.extendTraces(
        gyroDiv,
        { x: [draw.gyro.ts, draw.gyro.ts, draw.gyro.ts, draw.gyro.ts], y: [draw.gyro.x, draw.gyro.y, draw.gyro.z, draw.gyro.mag] },
        [0, 1, 2, 3],
        maxPoints
      );
      draw.gyro.ts.length = 0;
      draw.gyro.x.length = 0;
      draw.gyro.y.length = 0;
      draw.gyro.z.length = 0;
      draw.gyro.mag.length = 0;
    }

    if (draw.mag.ts.length) {
      Plotly.extendTraces(
        magDiv,
        { x: [draw.mag.ts, draw.mag.ts, draw.mag.ts, draw.mag.ts], y: [draw.mag.x, draw.mag.y, draw.mag.z, draw.mag.mag] },
        [0, 1, 2, 3],
        maxPoints
      );
      if (thetaMDiv && plotVisible(thetaMDiv)) {
        Plotly.extendTraces(thetaMDiv, { x: [draw.mag.ts], y: [draw.mag.theta] }, [0], maxPoints);
      }
      if (phiMDiv && plotVisible(phiMDiv)) {
        Plotly.extendTraces(phiMDiv, { x: [draw.mag.ts], y: [draw.mag.phi] }, [0], maxPoints);
      }
      draw.mag.ts.length = 0;
      draw.mag.x.length = 0;
      draw.mag.y.length = 0;
      draw.mag.z.length = 0;
      draw.mag.mag.length = 0;
      draw.mag.theta.length = 0;
      draw.mag.phi.length = 0;
    }

    if (draw.temp.ts.length) {
      Plotly.extendTraces(tempDiv, { x: [draw.temp.ts], y: [draw.temp.v] }, [0], maxPoints);
      draw.temp.ts.length = 0;
      draw.temp.v.length = 0;
    }

    if (draw.pressure.ts.length) {
      Plotly.extendTraces(pressureDiv, { x: [draw.pressure.ts], y: [draw.pressure.v] }, [0], maxPoints);
      draw.pressure.ts.length = 0;
      draw.pressure.v.length = 0;
    }

    if (draw.altitude.ts.length) {
      Plotly.extendTraces(altitudeDiv, { x: [draw.altitude.ts], y: [draw.altitude.v] }, [0], maxPoints);
      draw.altitude.ts.length = 0;
      draw.altitude.v.length = 0;
    }
  }

  function frame(now) {
    if (now - lastFrameMs >= FRAME_MS) {
      lastFrameMs = now;

      if (pending.length) {
        const MAX_LAG_ITEMS = maxPoints;
        if (pending.length > MAX_LAG_ITEMS) pending.splice(0, pending.length - MAX_LAG_ITEMS);

        const batch = pending.splice(0, 600);

        let lastVector = null;
        for (const item of batch) {
          if (isVectorSensor(item.sensor)) lastVector = item;
          handleItem(item);
        }

        flush();

        if (lastVector) {
          updateValuePanel(lastVector);
          renderDial(lastVector.phi_deg);
        }

        if (recorder.isRecording && batch.length) updateRecorderUI();

        setConn('ok', `connected (${deviceKey})`);
        updateLastSeen();
      }
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();