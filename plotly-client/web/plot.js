// Per-device live dashboard. Loaded as an ES module by dashboard.html.
import { isVectorSensor, tiltDeg } from './kiwi-protocol.js';
import { Recorder, buildSheets, exportFilename } from './recorder.js';

(() => {
  const connPill = document.getElementById('connPill');
  const connText = document.getElementById('connText');
  const reconnectsEl = document.getElementById('reconnects');
  const lastSeenEl = document.getElementById('lastSeen');
  const windowPointsEl = document.getElementById('windowPoints');

  const pauseBtn = document.getElementById('pauseBtn');
  const windowInput = document.getElementById('windowSec');

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
  const deviceId = params.get('src');
  // A dashboard always shows one device; without one, go pick it on the landing page.
  if (!deviceId) {
    location.replace('/');
    return;
  }
  const deviceKey = deviceId;
  const board = params.get('board');

  let paused = false;
  let reconnects = 0;
  let lastSeenMs = null;

  let windowSec = toInt(windowInput?.value, 2);

  const recorder = new Recorder();

  let selectedStreams = new Set();
  let latestAccel = null; // newest accelerometer sample, for the attitude indicator

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

  const PANEL_STATE_KEY    = `kiwi.dashboard.gridstack.v10.${deviceKey}`;
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

  const plotDivs = { accel: accelDiv, gyro: gyroDiv, mag: magDiv, temp: tempDiv, pressure: pressureDiv, altitude: altitudeDiv };
  const PLOTTED = Object.keys(plotDivs);
  // Series per plot: vectors draw x, y, z and |R|; scalars one value.
  const seriesOf = (sensor) => (isVectorSensor(sensor) ? ['x', 'y', 'z', 'mag'] : ['value']);
  const traceIndices = (keys) => keys.map((_, i) => i);

  function emptyBuffers() {
    return Object.fromEntries(
      PLOTTED.map((s) => [s, { ts: [], ...Object.fromEntries(seriesOf(s).map((k) => [k, []])) }]),
    );
  }

  function clearBuffer(buf) {
    for (const arr of Object.values(buf)) arr.length = 0;
  }

  // store: recent history per plot (for resync); draw: points not yet sent to Plotly.
  const store = emptyBuffers();
  const draw = emptyBuffers();

  const dialStats = document.getElementById('dialStats');

  function toInt(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : fallback;
  }

  function getCss(varName) {
    return getComputedStyle(document.body).getPropertyValue(varName).trim();
  }

  // Status text while data flows; keeps the last board restart visible.
  let restartNote = '';
  function connectedText() {
    return `Live${restartNote}`;
  }

  function setConn(state, text) {
    if (!connText || !connPill) return;
    connText.textContent = text;
    connPill.dataset.state = state;
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
    if (age > 2000) setConn('warn', `No data for ${Math.round(age / 1000)} s`);
  }, 500);

  function applySettings() {
    windowSec = Math.max(1, Math.min(10, toInt(windowInput?.value, 2)));
    if (windowInput) windowInput.value = String(windowSec);
  }

  function readSelectedStreams() {
    if (!streamChecksEl) return new Set();
    const checks = Array.from(streamChecksEl.querySelectorAll('input[type="checkbox"]'));
    return new Set(checks.filter((c) => c.checked).map((c) => c.value));
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

  // A hidden panel must also leave GridStack (keeping its DOM node), otherwise
  // it still reserves its rows and leaves an empty band below the dashboard.
  function setPanelShown(panel, shown) {
    if (!panel) return;
    if (shown) {
      panel.style.display = '';
      if (grid && !panel.gridstackNode) grid.makeWidget(panel);
    } else {
      if (grid && panel.gridstackNode) grid.removeWidget(panel, false);
      panel.style.display = 'none';
    }
  }

  function applyLiveValuesVisibility() {
    applyWidgetVis(panelValues, liveValuesToggle, LIVE_VALUES_KEY);
  }

  function applyWidgetVis(panelEl, toggle, storageKey) {
    const visible = !!toggle?.checked;
    setPanelShown(panelEl, visible);
    localStorage.setItem(storageKey, visible ? '1' : '0');
    schedulePlotResize();
  }

  function applyStreamVisibility() {
    const selected = selectedStreams;

    if (!plotDetailsEls.length) {
      applyStreamHint();
      return;
    }

    plotDetailsEls.forEach(d => {
      const s = d.getAttribute('data-stream');
      const panel = d.closest('.dashboardPanel');

      if (panel) {
        setPanelShown(panel, selected.has(s));
      } else {
        d.style.display = selected.size === 0 ? 'none' : (selected.has(s) ? '' : 'none');
      }
    });

    applyLiveValuesVisibility();
    applyStreamHint();
    schedulePlotResize();
  }

  function setAllStreams(v) {
    if (!streamChecksEl) return;
    for (const c of streamChecksEl.querySelectorAll('input[type="checkbox"]')) c.checked = v;
    selectedStreams = readSelectedStreams();
    applyStreamVisibility();
  }

  // Plot chrome is read from the CSS theme tokens so plots always match the page.
  function plotTheme() {
    return {
      text: getCss('--plot-text'),
      grid: getCss('--plot-grid'),
      hoverBg: getCss('--plot-hover-bg'),
      hoverText: getCss('--text'),
      accentLine: getCss('--accent-line'),
    };
  }

  const PALETTES = {
    default: ['#f59e0b', '#10b981', '#60a5fa', '#f87171', '#a78bfa', '#34d399'],
    colorblind: ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#CC79A7', '#56B4E9'],
  };

  let horizonColors = null; // attitude-indicator colours, rebuilt on theme change

  function applyTheme(theme) {
    for (const el of [document.documentElement, document.body]) {
      el.classList.toggle('light', theme === 'light');
      el.classList.toggle('dark', theme !== 'light');
    }
    horizonColors = null;
  }

  function applyThemeToPlots() {
    const t = plotTheme();
    const divs = [accelDiv, gyroDiv, magDiv, tempDiv, pressureDiv, altitudeDiv];

    for (const div of divs) {
      if (!div) continue;

      // Keyed paths keep per-chart axis settings (title, spikes) intact.
      Plotly.relayout(div, {
        'font.color': t.text,
        'xaxis.gridcolor': t.grid,
        'yaxis.gridcolor': t.grid,
        'xaxis.linecolor': t.grid,
        'yaxis.linecolor': t.grid,
        'hoverlabel.bgcolor': t.hoverBg,
        'hoverlabel.bordercolor': t.accentLine,
        'hoverlabel.font.color': t.hoverText,
        'xaxis.spikecolor': t.accentLine,
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
    applyThemeToPlots();
    applyPaletteToPlots(savedPalette);
  }

  const baseLayout = {
    dragmode: false,
    margin: { l: 58, r: 12, t: 8, b: 40 },
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
      tickfont: { size: 11, family: 'JetBrains Mono, ui-monospace, monospace' },
      titlefont: { size: 12 },
      showspikes: false,   // enabled by the crosshair toggle
    },
    yaxis: {
      title: { text: '', standoff: 4 },
      showgrid: true,
      zeroline: false,
      tickfont: { size: 11, family: 'JetBrains Mono, ui-monospace, monospace' },
      titlefont: { size: 12 },
      showspikes: false,
    },
    showlegend: true,
    // Legend sits above the plot area, right-aligned, clear of the x-axis title.
    legend: {
      orientation: 'h',
      font: { size: 12 },
      bgcolor: 'rgba(0,0,0,0)',
      xanchor: 'right',
      x: 1,
      yanchor: 'bottom',
      y: 1,
    },
    font: { size: 12, family: 'Inter, system-ui, sans-serif' },
    hoverlabel: { font: { family: 'JetBrains Mono, ui-monospace, monospace', size: 12 } },
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
        bgcolor: plotTheme().hoverBg,
        bordercolor: plotTheme().accentLine,
        font: { color: plotTheme().hoverText, size: 12, family: 'JetBrains Mono, ui-monospace, monospace' },
        namelength: -1,
      },
      'xaxis.showspikes':      true,
      'xaxis.spikemode':       'across+toaxis',
      'xaxis.spikesnap':       'cursor',
      'xaxis.spikedash':       'solid',
      'xaxis.spikecolor':      plotTheme().accentLine,
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
    layout.margin = { ...layout.margin, t: 28 }; // room for the legend

    Plotly.newPlot(div, traces, layout, config);
  }

  function initScalarPlot(div, title) {
    const traces = [
      { name: 'value', mode: 'lines', x: [], y: [] },
    ];

    const layout = structuredClone(baseLayout);
    layout.yaxis.title = title;
    layout.showlegend = false; // one trace: the panel title already names it

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

  function buildPanelChrome(panel) {
    if (panel.classList.contains('gridStackReady')) return;

    const saved = loadPanelState();
    const savedPanel = saved[panel.id] || {};

    const defaultW = Number(panel.dataset.defaultCols || 4);
    const defaultH = Math.max(3, Math.round(Number(panel.dataset.defaultHeight || 340) / 90));

    panel.classList.add('grid-stack-item', 'gridStackReady');
    panel.setAttribute('gs-w', String(savedPanel.w || defaultW));
    panel.setAttribute('gs-h', String(savedPanel.h || defaultH));
    if (panel.dataset.minCols) panel.setAttribute('gs-min-w', panel.dataset.minCols);
    if (panel.dataset.maxCols) panel.setAttribute('gs-max-w', panel.dataset.maxCols);

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

    if (window.GridStack && dashboardGrid) {
      dashboardGrid.classList.add('grid-stack');

      // init adopts only .grid-stack-item children; panels that start hidden
      // join later through setPanelShown.
      dashboardPanels.forEach(p => { if (p.style.display === 'none') p.classList.remove('grid-stack-item'); });

      grid = GridStack.init({
        column: 12,
        cellHeight: 90,
        margin: 12,
        float: false,             // gravity: items compact upward, no holes
        animate: true,            // slide panels into place on drop
        // Switched by hand below: GridStack's built-in one-column mode, when the
        // page loads narrow, stacks panels in insertion order and they push
        // each other out of order.
        disableOneColumnMode: true,
        minRow: 1,
        draggable: {
          cancel: 'button, input, select, textarea, summary, iframe, .topMenu, .menu'
        },
        resizable: {
          handles: 'e,se,s'
        }
      }, dashboardGrid);

      // Phones: one column, keeping the desktop reading order.
      const narrow = window.matchMedia('(max-width: 768px)');
      const fitColumns = () => grid.column(narrow.matches ? 1 : 12);
      fitColumns();
      narrow.addEventListener('change', fitColumns);

      grid.on('dragstart resizestart', (_event, el) => {
        isSorting = true;
        set3DPaused(true);
        document.body.classList.add('dashboardSorting');
        if (el) el.classList.add('dashboardPanelMoving');
        // SSE data keeps flowing into pending; isSorting only blocks the
        // Plotly render loop, so charts catch up the instant drag ends.
      });

      grid.on('dragstop resizestop', (_event, el) => {
        if (el) el.classList.remove('dashboardPanelMoving');
        document.body.classList.remove('dashboardSorting');
        savePanelState();
        set3DPaused(false);
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

    window.addEventListener('resize', schedulePlotResize);

    plotDetailsEls.forEach(details => {
      details.addEventListener('toggle', schedulePlotResize);
    });

    if (dialStats) dialStats.addEventListener('toggle', schedulePlotResize);

    schedulePlotResize();
  }

  if (accelDiv)    initVectorPlot(accelDiv,    'Acceleration (g)');
  if (gyroDiv)     initVectorPlot(gyroDiv,     'Angular Rate (°/s)');
  if (magDiv)      initVectorPlot(magDiv,      'Magnetic Field (mG)');
  if (tempDiv)     initScalarPlot(tempDiv,     'Temperature (°C)');
  if (pressureDiv) initScalarPlot(pressureDiv, 'Pressure (hPa)');
  if (altitudeDiv) initScalarPlot(altitudeDiv, 'Altitude (m)');

  if (boardNameEl) boardNameEl.textContent = board ? `${board} · ${deviceKey}` : deviceKey;
  document.title = `Kiwi · ${board || deviceKey}`;

  selectedStreams = readSelectedStreams();

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

  const recTimerEl = document.getElementById('recTimer');
  function updateRecTimer() {
    if (!recorder.isRecording || !recTimerEl) return;
    const s = Math.floor((Date.now() - recorder.startedAt) / 1000);
    const hh = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    recTimerEl.textContent = hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  setInterval(updateRecTimer, 500);

  function updateRecorderUI() {
    document.body.classList.toggle('recording', recorder.isRecording);
    updateRecTimer();
    if (recCountEl) recCountEl.textContent = recorder.rows.length.toLocaleString('en-US');
    if (recordBtn) recordBtn.disabled = recorder.isRecording;
    if (stopBtn) stopBtn.disabled = !recorder.isRecording;
    if (exportBtn) exportBtn.disabled = recorder.rows.length === 0;
  }

  const kpiEls = {
    accel: document.getElementById('kpi-accel'),
    gyro: document.getElementById('kpi-gyro'),
    mag: document.getElementById('kpi-mag'),
    temp: document.getElementById('kpi-temp'),
    pressure: document.getElementById('kpi-pressure'),
    altitude: document.getElementById('kpi-altitude'),
  };
  const kpiAxesEls = {
    accel: document.getElementById('kpi-accel-xyz'),
    gyro: document.getElementById('kpi-gyro-xyz'),
    mag: document.getElementById('kpi-mag-xyz'),
  };
  const KPI_DIGITS = { accel: 3, gyro: 2, mag: 1, temp: 2, pressure: 2, altitude: 1 };
  const kpiLatest = {};
  let lastKpiMs = 0;

  function noteKpi(item) {
    kpiLatest[item.sensor] = item;
  }

  function renderKpis(now) {
    if (now - lastKpiMs < 100) return;
    lastKpiMs = now;
    for (const [sensor, el] of Object.entries(kpiEls)) {
      const item = kpiLatest[sensor];
      if (!item) continue;
      const digits = KPI_DIGITS[sensor];
      if (isVectorSensor(sensor)) {
        if (el && Number.isFinite(item.mag)) el.textContent = item.mag.toFixed(digits);
        const axesEl = kpiAxesEls[sensor];
        if (axesEl) axesEl.textContent = `x ${item.x.toFixed(digits)} · y ${item.y.toFixed(digits)} · z ${item.z.toFixed(digits)}`;
      } else if (el && Number.isFinite(item.value)) {
        el.textContent = item.value.toFixed(digits);
      }
    }
  }

  function updateValuePanel(item) {
    if (tEl) tEl.textContent = `${item.t_s.toFixed(3)} s`;
    if (xEl) xEl.textContent = item.x.toFixed(3);
    if (yEl) yEl.textContent = item.y.toFixed(3);
    if (zEl) zEl.textContent = item.z.toFixed(3);
    if (magEl) magEl.textContent = item.mag.toFixed(3);
    if (thetaEl) thetaEl.textContent = item.theta_deg.toFixed(1);
    if (phiEl) phiEl.textContent = item.phi_deg.toFixed(1);
  }

  function handleItem(item) {
    const s = item.sensor;
    if (paused || !selectedStreams.has(s) || !plotVisible(plotDivs[s])) return;
    for (const buf of [store[s], draw[s]]) {
      buf.ts.push(item.t_s);
      for (const k of seriesOf(s)) buf[k].push(item[k]);
    }
  }

  function nudge3D() {
    // Dispatch a resize event inside the iframe so Three.js re-measures its
    // canvas.  Same-origin, so contentWindow access is allowed.
    try {
      imu3dFrame?.contentWindow?.dispatchEvent(new Event('resize'));
    } catch (_) {}
  }

  // WebGL rendering competes with GridStack for the main thread; stop drawing
  // the 3D view while a panel is being dragged or resized.
  function set3DPaused(paused) {
    try {
      if (imu3dFrame?.contentWindow) imu3dFrame.contentWindow.kiwiPaused = paused;
    } catch (_) {}
  }

  function sync3DFrame() {
    if (!imu3dFrame) return;

    const src = deviceId;
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

  function firstIndexAtOrAfter(ts, t) {
    let i = 0;
    while (i < ts.length && ts[i] < t) i++;
    return i;
  }

  // Append new points to each plot; x-axis ranges follow at 10 Hz.
  function flush() {
    const now = performance.now();
    const doRelayout = now - lastRelayoutMs >= RELAYOUT_MS;
    if (doRelayout) lastRelayoutMs = now;

    for (const s of PLOTTED) {
      const div = plotDivs[s];
      const buf = draw[s];
      if (!div) continue;
      if (buf.ts.length) {
        const keys = seriesOf(s);
        relayoutLatest[s] = buf.ts[buf.ts.length - 1];
        Plotly.extendTraces(div, { x: keys.map(() => buf.ts), y: keys.map((k) => buf[k]) }, traceIndices(keys));
        clearBuffer(buf);
      }
      if (doRelayout && relayoutLatest[s] != null) {
        Plotly.relayout(div, { 'xaxis.range': [relayoutLatest[s] - windowSec, relayoutLatest[s]] });
      }
    }
  }

  // Every second: drop history older than three windows (at least 30 s) and
  // redraw each plot from it, so Plotly's buffers hold exactly the window.
  function resyncPlots() {
    for (const s of PLOTTED) {
      const buf = store[s];
      const div = plotDivs[s];
      if (!buf.ts.length) continue;

      const latest = buf.ts[buf.ts.length - 1];
      const old = firstIndexAtOrAfter(buf.ts, latest - Math.max(windowSec * 3, 30));
      if (old) for (const arr of Object.values(buf)) arr.splice(0, old);
      if (!div) continue;

      const from = firstIndexAtOrAfter(buf.ts, latest - windowSec);
      const ts = buf.ts.slice(from);
      const keys = seriesOf(s);
      Plotly.restyle(div, { x: keys.map(() => ts), y: keys.map((k) => buf[k].slice(from)) }, traceIndices(keys));
      Plotly.relayout(div, { 'xaxis.range': [latest - windowSec, latest] });
      if (s === 'accel' && windowPointsEl) windowPointsEl.textContent = String(ts.length);
    }

    schedulePlotResize();
  }

  function clearAllPlots() {
    pending = [];
    latestAccel = null;
    for (const s of PLOTTED) {
      clearBuffer(store[s]);
      clearBuffer(draw[s]);
      relayoutLatest[s] = null;
      const div = plotDivs[s];
      if (!div) continue;
      const keys = seriesOf(s);
      Plotly.restyle(div, { x: keys.map(() => []), y: keys.map(() => []) }, traceIndices(keys));
    }
  }

  applySettings();
  updateRecorderUI();
  initThemeAndPalette();
  sync3DFrame();
  initPanelLayout();

  setTimeout(() => {
    resizeAllPlots();
    // Apply the saved crosshair preference now that all plots exist.
    if (savedCrosshair) applyCrosshairMode(true);
  }, 300);

  windowInput?.addEventListener('change', () => {
    applySettings();
    resyncPlots();
  });

  streamChecksEl?.addEventListener('change', () => {
    selectedStreams = readSelectedStreams();
    applyStreamVisibility();
  });

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
    applyThemeToPlots();
    try {
      imu3dFrame?.contentWindow?.kiwiSetTheme?.(v);
    } catch (_) {}
    schedulePlotResize();
  });

  // Keep every open Kiwi page (tabs, embedded dashboards) on the same theme.
  window.addEventListener('storage', e => {
    if (e.key !== 'theme' || !e.newValue) return;
    if (themeSelect) themeSelect.value = e.newValue;
    applyTheme(e.newValue);
    applyThemeToPlots();
    try {
      imu3dFrame?.contentWindow?.kiwiSetTheme?.(e.newValue);
    } catch (_) {}
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
    recorder.start();
    updateRecorderUI();
  });

  stopBtn?.addEventListener('click', () => {
    recorder.stop();
    updateRecorderUI();
  });

  // The Excel library (~0.9 MB) is loaded on first export only.
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/xlsx.full.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('could not load /xlsx.full.min.js'));
      document.head.appendChild(s);
    });
  }

  exportBtn?.addEventListener('click', async () => {
    if (!recorder.rows.length) return;
    const label = exportBtn.textContent;
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting…';
    try {
      await loadXlsx();
      const wb = XLSX.utils.book_new();
      for (const sheet of buildSheets(recorder.rows)) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet.rows), sheet.name);
      }
      XLSX.writeFile(wb, exportFilename(board, deviceKey, recorder.startedAt ?? Date.now()));
    } catch (err) {
      // Keep the recording so the user can retry; never fail silently.
      console.error('Excel export failed:', err);
      window.alert(`Excel export failed: ${err.message}. The recording is kept; try again.`);
    } finally {
      exportBtn.textContent = label;
      updateRecorderUI();
    }
  });

  open3dBtn?.addEventListener('click', () => {
    const src = deviceId;
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

  setConn('warn', 'Connecting…');

  if (reconnectsEl) reconnectsEl.textContent = '0';
  if (lastSeenEl) lastSeenEl.textContent = '-';

  // Parsing happens off the UI thread; see parser.worker.js.
  const worker = new Worker('/parser.worker.js', { type: 'module' });
  // Without the parser nothing reaches the plots or the recording: say so.
  worker.onerror = (e) => {
    e.preventDefault();
    setConn('bad', 'Data parser failed · reload the page');
    console.error('parser.worker.js failed:', e.message);
  };
  worker.onmessageerror = () => setConn('bad', 'Data parser failed · reload the page');

  const MAX_PENDING = 20000;

  function enqueue(item) {
    pending.push(item);

    if (pending.length > MAX_PENDING) {
      pending.splice(0, pending.length - MAX_PENDING);
    }
  }

  worker.onmessage = ev => {
    const msg = ev.data;

    if (msg.type === 'reset') {
      // The board rebooted: its clock restarted, so the old traces no longer line up.
      clearAllPlots();
      restartNote = ` · device restarted ${fmtTime(Date.now())}`;
      setConn('warn', connectedText());
      return;
    }

    // Record first, so recordings never depend on display throttling.
    if (recorder.isRecording) {
      recorder.add(msg.items, msg.host_ms);
      updateRecorderUI();
    }

    for (const item of msg.items) {
      enqueue(item);
    }
  };

  // ── Widget: Attitude Indicator ────────────────────────────────────────────
  // Classic artificial horizon drawn on <canvas> from the latest accel sample.

  function getHorizonColors() {
    if (!horizonColors) {
      const light = document.body.classList.contains('light');
      horizonColors = {
        sky: light ? '#cfe3f7' : '#0e2a4b',
        ground: light ? '#e9d3b4' : '#2e1d0e',
        line: getCss('--accent'),
        ink: light ? 'rgba(15,23,42,.55)' : 'rgba(231,235,243,.55)',
        inkStrong: light ? 'rgba(15,23,42,.75)' : 'rgba(231,235,243,.8)',
        bezel: getCss('--hairline-strong'),
      };
    }
    return horizonColors;
  }

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

    const { x: ax = 0, y: ay = 0, z: az = 0 } = latestAccel ?? {};
    const { roll: rollDeg, pitch: pitchDeg } = tiltDeg(ax, ay, az);

    const hc = getHorizonColors();
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
    ctx.fillStyle = hc.sky;
    ctx.fillRect(-W * 2, -H * 2 - pitchPx, W * 4, H * 2);
    // Ground
    ctx.fillStyle = hc.ground;
    ctx.fillRect(-W * 2, -pitchPx, W * 4, H * 2);

    // Horizon line
    ctx.strokeStyle = hc.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-W * 2, -pitchPx);
    ctx.lineTo(W * 2, -pitchPx);
    ctx.stroke();

    // Pitch ladder — tick every 10°, label every 20°
    const labelSize = Math.round(R * 0.12);
    ctx.font = `${labelSize}px 'JetBrains Mono', ui-monospace, monospace`;
    ctx.textBaseline = 'middle';

    for (let p = -40; p <= 40; p += 10) {
      if (p === 0) continue;
      const py  = -pitchPx - (p / 90) * R;
      const len = (Math.abs(p) % 20 === 0) ? R * 0.32 : R * 0.18;
      ctx.strokeStyle = hc.ink;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-len, py);
      ctx.lineTo(len, py);
      ctx.stroke();
      if (Math.abs(p) % 20 === 0) {
        ctx.fillStyle = hc.inkStrong;
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
      ctx.strokeStyle = hc.ink;
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
    ctx.fillStyle = hc.line;
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
    ctx.strokeStyle = hc.bezel;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    // ── fixed aircraft symbol ───────────────────────────────────────────────
    const aw = R * 0.34, aIn = R * 0.12, aD = R * 0.08;
    ctx.strokeStyle = hc.line;
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

  const es = new EventSource(`/devices/${encodeURIComponent(deviceId)}/events`);

  es.onopen = () => {
    setConn('ok', connectedText());
  };

  es.onmessage = e => {
    worker.postMessage(e.data);
  };

  es.onerror = () => {
    reconnects += 1;
    if (reconnectsEl) reconnectsEl.textContent = String(reconnects);
    setConn('bad', 'Disconnected · retrying');
  };

  function frame(now) {
    if (!isSorting && now - lastFrameMs >= FRAME_MS) {
      lastFrameMs = now;

      if (pending.length) {
        // If rendering fell behind, skip only samples already older than the
        // visible window; everything inside the window is still drawn.
        const newest = pending[pending.length - 1].t_s;
        let stale = 0;
        while (stale < pending.length && pending[stale].t_s < newest - windowSec) stale++;
        if (stale) pending.splice(0, stale);

        const batch = pending.splice(0, 4000);
        let lastAccel = null;

        for (const item of batch) {
          if (item.sensor === 'accel') lastAccel = item;
          noteKpi(item);
          handleItem(item);
        }
        renderKpis(now);

        flush();

        if (now - lastResyncMs >= RESYNC_MS) {
          resyncPlots();
          lastResyncMs = now;
        }

        if (lastAccel) {
          latestAccel = lastAccel;
          updateValuePanel(lastAccel);
        }

        if (recorder.isRecording && batch.length) {
          updateRecorderUI();
        }

        setConn('ok', connectedText());
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
  document.addEventListener('pointerdown', e => {
    if (topMenuEl?.open && !topMenuEl.contains(e.target)) topMenuEl.open = false;
  });

  topMenuEl?.addEventListener('toggle', () => {
    document.body.classList.toggle('menuOpen', !!topMenuEl.open);
  });

  document.addEventListener('keydown', e => {
    // Escape always closes the menu, even while a control inside it has focus.
    if (e.key === 'Escape') {
      if (topMenuEl) topMenuEl.open = false;
      return;
    }
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
    }
  });
})();
