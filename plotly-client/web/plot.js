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

  const streamChecksEl = document.getElementById('streamChecks');
  const selectAllBtn = document.getElementById('selectAllBtn');
  const clearAllBtn = document.getElementById('clearAllBtn');
  const streamHintEl = document.getElementById('streamHint');

  const plotDetailsEls = Array.from(document.querySelectorAll('details.plotDetails[data-stream]'));

  const open3dBtn = document.getElementById('open3dBtn');
  const imu3dFrame = document.getElementById('imu3dFrame');

  const splitRoot = document.getElementById('kiwi-split-root');
  const splitter = document.getElementById('kiwi-splitter');
  const rightPane = document.getElementById('kiwi-right-pane');

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
  const RESYNC_MS = 1000;
  let pending = [];
  let lastFrameMs = 0;
  let lastResyncMs = 0;

  const draw = {
    accel: { ts: [], x: [], y: [], z: [], mag: [], theta: [] },
    gyro: { ts: [], x: [], y: [], z: [], mag: [] },
    mag: { ts: [], x: [], y: [], z: [], mag: [], theta: [], phi: [] },
    temp: { ts: [], v: [] },
    pressure: { ts: [], v: [] },
    altitude: { ts: [], v: [] },
  };

  const store = {
    accel: { ts: [], x: [], y: [], z: [], mag: [] },
    gyro: { ts: [], x: [], y: [], z: [], mag: [] },
    mag: { ts: [], x: [], y: [], z: [], mag: [] },
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

  function fmtTime(ms) {
    if (!ms) return '-';
    return new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
  }

  function updateLastSeen() {
    lastSeenMs = Date.now();
    if (lastSeenEl) lastSeenEl.textContent = fmtTime(lastSeenMs);
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
    if (bufMaxEl) bufMaxEl.textContent = String(maxPoints);
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
    if (d.style && d.style.display === 'none') return false;
    return !!d.open;
  }

  function applyStreamHint() {
    if (!streamHintEl || !streamChecksEl) return;
    const checks = Array.from(streamChecksEl.querySelectorAll('input[type="checkbox"]'));
    const selected = checks.filter(c => c.checked).length;
    if (selected === 0) streamHintEl.textContent = 'None';
    else if (selected === checks.length) streamHintEl.textContent = 'All';
    else streamHintEl.textContent = `${selected} selected`;
  }

  function applyStreamVisibility() {
    const selected = uiStreams;
    if (!plotDetailsEls.length) {
      applyStreamHint();
      return;
    }

    plotDetailsEls.forEach(d => {
      const s = d.getAttribute('data-stream');
      d.style.display = selected.size === 0 ? 'none' : (selected.has(s) ? '' : 'none');
    });

    applyStreamHint();
  }

  function syncSelectFromChecks() {
    if (!streamSelect || !streamChecksEl) return;
    const checks = Array.from(streamChecksEl.querySelectorAll('input[type="checkbox"]'));
    const selected = new Set(checks.filter(c => c.checked).map(c => c.value));
    Array.from(streamSelect.options).forEach(opt => {
      opt.selected = selected.has(opt.value);
    });
  }

  function syncChecksFromSelect() {
    if (!streamSelect || !streamChecksEl) return;
    const selected = new Set(Array.from(streamSelect.selectedOptions || []).map(o => o.value));
    const checks = Array.from(streamChecksEl.querySelectorAll('input[type="checkbox"]'));
    checks.forEach(c => (c.checked = selected.has(c.value)));
  }

  function setAllStreams(v) {
    if (!streamChecksEl) return;
    const checks = Array.from(streamChecksEl.querySelectorAll('input[type="checkbox"]'));
    checks.forEach(c => (c.checked = v));
    syncSelectFromChecks();
    uiStreams = getSelectedStreams();
    uiStream = streamSelect ? streamSelect.value : 'all';
    applyStreamVisibility();
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

  function currentTheme() {
    return themeSelect?.value || localStorage.getItem('theme') || 'dark';
  }

  function currentPalette() {
    return paletteSelect?.value || localStorage.getItem('palette') || 'default';
  }

  function applyTheme(theme) {
    document.body.classList.toggle('light', theme === 'light');
    document.body.classList.toggle('dark', theme !== 'light');
  }

  function applyThemeToPlots(theme) {
    const t = THEMES[theme] || THEMES.dark;
    const divs = [accelDiv, gyroDiv, magDiv, tempDiv, pressureDiv, altitudeDiv];
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
  }

  function applyPaletteToPlots(paletteKey) {
    const colors = PALETTES[paletteKey] || PALETTES.default;

    function applyVector(div) {
      if (!div) return;
      Plotly.restyle(div, { line: [{ color: colors[0] }, { color: colors[1] }, { color: colors[2] }, { color: colors[3] }] }, [0, 1, 2, 3]);
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
    xaxis: { title: 'Time (s)', showgrid: true, zeroline: false, tickfont: { size: 13 }, titlefont: { size: 14 } },
    yaxis: { title: '', showgrid: true, zeroline: false, tickfont: { size: 13 }, titlefont: { size: 14 } },
    showlegend: true,
    legend: { orientation: 'h', font: { size: 13 } },
    font: { size: 14 },
  };

  const config = { displayModeBar: false, responsive: true };

  function initVectorPlot(div, title) {
    const traces = [
      { name: 'X', mode: 'lines', x: [], y: [] },
      { name: 'Y', mode: 'lines', x: [], y: [] },
      { name: 'Z', mode: 'lines', x: [], y: [] },
      { name: '|R|', mode: 'lines', x: [], y: [] },
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

  if (accelDiv) initVectorPlot(accelDiv, 'g');
  if (gyroDiv) initVectorPlot(gyroDiv, '°/s');
  if (magDiv) initVectorPlot(magDiv, 'μT');
  if (tempDiv) initScalarPlot(tempDiv, '°C');
  if (pressureDiv) initScalarPlot(pressureDiv, 'hPa');
  if (altitudeDiv) initScalarPlot(altitudeDiv, 'm');

  if (boardNameEl && board) {
    boardNameEl.textContent = board;
    document.title = board;
  }

  uiStreams = getSelectedStreams();
  applyStreamVisibility();

  function updateRecorderUI() {
    if (recCountEl) recCountEl.textContent = String(recorder.rows.length);
    if (recordBtn) recordBtn.disabled = recorder.isRecording;
    if (stopBtn) stopBtn.disabled = !recorder.isRecording;
    if (exportBtn) exportBtn.disabled = recorder.rows.length === 0;
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
    if (tEl) tEl.textContent = `${item.ts_s.toFixed(3)} s`;
    if (xEl) xEl.textContent = item.x.toFixed(3);
    if (yEl) yEl.textContent = item.y.toFixed(3);
    if (zEl) zEl.textContent = item.z.toFixed(3);
    if (magEl) magEl.textContent = item.mag.toFixed(3);
    if (thetaEl) thetaEl.textContent = item.theta_deg.toFixed(1);
    if (phiEl) phiEl.textContent = item.phi_deg.toFixed(1);
  }

  function handleItem(item) {
    bufferedPoints = Math.min(bufferedPoints + 1, maxPoints);
    if (bufCountEl) bufCountEl.textContent = String(bufferedPoints);

    if (recorder.isRecording) {
      recordRow(item);
      updateRecorderUI();
    }
    if (paused) return;

    if (item.sensor === 'accel' && shouldDraw('accel') && plotVisible(accelDiv)) {
      store.accel.ts.push(item.ts_s);
      store.accel.x.push(item.x);
      store.accel.y.push(item.y);
      store.accel.z.push(item.z);
      store.accel.mag.push(item.mag);

      draw.accel.ts.push(item.ts_s);
      draw.accel.x.push(item.x);
      draw.accel.y.push(item.y);
      draw.accel.z.push(item.z);
      draw.accel.mag.push(item.mag);
      draw.accel.theta.push(item.theta_deg);
    } else if (item.sensor === 'gyro' && shouldDraw('gyro') && plotVisible(gyroDiv)) {
      store.gyro.ts.push(item.ts_s);
      store.gyro.x.push(item.x);
      store.gyro.y.push(item.y);
      store.gyro.z.push(item.z);
      store.gyro.mag.push(item.mag);

      draw.gyro.ts.push(item.ts_s);
      draw.gyro.x.push(item.x);
      draw.gyro.y.push(item.y);
      draw.gyro.z.push(item.z);
      draw.gyro.mag.push(item.mag);
    } else if (item.sensor === 'mag' && shouldDraw('mag') && plotVisible(magDiv)) {
      store.mag.ts.push(item.ts_s);
      store.mag.x.push(item.x);
      store.mag.y.push(item.y);
      store.mag.z.push(item.z);
      store.mag.mag.push(item.mag);

      draw.mag.ts.push(item.ts_s);
      draw.mag.x.push(item.x);
      draw.mag.y.push(item.y);
      draw.mag.z.push(item.z);
      draw.mag.mag.push(item.mag);
      draw.mag.theta.push(item.theta_deg);
      draw.mag.phi.push(item.phi_deg);
    } else if (item.sensor === 'temp' && shouldDraw('temp') && plotVisible(tempDiv)) {
      store.temp.ts.push(item.ts_s);
      store.temp.v.push(item.value);

      draw.temp.ts.push(item.ts_s);
      draw.temp.v.push(item.value);
    } else if (item.sensor === 'pressure' && shouldDraw('pressure') && plotVisible(pressureDiv)) {
      store.pressure.ts.push(item.ts_s);
      store.pressure.v.push(item.value);

      draw.pressure.ts.push(item.ts_s);
      draw.pressure.v.push(item.value);
    } else if (item.sensor === 'altitude' && shouldDraw('altitude') && plotVisible(altitudeDiv)) {
      store.altitude.ts.push(item.ts_s);
      store.altitude.v.push(item.value);

      draw.altitude.ts.push(item.ts_s);
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

  function sync3DFrame() {
    if (!imu3dFrame) return;
    const src = devicePort ? String(devicePort) : 'all';
    const next = `/3d/?src=${encodeURIComponent(src)}&embed=1`;
    if (imu3dFrame.getAttribute('src') !== next) imu3dFrame.setAttribute('src', next);
  }

  function initRightPaneResize() {
    if (!splitRoot || !splitter || !rightPane) return;

    const key = 'kiwi.rightPaneWidth';
    const minW = 320;
    const maxW = 820;

    const saved = Number(localStorage.getItem(key));
    if (Number.isFinite(saved)) {
      const w = Math.max(minW, Math.min(maxW, saved));
      splitRoot.style.setProperty('--kiwi-right-w', `${w}px`);
    }

    let dragging = false;
    let startX = 0;
    let startW = 0;

    function onDown(e) {
      dragging = true;
      startX = e.clientX;
      startW = rightPane.getBoundingClientRect().width;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp, { once: true });
    }

    function onMove(e) {
      if (!dragging) return;
      const dx = startX - e.clientX;
      let w = startW + dx;
      w = Math.max(minW, Math.min(maxW, w));
      splitRoot.style.setProperty('--kiwi-right-w', `${w}px`);

      if (accelDiv) Plotly.Plots.resize(accelDiv);
      if (gyroDiv) Plotly.Plots.resize(gyroDiv);
      if (magDiv) Plotly.Plots.resize(magDiv);
      if (tempDiv) Plotly.Plots.resize(tempDiv);
      if (pressureDiv) Plotly.Plots.resize(pressureDiv);
      if (altitudeDiv) Plotly.Plots.resize(altitudeDiv);
    }

    function onUp() {
      dragging = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      const w = rightPane.getBoundingClientRect().width;
      localStorage.setItem(key, String(Math.round(w)));
      window.dispatchEvent(new Event('resize'));
    }

    splitter.addEventListener('mousedown', onDown);
  }

  function clearAccelDraw() {
    draw.accel.ts.length = 0;
    draw.accel.x.length = 0;
    draw.accel.y.length = 0;
    draw.accel.z.length = 0;
    draw.accel.mag.length = 0;
    draw.accel.theta.length = 0;
  }

  function clearGyroDraw() {
    draw.gyro.ts.length = 0;
    draw.gyro.x.length = 0;
    draw.gyro.y.length = 0;
    draw.gyro.z.length = 0;
    draw.gyro.mag.length = 0;
  }

  function clearMagDraw() {
    draw.mag.ts.length = 0;
    draw.mag.x.length = 0;
    draw.mag.y.length = 0;
    draw.mag.z.length = 0;
    draw.mag.mag.length = 0;
    draw.mag.theta.length = 0;
    draw.mag.phi.length = 0;
  }

  function clearTempDraw() {
    draw.temp.ts.length = 0;
    draw.temp.v.length = 0;
  }

  function clearPressureDraw() {
    draw.pressure.ts.length = 0;
    draw.pressure.v.length = 0;
  }

  function clearAltitudeDraw() {
    draw.altitude.ts.length = 0;
    draw.altitude.v.length = 0;
  }

  function trimVectorStore(storeObj) {
    if (!storeObj.ts.length) return null;
    const latest = storeObj.ts[storeObj.ts.length - 1];
    const cutoff = latest - Math.max(windowSec * 3, 30);
    let idx = 0;
    while (idx < storeObj.ts.length && storeObj.ts[idx] < cutoff) idx++;
    if (idx > 0) {
      storeObj.ts.splice(0, idx);
      storeObj.x.splice(0, idx);
      storeObj.y.splice(0, idx);
      storeObj.z.splice(0, idx);
      storeObj.mag.splice(0, idx);
    }
    return latest;
  }

  function trimScalarStore(storeObj) {
    if (!storeObj.ts.length) return null;
    const latest = storeObj.ts[storeObj.ts.length - 1];
    const cutoff = latest - Math.max(windowSec * 3, 30);
    let idx = 0;
    while (idx < storeObj.ts.length && storeObj.ts[idx] < cutoff) idx++;
    if (idx > 0) {
      storeObj.ts.splice(0, idx);
      storeObj.v.splice(0, idx);
    }
    return latest;
  }

  function selectVectorWindow(storeObj) {
    if (!storeObj.ts.length) return null;
    const latest = storeObj.ts[storeObj.ts.length - 1];
    const cutoff = latest - windowSec;
    let idx = 0;
    while (idx < storeObj.ts.length && storeObj.ts[idx] < cutoff) idx++;
    return {
      latest,
      ts: storeObj.ts.slice(idx),
      x: storeObj.x.slice(idx),
      y: storeObj.y.slice(idx),
      z: storeObj.z.slice(idx),
      mag: storeObj.mag.slice(idx),
    };
  }

  function selectScalarWindow(storeObj) {
    if (!storeObj.ts.length) return null;
    const latest = storeObj.ts[storeObj.ts.length - 1];
    const cutoff = latest - windowSec;
    let idx = 0;
    while (idx < storeObj.ts.length && storeObj.ts[idx] < cutoff) idx++;
    return {
      latest,
      ts: storeObj.ts.slice(idx),
      v: storeObj.v.slice(idx),
    };
  }

  function resyncVector(div, selected) {
    if (!div || !selected) return;
    Plotly.restyle(div, {
      x: [selected.ts, selected.ts, selected.ts, selected.ts],
      y: [selected.x, selected.y, selected.z, selected.mag]
    }, [0, 1, 2, 3]);
    Plotly.relayout(div, { 'xaxis.range': [selected.latest - windowSec, selected.latest] });
  }

  function resyncScalar(div, selected) {
    if (!div || !selected) return;
    Plotly.restyle(div, {
      x: [selected.ts],
      y: [selected.v]
    }, [0]);
    Plotly.relayout(div, { 'xaxis.range': [selected.latest - windowSec, selected.latest] });
  }

  function flush() {
    if (accelDiv && draw.accel.ts.length) {
      const latest = draw.accel.ts[draw.accel.ts.length - 1];
      Plotly.extendTraces(
        accelDiv,
        { x: [draw.accel.ts, draw.accel.ts, draw.accel.ts, draw.accel.ts], y: [draw.accel.x, draw.accel.y, draw.accel.z, draw.accel.mag] },
        [0, 1, 2, 3]
      );
      Plotly.relayout(accelDiv, { 'xaxis.range': [latest - windowSec, latest] });
      clearAccelDraw();
    }

    if (gyroDiv && draw.gyro.ts.length) {
      const latest = draw.gyro.ts[draw.gyro.ts.length - 1];
      Plotly.extendTraces(
        gyroDiv,
        { x: [draw.gyro.ts, draw.gyro.ts, draw.gyro.ts, draw.gyro.ts], y: [draw.gyro.x, draw.gyro.y, draw.gyro.z, draw.gyro.mag] },
        [0, 1, 2, 3]
      );
      Plotly.relayout(gyroDiv, { 'xaxis.range': [latest - windowSec, latest] });
      clearGyroDraw();
    }

    if (magDiv && draw.mag.ts.length) {
      const latest = draw.mag.ts[draw.mag.ts.length - 1];
      Plotly.extendTraces(
        magDiv,
        { x: [draw.mag.ts, draw.mag.ts, draw.mag.ts, draw.mag.ts], y: [draw.mag.x, draw.mag.y, draw.mag.z, draw.mag.mag] },
        [0, 1, 2, 3]
      );
      Plotly.relayout(magDiv, { 'xaxis.range': [latest - windowSec, latest] });
      clearMagDraw();
    }

    if (tempDiv && draw.temp.ts.length) {
      const latest = draw.temp.ts[draw.temp.ts.length - 1];
      Plotly.extendTraces(tempDiv, { x: [draw.temp.ts], y: [draw.temp.v] }, [0]);
      Plotly.relayout(tempDiv, { 'xaxis.range': [latest - windowSec, latest] });
      clearTempDraw();
    }

    if (pressureDiv && draw.pressure.ts.length) {
      const latest = draw.pressure.ts[draw.pressure.ts.length - 1];
      Plotly.extendTraces(pressureDiv, { x: [draw.pressure.ts], y: [draw.pressure.v] }, [0]);
      Plotly.relayout(pressureDiv, { 'xaxis.range': [latest - windowSec, latest] });
      clearPressureDraw();
    }

    if (altitudeDiv && draw.altitude.ts.length) {
      const latest = draw.altitude.ts[draw.altitude.ts.length - 1];
      Plotly.extendTraces(altitudeDiv, { x: [draw.altitude.ts], y: [draw.altitude.v] }, [0]);
      Plotly.relayout(altitudeDiv, { 'xaxis.range': [latest - windowSec, latest] });
      clearAltitudeDraw();
    }
  }

  function resyncPlots() {
    trimVectorStore(store.accel);
    trimVectorStore(store.gyro);
    trimVectorStore(store.mag);
    trimScalarStore(store.temp);
    trimScalarStore(store.pressure);
    trimScalarStore(store.altitude);

    resyncVector(accelDiv, selectVectorWindow(store.accel));
    resyncVector(gyroDiv, selectVectorWindow(store.gyro));
    resyncVector(magDiv, selectVectorWindow(store.mag));
    resyncScalar(tempDiv, selectScalarWindow(store.temp));
    resyncScalar(pressureDiv, selectScalarWindow(store.pressure));
    resyncScalar(altitudeDiv, selectScalarWindow(store.altitude));
  }

  applySettings();
  updateRecorderUI();
  initThemeAndPalette();
  sync3DFrame();
  initRightPaneResize();

  windowInput?.addEventListener('change', () => {
    applySettings();
    resyncPlots();
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
    syncChecksFromSelect();
    applyStreamVisibility();
  });

  if (streamChecksEl) {
    const checks = Array.from(streamChecksEl.querySelectorAll('input[type="checkbox"]'));
    checks.forEach(c => {
      c.addEventListener('change', () => {
        syncSelectFromChecks();
        uiStreams = getSelectedStreams();
        uiStream = streamSelect ? streamSelect.value : 'all';
        applyStreamVisibility();
      });
    });
  }

  selectAllBtn?.addEventListener('click', () => setAllStreams(true));
  clearAllBtn?.addEventListener('click', () => setAllStreams(false));

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

  open3dBtn?.addEventListener('click', () => {
    const src = devicePort ? String(devicePort) : 'all';
    window.open(`/3d/?src=${encodeURIComponent(src)}`, '_blank');
  });

  setConn('warn', 'connecting…');
  if (reconnectsEl) reconnectsEl.textContent = '0';
  if (lastSeenEl) lastSeenEl.textContent = '-';
  if (bufMaxEl) bufMaxEl.textContent = String(maxPoints);
  if (bufCountEl) bufCountEl.textContent = '0';

  const workerSrc = `
    function normalizeTimestampToSec(t) {
      const n = Number(t);
      if (!Number.isFinite(n)) return 0;
      return n / 1000000;
    }

    function safeNum(v) {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }

    function isVectorSensor(s) {
      return s === 'accel' || s === 'gyro' || s === 'mag';
    }

    function remapVector(type, x, y, z) {
      if (type === 'accel') {
        return { x: y, y: x, z: -z };
      }
      if (type === 'gyro') {
        return { x: x, y: y, z: z };
      }
      if (type === 'mag') {
        return { x: x, y: y, z: z };
      }
      return { x, y, z };
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
      const ts_s = normalizeTimestampToSec(raw.ts);
      const ts_ms = Math.round(ts_s * 1000);

      if (isVectorSensor(type)) {
        const rx = safeNum(raw.x);
        const ry = safeNum(raw.y);
        const rz = safeNum(raw.z);
        if (rx === null || ry === null || rz === null) return null;

        const v = remapVector(type, rx, ry, rz);

        const mag = magnitude(v.x, v.y, v.z);
        const ang = anglesDeg(v.x, v.y, v.z);

        return { sensor: type, ts_s, ts_ms, x: v.x, y: v.y, z: v.z, mag, theta_deg: ang.theta_deg, phi_deg: ang.phi_deg, value: null };
      }

      if (type === 'temp' || type === 'pressure' || type === 'altitude') {
        const value = safeNum(raw.value);
        if (value === null) return null;
        return { sensor: type, ts_s, ts_ms, x: null, y: null, z: null, mag: null, theta_deg: null, phi_deg: null, value };
      }

      return null;
    }

    function unpackSerde(raw) {
      if (!raw || !raw.measurement) return null;

      const ts = Number(raw.timestamp);
      if (!Number.isFinite(ts)) return null;

      const keys = Object.keys(raw.measurement);
      if (keys.length !== 1) return null;

      const variant = keys[0];
      const values = raw.measurement[variant];

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
    if (reconnectsEl) reconnectsEl.textContent = String(reconnects);
    setConn('bad', 'disconnected (auto-retrying…)');
  };

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

        if (now - lastResyncMs >= RESYNC_MS) {
          resyncPlots();
          lastResyncMs = now;
        }

        if (lastVector) updateValuePanel(lastVector);

        if (recorder.isRecording && batch.length) updateRecorderUI();

        setConn('ok', `connected (${deviceKey})`);
        updateLastSeen();
      }
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();