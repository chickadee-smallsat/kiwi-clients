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

  const dashboardGrid = document.getElementById('dashboardGrid');
  const dashboardPanels = Array.from(document.querySelectorAll('.dashboardPanel'));
  const panelValues  = document.getElementById('panel-values');
  const liveValuesToggle = document.getElementById('liveValuesToggle');

  // ── Widget panel elements ─────────────────────────────────────────────────
  const panelHorizon    = document.getElementById('panel-horizon');
  const horizonToggle   = document.getElementById('horizonToggle');
  const crosshairToggle = document.getElementById('crosshairToggle');
  const horizonCanvas  = document.getElementById('horizonCanvas');
  const horizonRollEl  = document.getElementById('horizonRoll');
  const horizonPitchEl = document.getElementById('horizonPitch');

  const params = new URLSearchParams(location.search);
  const deviceKey = params.get('src') || 'all';
  const deviceId = deviceKey === 'all' ? null : deviceKey;
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
  const RELAYOUT_MS = 100;
  let pending = [];
  let lastFrameMs = 0;
  let lastResyncMs = 0;
  let lastRelayoutMs = 0;
  let isSorting = false;
  // track latest timestamp per chart so deferred relayout uses correct range
  const relayoutLatest = { accel: null, gyro: null, mag: null, temp: null, pressure: null, altitude: null };

  const PANEL_STATE_KEY    = `kiwi.dashboard.gridstack.v9.${deviceKey}`;
  const LIVE_VALUES_KEY    = `kiwi.dashboard.liveValues.${deviceKey}`;
  const WIDGET_HORIZON_KEY = `kiwi.widget.horizon.${deviceKey}`;
  const LAYOUT_KEY         = `kiwi.layout.${deviceKey}`;
  const CROSSHAIR_KEY      = `kiwi.plot.crosshair.${deviceKey}`;

  // ── Layout presets ────────────────────────────────────────────────────────
  // Three professional arrangements.  Every row sums to 12 cols so
  // GridStack gravity mode (float:false) keeps explicit y positions intact.
  const LAYOUTS = {
    // ── Rows: sensor-type groups across two equal columns ─────────────────
    rows: [
      { id: 'panel-accel',    x: 0, y: 0,  w: 6, h: 4 },
      { id: 'panel-gyro',     x: 6, y: 0,  w: 6, h: 4 },
      { id: 'panel-mag',      x: 0, y: 4,  w: 6, h: 4 },
      { id: 'panel-3d',       x: 6, y: 4,  w: 6, h: 4 },
      { id: 'panel-temp',     x: 0, y: 8,  w: 4, h: 3 },
      { id: 'panel-pressure', x: 4, y: 8,  w: 4, h: 3 },
      { id: 'panel-altitude', x: 8, y: 8,  w: 4, h: 3 },
    ],
    // ── Focus: motion sensors 75 % wide, environment sidebar 25 % ─────────
    focus: [
      { id: 'panel-accel',    x: 0, y: 0,  w: 9, h: 4 },
      { id: 'panel-temp',     x: 9, y: 0,  w: 3, h: 4 },
      { id: 'panel-gyro',     x: 0, y: 4,  w: 9, h: 4 },
      { id: 'panel-pressure', x: 9, y: 4,  w: 3, h: 4 },
      { id: 'panel-mag',      x: 0, y: 8,  w: 9, h: 4 },
      { id: 'panel-altitude', x: 9, y: 8,  w: 3, h: 4 },
      { id: 'panel-3d',       x: 0, y: 12, w: 6, h: 4 },
    ],
    // ── Grid: uniform 4-col symmetric grid ────────────────────────────────
    grid: [
      { id: 'panel-accel',    x: 0, y: 0, w: 4, h: 4 },
      { id: 'panel-gyro',     x: 4, y: 0, w: 4, h: 4 },
      { id: 'panel-mag',      x: 8, y: 0, w: 4, h: 4 },
      { id: 'panel-temp',     x: 0, y: 4, w: 4, h: 3 },
      { id: 'panel-pressure', x: 4, y: 4, w: 4, h: 3 },
      { id: 'panel-altitude', x: 8, y: 4, w: 4, h: 3 },
      { id: 'panel-3d',       x: 0, y: 7, w: 6, h: 4 },
    ],
  };

  const GRID_COLS = () => {
    if (!dashboardGrid) return 12;
    const cols = getComputedStyle(dashboardGrid).gridTemplateColumns.split(' ').length;
    return Math.max(1, cols);
  };

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
  if (dialStats) dialStats.open = true;

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

    const panel = div.closest('.dashboardPanel');
    if (panel && panel.style.display === 'none') return false;

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

  function applyLiveValuesVisibility() {
    const visible = !!liveValuesToggle?.checked;

    if (panelValues) {
      if (visible) {
        panelValues.style.display = '';
        // Re-register with GridStack so it gets a real cell, not a ghost.
        if (grid && panelValues.classList.contains('grid-stack-item')) {
          try { grid.makeWidget(panelValues); } catch (_) {}
        }
      } else {
        // Detach from layout (without removing DOM node) so the gap closes.
        if (grid && panelValues.classList.contains('grid-stack-item')) {
          try { grid.removeWidget(panelValues, false); } catch (_) {}
        }
        panelValues.style.display = 'none';
      }
    }

    localStorage.setItem(LIVE_VALUES_KEY, visible ? '1' : '0');
    schedulePlotResize();
  }

  function applyWidgetVis(panelEl, toggle, storageKey) {
    const visible = !!toggle?.checked;
    if (panelEl) {
      if (visible) {
        panelEl.style.display = '';
        if (grid && panelEl.classList.contains('grid-stack-item')) {
          try { grid.makeWidget(panelEl); } catch (_) {}
        }
      } else {
        if (grid && panelEl.classList.contains('grid-stack-item')) {
          try { grid.removeWidget(panelEl, false); } catch (_) {}
        }
        panelEl.style.display = 'none';
      }
    }
    localStorage.setItem(storageKey, visible ? '1' : '0');
    schedulePlotResize();
  }

  function applyStreamVisibility() {
    const selected = uiStreams;

    if (!plotDetailsEls.length) {
      applyStreamHint();
      return;
    }

    plotDetailsEls.forEach(d => {
      const s = d.getAttribute('data-stream');
      const panel = d.closest('.dashboardPanel');

      if (panel) {
        panel.style.display = selected.size === 0 ? 'none' : (selected.has(s) ? 'flex' : 'none');
      } else {
        d.style.display = selected.size === 0 ? 'none' : (selected.has(s) ? '' : 'none');
      }
    });

    applyLiveValuesVisibility();
    applyStreamHint();
    schedulePlotResize();
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

    checks.forEach(c => {
      c.checked = selected.has(c.value);
    });
  }

  function setAllStreams(v) {
    if (!streamChecksEl) return;

    const checks = Array.from(streamChecksEl.querySelectorAll('input[type="checkbox"]'));

    checks.forEach(c => {
      c.checked = v;
    });

    syncSelectFromChecks();
    uiStreams = getSelectedStreams();
    uiStream = streamSelect ? streamSelect.value : 'all';
    applyStreamVisibility();
  }

  const THEMES = {
    dark: {
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: '#f5f0e8' },
      xaxis: { gridcolor: 'rgba(251,191,36,.10)' },
      yaxis: { gridcolor: 'rgba(251,191,36,.10)' },
    },
    light: {
      paper_bgcolor: '#fffdf7',
      plot_bgcolor: '#fffdf7',
      font: { color: '#1a1208' },
      xaxis: { gridcolor: 'rgba(120,80,10,.12)' },
      yaxis: { gridcolor: 'rgba(120,80,10,.12)' },
    },
  };

  const PALETTES = {
    default: ['#f59e0b', '#10b981', '#60a5fa', '#f87171', '#a78bfa', '#34d399'],
    colorblind: ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#CC79A7', '#56B4E9'],
  };

  function applyTheme(theme) {
    document.body.classList.toggle('light', theme === 'light');
    document.body.classList.toggle('dark', theme !== 'light');
  }

  function applyThemeToPlots(theme) {
    const t = THEMES[theme] || THEMES.dark;
    const divs = [accelDiv, gyroDiv, magDiv, tempDiv, pressureDiv, altitudeDiv];

    for (const div of divs) {
      if (!div) continue;

      // Use keyed paths instead of whole-axis objects so that per-chart
      // axis settings (title, spikes, hover, etc.) are not overwritten.
      Plotly.relayout(div, {
        paper_bgcolor: t.paper_bgcolor,
        plot_bgcolor: t.plot_bgcolor,
        font: t.font,
        'xaxis.gridcolor': (t.xaxis || {}).gridcolor,
        'yaxis.gridcolor': (t.yaxis || {}).gridcolor,
      });
    }
  }

  function applyPaletteToPlots(paletteKey) {
    const colors = PALETTES[paletteKey] || PALETTES.default;

    function applyVector(div) {
      if (!div) return;

      // Each trace index must receive its own distinct object.
      // Passing a single object literal for multiple indices causes Plotly to
      // mutate that shared reference so all traces end up with the last colour.
      Plotly.restyle(div, { 'line.color': colors[0] }, [0]);
      Plotly.restyle(div, { 'line.color': colors[1] }, [1]);
      Plotly.restyle(div, { 'line.color': colors[2] }, [2]);
      Plotly.restyle(div, { 'line.color': colors[3] }, [3]);
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
    dragmode: false,
    margin: { l: 56, r: 10, t: 12, b: 38 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    // hovermode is intentionally NOT set here — it is controlled at runtime
    // by the "Crosshair hover" toggle (see applyCrosshairMode).
    // Default matches the pre-crosshair behaviour: nearest-point tooltip.
    hovermode: 'closest',
    xaxis: {
      title: { text: 'Time (s)', standoff: 6 },
      showgrid: true,
      zeroline: false,
      tickfont: { size: 12 },
      titlefont: { size: 13 },
      showspikes: false,   // enabled by the crosshair toggle
    },
    yaxis: {
      title: { text: '', standoff: 4 },
      showgrid: true,
      zeroline: false,
      tickfont: { size: 12 },
      titlefont: { size: 13 },
      showspikes: false,
    },
    showlegend: true,
    legend: {
      orientation: 'h',
      font: { size: 12 },
      bgcolor: 'rgba(0,0,0,0)',
      xanchor: 'left',
      x: 0,
    },
    font: { size: 13 },
  };

  // ── Crosshair hover toggle ─────────────────────────────────────────────────
  // When enabled: unified vertical crosshair + spike line on all charts so
  // the operator can read every sensor value at the same instant.
  // When disabled: classic nearest-point tooltip (pre-toggle default).
  function applyCrosshairMode(enabled) {
    const plotDivs = [accelDiv, gyroDiv, magDiv, tempDiv, pressureDiv, altitudeDiv];

    const on = {
      hovermode: 'x unified',
      hoverlabel: {
        bgcolor: 'rgba(9,13,20,.92)',
        bordercolor: 'rgba(245,158,11,.45)',
        font: { color: '#f5f0e8', size: 12, family: 'ui-monospace,monospace' },
        namelength: -1,
      },
      'xaxis.showspikes':      true,
      'xaxis.spikemode':       'across+toaxis',
      'xaxis.spikesnap':       'cursor',
      'xaxis.spikedash':       'solid',
      'xaxis.spikecolor':      'rgba(245,158,11,.45)',
      'xaxis.spikethickness':  1,
    };

    const off = {
      hovermode: 'closest',
      'xaxis.showspikes': false,
    };

    const patch = enabled ? on : off;
    for (const div of plotDivs) {
      if (div) Plotly.relayout(div, patch);
    }

    localStorage.setItem(CROSSHAIR_KEY, enabled ? '1' : '0');
  }

  const config = {
    displayModeBar: false,
    responsive: false,
    staticPlot: false,
    scrollZoom: false,
  };

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
    const traces = [
      { name: 'value', mode: 'lines', x: [], y: [] },
    ];

    const layout = structuredClone(baseLayout);
    layout.yaxis.title = title;

    Plotly.newPlot(div, traces, layout, config);
  }

  function resizePlot(div) {
    if (!div) return;

    const panel = div.closest('.dashboardPanel');
    if (!panel || panel.style.display === 'none') return;

    const details = div.closest('details');
    if (details && !details.open) return;

    const content = panel.querySelector('.grid-stack-item-content') || panel.querySelector('.panelContent') || panel;
    const wrap = div.closest('.plotWrap');
    const summary = details ? details.querySelector('summary') : null;

    if (!wrap) return;

    const contentRect = content.getBoundingClientRect();
    const summaryRect = summary ? summary.getBoundingClientRect() : { height: 0 };

    const wrapStyles = getComputedStyle(wrap);
    const padX = parseFloat(wrapStyles.paddingLeft || 0) + parseFloat(wrapStyles.paddingRight || 0);
    const padY = parseFloat(wrapStyles.paddingTop || 0) + parseFloat(wrapStyles.paddingBottom || 0);

    const width = Math.max(320, Math.floor(contentRect.width - padX - 8));
    const height = Math.max(220, Math.floor(contentRect.height - summaryRect.height - padY - 8));

    wrap.style.height = `${height + padY}px`;
    div.style.width = `${width}px`;
    div.style.height = `${height}px`;
    div.parentElement.style.height = `${height}px`;

    Plotly.relayout(div, {
      autosize: false,
      width,
      height
    });

    Plotly.Plots.resize(div);
  }

  function resizeAllPlots() {
    [accelDiv, gyroDiv, magDiv, tempDiv, pressureDiv, altitudeDiv].forEach(div => {
      resizePlot(div);
    });
  }

  let resizeTimer = null;

  function schedulePlotResize() {
    clearTimeout(resizeTimer);

    resizeTimer = setTimeout(() => {
      requestAnimationFrame(() => {
        resizeAllPlots();
      });
    }, 10);
  }

  function loadPanelState() {
    try {
      return JSON.parse(localStorage.getItem(PANEL_STATE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function savePanelState() {
    const state = {};

    dashboardPanels.forEach(panel => {
      const node = panel.gridstackNode;
      const fallbackHeight = Math.max(3, Math.round(Number(panel.dataset.defaultHeight || 340) / 90));

      state[panel.id] = {
        x: node?.x ?? Number(panel.getAttribute('gs-x') || 0),
        y: node?.y ?? Number(panel.getAttribute('gs-y') || 0),
        w: node?.w ?? Number(panel.getAttribute('gs-w') || panel.dataset.defaultCols || 4),
        h: node?.h ?? Number(panel.getAttribute('gs-h') || fallbackHeight),
      };
    });

    localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(state));
  }

  function clampCols(panel, cols) {
    const maxGridCols = GRID_COLS();
    const min = Math.max(1, Number(panel.dataset.minCols || 1));
    const max = Math.min(maxGridCols, Number(panel.dataset.maxCols || maxGridCols));

    return Math.max(min, Math.min(max, cols));
  }

  function applyPanelSize(panel, cols, height) {
    const nextCols = clampCols(panel, cols);
    const nextHeight = Math.max(240, Math.round(height));

    panel.dataset.cols = String(nextCols);
    panel.dataset.height = String(nextHeight);
    panel.style.setProperty('--col-span', String(nextCols));
    panel.style.setProperty('--panel-height', `${nextHeight}px`);
  }

  function getGridMetrics() {
    if (!dashboardGrid) return { cols: 12, colWidth: 80, gap: 12 };

    const styles = getComputedStyle(dashboardGrid);
    const cols = GRID_COLS();
    const gap = parseFloat(styles.columnGap || styles.gap || '12') || 12;
    const totalGap = gap * (cols - 1);
    const colWidth = (dashboardGrid.clientWidth - totalGap) / cols;

    return { cols, colWidth, gap };
  }

  function buildPanelChrome(panel) {
    if (panel.classList.contains('gridStackReady')) return;

    const saved = loadPanelState();
    const savedPanel = saved[panel.id] || {};

    const defaultW = Number(panel.dataset.defaultCols || 4);
    const defaultH = Math.max(3, Math.round(Number(panel.dataset.defaultHeight || 340) / 90));

    panel.classList.add('grid-stack-item', 'gridStackReady');
    panel.setAttribute('gs-w', String(savedPanel.w || defaultW));
    panel.setAttribute('gs-h', String(savedPanel.h || defaultH));

    // Position: prefer saved state, fall back to data-default-x/y so the
    // first load (no saved state) shows the professionally-arranged layout.
    const sx = savedPanel.x, sy = savedPanel.y;
    if      (Number.isFinite(Number(sx)))               panel.setAttribute('gs-x', String(sx));
    else if (panel.dataset.defaultX !== undefined)      panel.setAttribute('gs-x', panel.dataset.defaultX);
    if      (Number.isFinite(Number(sy)))               panel.setAttribute('gs-y', String(sy));
    else if (panel.dataset.defaultY !== undefined)      panel.setAttribute('gs-y', panel.dataset.defaultY);

    let content = panel.querySelector('.grid-stack-item-content');

    if (!content) {
      content = document.createElement('div');
      content.className = 'grid-stack-item-content panelContent';

      while (panel.firstChild) {
        content.appendChild(panel.firstChild);
      }

      panel.appendChild(content);
    }
  }

  let grid = null;  // assigned inside initPanelLayout; shared with applyLayout

  function initPanelLayout() {
    if (!dashboardGrid || !dashboardPanels.length) return;

    dashboardPanels.forEach(buildPanelChrome);

    const panel3d = document.getElementById('panel-3d');
    if (panel3d) {
      panel3d.style.display = 'block';
      panel3d.classList.add('grid-stack-item');
      panel3d.setAttribute('gs-w', panel3d.getAttribute('gs-w') || '4');
      panel3d.setAttribute('gs-h', panel3d.getAttribute('gs-h') || '5');
    }

    const saved = loadPanelState();

    const order = Array.isArray(saved.order) ? saved.order : [];

    if (order.length) {
      const lookup = new Map(dashboardPanels.map(panel => [panel.id, panel]));

      order.forEach(id => {
        const panel = lookup.get(id);
        if (panel) dashboardGrid.appendChild(panel);
      });
    }

    dashboardPanels.forEach(panel => {
      const savedPanel = saved[panel.id] || {};

      applyPanelSize(
        panel,
        Number(savedPanel.cols || panel.dataset.defaultCols || 4),
        Number(savedPanel.height || panel.dataset.defaultHeight || 320),
      );
    });

    if (window.GridStack && dashboardGrid) {
      dashboardGrid.classList.add('grid-stack');

      grid = GridStack.init({
        column: 12,
        cellHeight: 90,
        margin: 12,
        float: false,             // gravity: items compact upward, no holes
        animate: true,            // slide panels into place on drop
        disableOneColumnMode: false,
        minRow: 1,
        draggable: {
          cancel: 'button, input, select, textarea, summary, iframe, .topMenu, .menu'
        },
        resizable: {
          handles: 'e,se,s'
        }
      }, dashboardGrid);

      grid.on('dragstart resizestart', (_event, el) => {
        isSorting = true;
        document.body.classList.add('dashboardSorting');
        if (el) el.classList.add('dashboardPanelMoving');
        // SSE data keeps flowing into pending; isSorting only blocks the
        // Plotly render loop, so charts catch up the instant drag ends.
      });

      grid.on('dragstop resizestop', (_event, el) => {
        if (el) el.classList.remove('dashboardPanelMoving');
        document.body.classList.remove('dashboardSorting');
        savePanelState();
        setTimeout(() => {
          isSorting = false;   // re-enable frame loop
          resizeAllPlots();    // fit Plotly to new cell dimensions
          resyncPlots();       // redraw from store so x-axis stays current
        }, 120);
      });
    }

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(entries => {
        if (isSorting) return;

        for (const entry of entries) {
          // Resize Plotly charts inside the panel
          const plotDivs = entry.target.querySelectorAll('.plotWrap > div');
          plotDivs.forEach(div => resizePlot(div));

          // Nudge the 3D iframe when its panel changes size
          if (entry.target.id === 'panel-3d') nudge3D();
        }
      });

      dashboardPanels.forEach(panel => observer.observe(panel));
    }

    window.addEventListener('resize', () => {
      dashboardPanels.forEach(panel => {
        applyPanelSize(
          panel,
          Number(panel.dataset.cols || panel.dataset.defaultCols || 4),
          Number(panel.dataset.height || panel.dataset.defaultHeight || 320),
        );
      });

      schedulePlotResize();
      savePanelState();
    });

    plotDetailsEls.forEach(details => {
      details.addEventListener('toggle', schedulePlotResize);
    });

    if (dialStats) dialStats.addEventListener('toggle', schedulePlotResize);

    schedulePlotResize();
  }

  if (accelDiv)    initVectorPlot(accelDiv,    'Acceleration (g)');
  if (gyroDiv)     initVectorPlot(gyroDiv,     'Angular Rate (°/s)');
  if (magDiv)      initVectorPlot(magDiv,      'Magnetic Field (µT)');
  if (tempDiv)     initScalarPlot(tempDiv,     'Temperature (°C)');
  if (pressureDiv) initScalarPlot(pressureDiv, 'Pressure (hPa)');
  if (altitudeDiv) initScalarPlot(altitudeDiv, 'Altitude (m)');

  if (boardNameEl && board) {
    boardNameEl.textContent = board;
    document.title = board;
  }

  uiStreams = getSelectedStreams();

  const savedLiveValues = localStorage.getItem(LIVE_VALUES_KEY);
  if (liveValuesToggle) liveValuesToggle.checked = savedLiveValues === '1';

  // Restore widget visibility from localStorage
  if (horizonToggle) horizonToggle.checked = localStorage.getItem(WIDGET_HORIZON_KEY) === '1';
  if (panelHorizon) panelHorizon.style.display = horizonToggle?.checked ? '' : 'none';

  // Crosshair hover — restore saved preference (default OFF = classic tooltip)
  const savedCrosshair = localStorage.getItem(CROSSHAIR_KEY) === '1';
  if (crosshairToggle) crosshairToggle.checked = savedCrosshair;
  // applyCrosshairMode is called after plots are initialised (see below)

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
    const pad = n => String(n).padStart(2, '0');
    const Y = d.getFullYear();
    const M = pad(d.getMonth() + 1);
    const D = pad(d.getDate());
    const h = pad(d.getHours());
    const m = pad(d.getMinutes());
    const s = pad(d.getSeconds());

    return `${Y}${M}${D}_${h}${m}${s}`;
  }

  function nudge3D() {
    // Dispatch a resize event inside the iframe so Three.js re-measures its
    // canvas.  Same-origin, so contentWindow access is allowed.
    try {
      imu3dFrame?.contentWindow?.dispatchEvent(new Event('resize'));
    } catch (_) {}
  }

  function sync3DFrame() {
    if (!imu3dFrame) return;

    const src = deviceId || 'all';
    const next = `/3d/?src=${encodeURIComponent(src)}&embed=1`;

    if (imu3dFrame.getAttribute('src') !== next) {
      imu3dFrame.setAttribute('src', next);
    }

    // When the 3D app finishes loading its JS it reads the canvas size.
    // By that time GridStack has positioned the panel, so the dimensions are
    // correct — but Three.js still needs a resize nudge to re-render at them.
    imu3dFrame.onload = () => {
      // 100 ms: let the Three.js animation loop start before we resize
      setTimeout(nudge3D, 100);
      // 600 ms: second nudge in case GLB loading takes a moment
      setTimeout(nudge3D, 600);
    };
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

    Plotly.restyle(
      div,
      {
        x: [selected.ts, selected.ts, selected.ts, selected.ts],
        y: [selected.x, selected.y, selected.z, selected.mag],
      },
      [0, 1, 2, 3],
    );

    Plotly.relayout(div, {
      'xaxis.range': [selected.latest - windowSec, selected.latest],
    });
  }

  function resyncScalar(div, selected) {
    if (!div || !selected) return;

    Plotly.restyle(
      div,
      {
        x: [selected.ts],
        y: [selected.v],
      },
      [0],
    );

    Plotly.relayout(div, {
      'xaxis.range': [selected.latest - windowSec, selected.latest],
    });
  }

  function flush() {
    const now = performance.now();
    const doRelayout = (now - lastRelayoutMs) >= RELAYOUT_MS;
    if (doRelayout) lastRelayoutMs = now;

    // Cap Plotly's internal trace buffer at 150 % of the display window so
    // the SVG layer never accumulates unbounded points between resyncs.
    const ptCap = Math.max(200, Math.round(maxPoints * 1.5));

    if (accelDiv && draw.accel.ts.length) {
      relayoutLatest.accel = draw.accel.ts[draw.accel.ts.length - 1];
      Plotly.extendTraces(
        accelDiv,
        {
          x: [draw.accel.ts, draw.accel.ts, draw.accel.ts, draw.accel.ts],
          y: [draw.accel.x, draw.accel.y, draw.accel.z, draw.accel.mag],
        },
        [0, 1, 2, 3],
        ptCap,
      );
      clearAccelDraw();
    }

    if (gyroDiv && draw.gyro.ts.length) {
      relayoutLatest.gyro = draw.gyro.ts[draw.gyro.ts.length - 1];
      Plotly.extendTraces(
        gyroDiv,
        {
          x: [draw.gyro.ts, draw.gyro.ts, draw.gyro.ts, draw.gyro.ts],
          y: [draw.gyro.x, draw.gyro.y, draw.gyro.z, draw.gyro.mag],
        },
        [0, 1, 2, 3],
        ptCap,
      );
      clearGyroDraw();
    }

    if (magDiv && draw.mag.ts.length) {
      relayoutLatest.mag = draw.mag.ts[draw.mag.ts.length - 1];
      Plotly.extendTraces(
        magDiv,
        {
          x: [draw.mag.ts, draw.mag.ts, draw.mag.ts, draw.mag.ts],
          y: [draw.mag.x, draw.mag.y, draw.mag.z, draw.mag.mag],
        },
        [0, 1, 2, 3],
        ptCap,
      );
      clearMagDraw();
    }

    if (tempDiv && draw.temp.ts.length) {
      relayoutLatest.temp = draw.temp.ts[draw.temp.ts.length - 1];
      Plotly.extendTraces(tempDiv, { x: [draw.temp.ts], y: [draw.temp.v] }, [0], ptCap);
      clearTempDraw();
    }

    if (pressureDiv && draw.pressure.ts.length) {
      relayoutLatest.pressure = draw.pressure.ts[draw.pressure.ts.length - 1];
      Plotly.extendTraces(pressureDiv, { x: [draw.pressure.ts], y: [draw.pressure.v] }, [0], ptCap);
      clearPressureDraw();
    }

    if (altitudeDiv && draw.altitude.ts.length) {
      relayoutLatest.altitude = draw.altitude.ts[draw.altitude.ts.length - 1];
      Plotly.extendTraces(altitudeDiv, { x: [draw.altitude.ts], y: [draw.altitude.v] }, [0], ptCap);
      clearAltitudeDraw();
    }

    // Batch all xaxis range updates at 10 Hz — far cheaper than 30 Hz
    if (doRelayout) {
      if (accelDiv    && relayoutLatest.accel    != null) Plotly.relayout(accelDiv,    { 'xaxis.range': [relayoutLatest.accel    - windowSec, relayoutLatest.accel]    });
      if (gyroDiv     && relayoutLatest.gyro     != null) Plotly.relayout(gyroDiv,     { 'xaxis.range': [relayoutLatest.gyro     - windowSec, relayoutLatest.gyro]     });
      if (magDiv      && relayoutLatest.mag      != null) Plotly.relayout(magDiv,      { 'xaxis.range': [relayoutLatest.mag      - windowSec, relayoutLatest.mag]      });
      if (tempDiv     && relayoutLatest.temp     != null) Plotly.relayout(tempDiv,     { 'xaxis.range': [relayoutLatest.temp     - windowSec, relayoutLatest.temp]     });
      if (pressureDiv && relayoutLatest.pressure != null) Plotly.relayout(pressureDiv, { 'xaxis.range': [relayoutLatest.pressure - windowSec, relayoutLatest.pressure] });
      if (altitudeDiv && relayoutLatest.altitude != null) Plotly.relayout(altitudeDiv, { 'xaxis.range': [relayoutLatest.altitude - windowSec, relayoutLatest.altitude] });
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

    schedulePlotResize();
  }

  applySettings();
  updateRecorderUI();
  initThemeAndPalette();
  sync3DFrame();
  initPanelLayout();

setTimeout(() => {
  if (typeof resizeAllPlots === 'function') {
    resizeAllPlots();
  }
  // Apply the saved crosshair preference now that all plots exist
  if (savedCrosshair) applyCrosshairMode(true);
}, 300);


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

  liveValuesToggle?.addEventListener('change', () => {
    applyLiveValuesVisibility();
  });

  horizonToggle?.addEventListener('change', () => applyWidgetVis(panelHorizon, horizonToggle, WIDGET_HORIZON_KEY));

  crosshairToggle?.addEventListener('change', () => applyCrosshairMode(!!crosshairToggle.checked));

  selectAllBtn?.addEventListener('click', () => setAllStreams(true));
  clearAllBtn?.addEventListener('click', () => setAllStreams(false));

  themeSelect?.addEventListener('change', () => {
    const v = themeSelect.value || 'dark';
    localStorage.setItem('theme', v);
    applyTheme(v);
    applyThemeToPlots(v);
    schedulePlotResize();
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
      s.src = '/xlsx.full.min.js';

      await new Promise((r, j) => {
        s.onload = r;
        s.onerror = j;
        document.head.appendChild(s);
      });
    }

    const wb = XLSX.utils.book_new();

    const vecSensors = ['accel', 'gyro', 'mag'];

    for (const s of vecSensors) {
      const rows = recorder.rows.filter(r => r.sensor === s);
      const shaped = rows.map(r => ({
        // elapsed_ms: time in milliseconds since the first received packet
        // (not a Unix epoch — use the filename timestamp for absolute reference)
        elapsed_ms: r.ts_ms,
        x: r.x,
        y: r.y,
        z: r.z,
        magnitude: r.mag ?? null,
      }));

      const ws = XLSX.utils.json_to_sheet(shaped);
      XLSX.utils.book_append_sheet(wb, ws, s.toUpperCase());
    }

    const baroRows = recorder.rows.filter(r => r.sensor === 'temp' || r.sensor === 'pressure' || r.sensor === 'altitude');
    const map = new Map();

    for (const r of baroRows) {
      let row = map.get(r.ts_ms);

      if (!row) {
        row = { elapsed_ms: r.ts_ms, temp_C: null, pressure_hPa: null, altitude_m: null };
        map.set(r.ts_ms, row);
      }

      if (r.sensor === 'temp') row.temp_C = r.value;
      else if (r.sensor === 'pressure') row.pressure_hPa = r.value;
      else if (r.sensor === 'altitude') row.altitude_m = r.value;
    }

    const baroShaped = Array.from(map.values()).sort((a, b) => a.elapsed_ms - b.elapsed_ms);
    const wsBaro = XLSX.utils.json_to_sheet(baroShaped);

    XLSX.utils.book_append_sheet(wb, wsBaro, 'BARO');

    const startedAt = recorder.startedAt ?? Date.now();
    const base = board ? board.replace(/[^\w\-]+/g, '_') : 'kiwi';
    const filename = `${base}_${deviceKey}_${yyyymmdd_hhmmss(startedAt)}.xlsx`;

    XLSX.writeFile(wb, filename);
  });

  open3dBtn?.addEventListener('click', () => {
    const src = deviceId || 'all';
    const url = `/3d/?src=${encodeURIComponent(src)}`;
    window.location.href = url;
  });

  document.getElementById('resetLayoutBtn')?.addEventListener('click', () => {
    localStorage.removeItem(PANEL_STATE_KEY);
    applyLayout('rows');   // restore default positions + sizes, no reload needed
  });

  // Layout preset buttons
  const savedLayout = localStorage.getItem(LAYOUT_KEY) || 'rows';
  document.querySelectorAll('.layoutBtn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layout === savedLayout);
    btn.addEventListener('click', () => applyLayout(btn.dataset.layout));
  });

  setConn('warn', 'connecting…');

  if (reconnectsEl) reconnectsEl.textContent = '0';
  if (lastSeenEl) lastSeenEl.textContent = '-';
  if (bufMaxEl) bufMaxEl.textContent = String(maxPoints);
  if (bufCountEl) bufCountEl.textContent = '0';

  const workerSrc = `
    let firstTs = null;

    function normalizeTimestampToSec(t) {
      const n = Number(t);
      const raw = Number.isFinite(n) ? n : Date.now() / 1000;
      let sec;

      // Disambiguation by magnitude — chosen so device uptime µs never
      // collides with Unix-epoch representations:
      //   > 1.6e15  → Unix epoch in µs  (divide by 1 000 000)
      //   > 1.6e12  → Unix epoch in ms  (divide by 1 000)
      //   > 1.6e9   → Unix epoch in s   (keep as-is; ~year 2020+)
      //   else      → device uptime in µs, any duration (divide by 1 000 000)
      //
      // The old threshold (1e9) caused timestamps > 16.7 min of device uptime
      // to be misread as Unix seconds, corrupting the X-axis range.
      if      (raw > 1_600_000_000_000_000) sec = raw / 1_000_000;  // µs epoch
      else if (raw > 1_600_000_000_000)     sec = raw / 1_000;       // ms epoch
      else if (raw > 1_600_000_000)         sec = raw;               // s epoch
      else                                  sec = raw / 1_000_000;   // uptime µs

      if (firstTs === null) firstTs = sec;

      const elapsed = sec - firstTs;
      return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
    }

    function safeNum(v) {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }

    function isVectorSensor(s) {
      return s === 'accel' || s === 'gyro' || s === 'mag';
    }

    function remapVector(type, x, y, z) {
      if (type === 'accel') return { x: y, y: x, z: -z };
      if (type === 'gyro') return { x, y, z };
      if (type === 'mag') return { x, y, z };
      return { x, y, z };
    }

    function magnitude(x, y, z) {
      return Math.sqrt(x * x + y * y + z * z);
    }

    function toDeg(rad) {
      return (rad * 180) / Math.PI;
    }

    function anglesDeg(x, y, z) {
      const phi = toDeg(Math.atan2(y, x));
      const rho = Math.sqrt(x * x + y * y);
      const theta = toDeg(Math.atan2(rho, z));

      return { phi_deg: phi, theta_deg: theta };
    }

    function normalizeItem(raw) {
      const type = String(raw.sensor ?? '').toLowerCase();
      const ts_s = normalizeTimestampToSec(raw.ts ?? raw.timestamp ?? Date.now());
      const ts_ms = Math.round(ts_s * 1000);

      if (isVectorSensor(type)) {
        const rx = safeNum(raw.x);
        const ry = safeNum(raw.y);
        const rz = safeNum(raw.z);

        if (rx === null || ry === null || rz === null) return null;

        const v = remapVector(type, rx, ry, rz);
        const mag = magnitude(v.x, v.y, v.z);
        const ang = anglesDeg(v.x, v.y, v.z);

        return {
          sensor: type,
          ts_s,
          ts_ms,
          x: v.x,
          y: v.y,
          z: v.z,
          mag,
          theta_deg: ang.theta_deg,
          phi_deg: ang.phi_deg,
          value: null
        };
      }

      if (type === 'temp' || type === 'pressure' || type === 'altitude') {
        const value = safeNum(raw.value);
        if (value === null) return null;

        return {
          sensor: type,
          ts_s,
          ts_ms,
          x: null,
          y: null,
          z: null,
          mag: null,
          theta_deg: null,
          phi_deg: null,
          value
        };
      }

      return null;
    }

    function vectorFromObject(sensor, obj, ts) {
      if (!obj) return null;

      return normalizeItem({
        sensor,
        ts,
        x: obj.x ?? obj.X,
        y: obj.y ?? obj.Y,
        z: obj.z ?? obj.Z
      });
    }

    function scalarFromValue(sensor, value, ts) {
      return normalizeItem({ sensor, ts, value });
    }

    function unpackDummy(raw) {
      if (!raw || typeof raw !== 'object') return null;

      const ts = raw.ts ?? raw.timestamp ?? Date.now();
      const out = [];

      const accel = vectorFromObject('accel', raw.accel ?? raw.Accel, ts);
      const gyro = vectorFromObject('gyro', raw.gyro ?? raw.Gyro, ts);
      const mag = vectorFromObject('mag', raw.mag ?? raw.Mag, ts);

      if (accel) out.push(accel);
      if (gyro) out.push(gyro);
      if (mag) out.push(mag);

      const tempValue = raw.temperature ?? raw.temp ?? raw.Temperature;
      const pressureValue = raw.pressure ?? raw.Pressure;
      const altitudeValue = raw.altitude ?? raw.Altitude;

      const temp = scalarFromValue('temp', tempValue, ts);
      const pressure = scalarFromValue('pressure', pressureValue, ts);
      const altitude = scalarFromValue('altitude', altitudeValue, ts);

      if (temp) out.push(temp);
      if (pressure) out.push(pressure);
      if (altitude) out.push(altitude);

      return out.length ? out : null;
    }

    function unpackSerde(raw) {
      if (!raw || !raw.measurement) return null;

      const ts = raw.timestamp ?? Date.now();
      const keys = Object.keys(raw.measurement);

      if (keys.length !== 1) return null;

      const variant = keys[0];
      const values = raw.measurement[variant];

      if (Array.isArray(values) && values.length === 3 && variant !== 'Baro') {
        return normalizeItem({
          sensor: variant.toLowerCase(),
          x: values[0],
          y: values[1],
          z: values[2],
          ts
        });
      }

      if (variant === 'Baro' && Array.isArray(values) && values.length === 3) {
        return [
          normalizeItem({ sensor: 'temp', value: values[0], ts }),
          normalizeItem({ sensor: 'pressure', value: values[1], ts }),
          normalizeItem({ sensor: 'altitude', value: values[2], ts })
        ].filter(Boolean);
      }

      return null;
    }

    self.onmessage = (ev) => {
      const text = ev.data;
      let parsed;

      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }

      const items = Array.isArray(parsed) ? parsed : [parsed];
      const out = [];

      for (const raw of items) {
        const serde = unpackSerde(raw);
        const dummy = serde ? null : unpackDummy(raw);
        const unpacked = serde ?? dummy;

        if (!unpacked) continue;

        const list = Array.isArray(unpacked) ? unpacked : [unpacked];

        for (const item of list) {
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

    if (pending.length > MAX_PENDING) {
      pending.splice(0, pending.length - MAX_PENDING);
    }
  }

  worker.onmessage = ev => {
    const batch = ev.data;

    for (const item of batch) {
      enqueue(item);
    }
  };

  // ── Widget: Attitude Indicator ────────────────────────────────────────────
  // Classic artificial horizon drawn on <canvas> from accel X/Y/Z.
  // Roll  = atan2(ay, az)
  // Pitch = atan2(-ax, sqrt(ay²+az²))
  let _horizonAnimId = 0;

  function drawHorizon() {
    if (!horizonCanvas || panelHorizon?.style.display === 'none') return;

    const dpr  = window.devicePixelRatio || 1;
    const wrap = horizonCanvas.parentElement;
    const W    = wrap.clientWidth  || 200;
    const H    = wrap.clientHeight || 200;

    // Resize canvas only when dimensions actually change
    if (horizonCanvas.width !== Math.round(W * dpr) || horizonCanvas.height !== Math.round(H * dpr)) {
      horizonCanvas.width  = Math.round(W * dpr);
      horizonCanvas.height = Math.round(H * dpr);
      horizonCanvas.style.width  = W + 'px';
      horizonCanvas.style.height = H + 'px';
    }

    const accelX = store.accel.x, accelY = store.accel.y, accelZ = store.accel.z;
    const n = accelX.length;
    const ax = n ? accelX[n - 1] : 0;
    const ay = n ? accelY[n - 1] : 0;
    const az = n ? accelZ[n - 1] : 0;

    const rollDeg  = Math.atan2(ay, az) * 180 / Math.PI;
    const pitchDeg = Math.atan2(-ax, Math.sqrt(ay * ay + az * az)) * 180 / Math.PI;

    const ctx = horizonCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2, cy = H / 2;
    const R  = Math.min(W, H) * 0.44;          // instrument radius

    // ── clip to circle ──────────────────────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    // ── roll + pitch transform ──────────────────────────────────────────────
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rollDeg * Math.PI / 180);

    const pitchPx = (pitchDeg / 90) * R;  // 1 radius = 90°

    // Sky
    ctx.fillStyle = '#071b30';
    ctx.fillRect(-W * 2, -H * 2 - pitchPx, W * 4, H * 2);
    // Ground
    ctx.fillStyle = '#1c0c00';
    ctx.fillRect(-W * 2, -pitchPx, W * 4, H * 2);

    // Horizon line
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-W * 2, -pitchPx);
    ctx.lineTo(W * 2, -pitchPx);
    ctx.stroke();

    // Pitch ladder — tick every 10°, label every 20°
    const labelSize = Math.round(R * 0.12);
    ctx.font = `${labelSize}px ui-monospace, monospace`;
    ctx.textBaseline = 'middle';

    for (let p = -40; p <= 40; p += 10) {
      if (p === 0) continue;
      const py  = -pitchPx - (p / 90) * R;
      const len = (Math.abs(p) % 20 === 0) ? R * 0.32 : R * 0.18;
      ctx.strokeStyle = 'rgba(245,240,232,.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-len, py);
      ctx.lineTo(len, py);
      ctx.stroke();
      if (Math.abs(p) % 20 === 0) {
        ctx.fillStyle = 'rgba(245,240,232,.65)';
        ctx.textAlign = 'left';
        ctx.fillText(String(Math.abs(p)), len + R * 0.06, py);
        ctx.textAlign = 'right';
        ctx.fillText(String(Math.abs(p)), -(len + R * 0.06), py);
      }
    }

    ctx.restore();  // undo roll/translate

    // ── outer roll arc (fixed) ───────────────────────────────────────────────
    const arcR = R + 2;
    const rollTicks = [0, 10, 20, 30, -10, -20, -30, 45, -45, 60, -60];
    rollTicks.forEach(deg => {
      const a   = (deg - 90) * Math.PI / 180;
      const big = [0, 30, -30, 45, -45, 60, -60].includes(deg);
      const len = big ? R * 0.13 : R * 0.07;
      ctx.strokeStyle = 'rgba(245,240,232,.45)';
      ctx.lineWidth   = deg === 0 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + (arcR - len) * Math.cos(a), cy + (arcR - len) * Math.sin(a));
      ctx.lineTo(cx + arcR         * Math.cos(a), cy + arcR         * Math.sin(a));
      ctx.stroke();
    });

    // Roll-index triangle (rotates with roll)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rollDeg * Math.PI / 180);
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    const ti = arcR - R * 0.06, to = arcR + R * 0.06, tw = R * 0.05;
    ctx.moveTo(0, -ti);
    ctx.lineTo(-tw, -to);
    ctx.lineTo(tw, -to);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.restore();  // undo clip

    // ── outer bezel ring ────────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(251,191,36,.35)';
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    // ── fixed aircraft symbol ───────────────────────────────────────────────
    const aw = R * 0.34, aIn = R * 0.12, aD = R * 0.08;
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth   = 3;
    ctx.lineCap     = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - aw, cy); ctx.lineTo(cx - aIn, cy); ctx.lineTo(cx - aIn, cy + aD);
    ctx.moveTo(cx + aw, cy); ctx.lineTo(cx + aIn, cy); ctx.lineTo(cx + aIn, cy + aD);
    ctx.moveTo(cx - R * 0.06, cy); ctx.lineTo(cx + R * 0.06, cy);
    ctx.stroke();

    // Readout
    if (horizonRollEl)  horizonRollEl.textContent  = rollDeg.toFixed(1)  + '°';
    if (horizonPitchEl) horizonPitchEl.textContent = pitchDeg.toFixed(1) + '°';
  }

  // ── Layout switching ──────────────────────────────────────────────────────
  function applyLayout(name) {
    const spec = LAYOUTS[name];
    if (!spec) return;

    // Update active-button highlight
    document.querySelectorAll('.layoutBtn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.layout === name);
    });

    if (!grid) return;

    // GridStack 9: batchUpdate(true) starts, batchUpdate(false) commits.
    // NOT a callback — passing a function as the flag keeps it stuck in batch
    // mode forever and nothing ever moves.
    grid.batchUpdate(true);
    spec.forEach(({ id, x, y, w, h }) => {
      const el = document.getElementById(id);
      if (!el || !el.classList.contains('grid-stack-item')) return;
      if (el.style.display === 'none') return;
      grid.update(el, { x, y, w, h });
    });
    grid.batchUpdate(false);   // commit — this is what actually moves panels

    localStorage.setItem(LAYOUT_KEY, name);
    savePanelState();
    setTimeout(() => {
      resizeAllPlots();
      resyncPlots();
      nudge3D();  // Three.js re-measures canvas at new panel dimensions
    }, 150);
  }

  const esUrl = deviceId ? `/devices/${encodeURIComponent(deviceId)}/events` : '/events';
  const es = new EventSource(esUrl);

  es.onopen = () => {
    setConn('ok', `connected (${deviceKey})`);
  };

  es.onmessage = e => {
    worker.postMessage(e.data);
  };

  es.onerror = () => {
    reconnects += 1;
    if (reconnectsEl) reconnectsEl.textContent = String(reconnects);
    setConn('bad', 'disconnected (auto-retrying…)');
  };

  function frame(now) {
    if (!isSorting && now - lastFrameMs >= FRAME_MS) {
      lastFrameMs = now;

      if (pending.length) {
        const MAX_LAG_ITEMS = maxPoints;

        if (pending.length > MAX_LAG_ITEMS) {
          pending.splice(0, pending.length - MAX_LAG_ITEMS);
        }

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

        if (recorder.isRecording && batch.length) {
          updateRecorderUI();
        }

        setConn('ok', `connected (${deviceKey})`);
        updateLastSeen();
      }
    }

    // Attitude indicator redraws every frame (canvas, 30 fps)
    drawHorizon();

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  // Guard: never fire when the user is typing in an input/select/textarea
  const topMenuEl = document.getElementById('topMenu');

  // Sync body class so CSS can block grid interactions behind the menu
  topMenuEl?.addEventListener('toggle', () => {
    document.body.classList.toggle('menuOpen', !!topMenuEl.open);
  });

  document.addEventListener('keydown', e => {
    // Skip if focus is inside a form control or contenteditable
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.target?.isContentEditable) return;
    // Skip if any modifier key is held (avoids clashing with browser shortcuts)
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
      case 'p':
      case 'P':
        // Toggle pause — same as clicking the Pause/Resume button
        pauseBtn?.click();
        e.preventDefault();
        break;

      case 'r':
      case 'R':
        // Start recording (only if not already recording)
        if (!recorder.isRecording) recordBtn?.click();
        e.preventDefault();
        break;

      case 's':
      case 'S':
        // Stop recording (only if recording)
        if (recorder.isRecording) stopBtn?.click();
        e.preventDefault();
        break;

      case 'e':
      case 'E':
        // Export Excel (only if data is available)
        if (exportBtn && !exportBtn.disabled) exportBtn.click();
        e.preventDefault();
        break;

      case 'm':
      case 'M':
        // Toggle the ☰ menu open/closed
        if (topMenuEl) topMenuEl.open = !topMenuEl.open;
        e.preventDefault();
        break;

      case 'Escape':
        // Close the menu (no-op if already closed)
        if (topMenuEl) topMenuEl.open = false;
        break;
    }
  });
})();
