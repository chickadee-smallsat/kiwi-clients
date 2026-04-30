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
    const panelValues = document.getElementById('panel-values');
    const liveValuesToggle = document.getElementById('liveValuesToggle');

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
    let pending = [];
    let lastFrameMs = 0;
    let lastResyncMs = 0;

    const PANEL_STATE_KEY = `kiwi.dashboard.layout.${deviceKey}`;
    const LIVE_VALUES_KEY = `kiwi.dashboard.liveValues.${deviceKey}`;

    const GRID_COLS = () => {
        if (!dashboardGrid) return 12;
        const cols = getComputedStyle(dashboardGrid).gridTemplateColumns.split(' ').length;
        return Math.max(1, cols);
    };

    const GRID_ROW_PX = 8;

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
            panelValues.style.display = visible ? 'flex' : 'none';
        }

        localStorage.setItem(LIVE_VALUES_KEY, visible ? '1' : '0');
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

            Plotly.restyle(
                div,
                {
                    line: [
                        { color: colors[0] },
                        { color: colors[1] },
                        { color: colors[2] },
                        { color: colors[3] },
                    ],
                },
                [0, 1, 2, 3],
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
        dragmode: 'zoom',
        margin: { l: 52, r: 12, t: 16, b: 40 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        xaxis: {
            title: 'Time (s)',
            showgrid: true,
            zeroline: false,
            tickfont: { size: 13 },
            titlefont: { size: 14 },
        },
        yaxis: {
            title: '',
            showgrid: true,
            zeroline: false,
            tickfont: { size: 13 },
            titlefont: { size: 14 },
        },
        showlegend: true,
        legend: { orientation: 'h', font: { size: 13 } },
        font: { size: 14 },
    };

    const config = {
        displayModeBar: false,
        responsive: true,
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

        const wrap = div.closest('.plotWrap');
        if (!wrap) return;

        const summary = details ? details.querySelector('summary') : null;
        const panelRect = panel.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();

        if (panelRect.width < 40 || panelRect.height < 40) return;

        const wrapStyles = getComputedStyle(wrap);
        const padY = parseFloat(wrapStyles.paddingTop || 0) + parseFloat(wrapStyles.paddingBottom || 0);

        const summaryH = summary ? summary.getBoundingClientRect().height : 0;

        const width = Math.max(320, Math.floor(wrapRect.width));
        const height = Math.max(220, Math.floor(panelRect.height - summaryH - padY - 10));

        wrap.style.height = `${height + padY}px`;
        div.style.width = `${width}px`;
        div.style.height = `${height}px`;

        Plotly.relayout(div, {
            autosize: false,
            width,
            height,
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
            const details = panel.querySelector('details.plotDetails');
            state[panel.id] = {
                cols: Number(panel.dataset.cols || panel.dataset.defaultCols || 4),
                height: Number(panel.dataset.height || panel.dataset.defaultHeight || 320),
                collapsed: details ? !details.open : false,
            };
        });

        state.order = Array.from(dashboardGrid.children)
            .filter(el => el.classList.contains('dashboardPanel'))
            .map(el => el.id);

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
        const { gap } = getGridMetrics();
        const span = Math.max(1, Math.ceil((nextHeight + gap) / (GRID_ROW_PX + gap)));

        panel.dataset.cols = String(nextCols);
        panel.dataset.height = String(nextHeight);
        panel.style.setProperty('--col-span', String(nextCols));
        panel.style.setProperty('--panel-height', `${nextHeight}px`);
        panel.style.setProperty('--row-span', String(span));
    }

    function applyCollapsedPanelSize(panel) {
        const details = panel.querySelector('details.plotDetails, details.miniDetails');
        const summary = details ? details.querySelector('summary') : null;
        const summaryHeight = summary ? summary.getBoundingClientRect().height : 42;
        const targetHeight = Math.max(42, Math.ceil(summaryHeight + 6));
        const { gap } = getGridMetrics();
        const span = Math.max(1, Math.ceil((targetHeight + gap) / (GRID_ROW_PX + gap)));

        panel.style.setProperty('--panel-height', 'auto');
        panel.style.setProperty('--row-span', String(span));
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
        if (panel.querySelector('.panelChrome')) return;

        const chrome = document.createElement('div');
        chrome.className = 'panelChrome';
        chrome.textContent = '⋮⋮';

        const content = document.createElement('div');
        content.className = 'panelContent';

        while (panel.firstChild) {
            content.appendChild(panel.firstChild);
        }

        panel.appendChild(chrome);
        panel.appendChild(content);

        const resizeE = document.createElement('div');
        resizeE.className = 'panelResize panelResizeE';
        resizeE.dataset.dir = 'e';

        const resizeS = document.createElement('div');
        resizeS.className = 'panelResize panelResizeS';
        resizeS.dataset.dir = 's';

        const resizeSE = document.createElement('div');
        resizeSE.className = 'panelResize panelResizeSE';
        resizeSE.dataset.dir = 'se';

        panel.appendChild(resizeE);
        panel.appendChild(resizeS);
        panel.appendChild(resizeSE);
    }

    function initPanelLayout() {
        if (!dashboardGrid || !dashboardPanels.length) return;

        dashboardPanels.forEach(buildPanelChrome);

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

            if (savedPanel.collapsed) {
                const details = panel.querySelector('details.plotDetails');
                if (details) {
                    details.open = false;
                    panel.classList.add('collapsed');
                    applyCollapsedPanelSize(panel);
                }
            }
        });

        let dragState = null;
        let resizeState = null;
        let placeholder = null;

        function clearDragStyles(panel) {
            panel.classList.remove('dragging');
            panel.style.position = '';
            panel.style.left = '';
            panel.style.top = '';
            panel.style.width = '';
            panel.style.height = '';
            panel.style.pointerEvents = '';
            panel.style.zIndex = '';
        }

        function startDragAtPointer(panel, clientX, clientY) {
            const rect = panel.getBoundingClientRect();

            dragState = {
                panel,
                offsetX: clientX - rect.left,
                offsetY: clientY - rect.top,
            };

            placeholder = document.createElement('div');
            placeholder.className = 'dashboardPlaceholder';
            placeholder.style.setProperty('--col-span', panel.dataset.cols || panel.dataset.defaultCols || '4');
            placeholder.style.setProperty('--panel-height', `${rect.height}px`);
            const { gap } = getGridMetrics();
            const span = Math.max(1, Math.ceil((rect.height + gap) / (GRID_ROW_PX + gap)));
            placeholder.style.setProperty('--row-span', String(span));

            panel.after(placeholder);

            panel.classList.add('dragging');
            panel.style.position = 'fixed';
            panel.style.left = `${rect.left}px`;
            panel.style.top = `${rect.top}px`;
            panel.style.width = `${rect.width}px`;
            panel.style.height = `${rect.height}px`;
            panel.style.pointerEvents = 'none';
            panel.style.zIndex = '1000';

            window.addEventListener('pointermove', onDragMove);
            window.addEventListener('pointerup', endDrag, { once: true });
        }

        function startDrag(e, panel) {
            if (e.button !== 0) return;
            if (resizeState) return;

            startDragAtPointer(panel, e.clientX, e.clientY);
            e.preventDefault();
        }

        function onDragMove(e) {
            if (!dragState) return;

            const { panel, offsetX, offsetY } = dragState;

            panel.style.left = `${e.clientX - offsetX}px`;
            panel.style.top = `${e.clientY - offsetY}px`;

            const hovered = document.elementFromPoint(e.clientX, e.clientY)?.closest('.dashboardPanel');

            if (hovered && hovered !== panel) {
                const rect = hovered.getBoundingClientRect();
                const before = e.clientY < rect.top + rect.height / 2 || e.clientX < rect.left + rect.width / 2;

                if (before) hovered.before(placeholder);
                else hovered.after(placeholder);
            } else if (!hovered && dashboardGrid.getBoundingClientRect().bottom < e.clientY) {
                dashboardGrid.appendChild(placeholder);
            }
        }

        function endDrag() {
            if (!dragState) return;

            const { panel } = dragState;

            if (placeholder && placeholder.parentNode) {
                placeholder.replaceWith(panel);
            }

            clearDragStyles(panel);

            placeholder = null;
            dragState = null;

            savePanelState();
            schedulePlotResize();

            window.removeEventListener('pointermove', onDragMove);
        }

        function startResize(e, panel, dir) {
            if (e.button !== 0) return;

            const rect = panel.getBoundingClientRect();

            resizeState = {
                panel,
                dir,
                startX: e.clientX,
                startY: e.clientY,
                startCols: Number(panel.dataset.cols || panel.dataset.defaultCols || 4),
                startHeight: rect.height,
            };

            window.addEventListener('pointermove', onResizeMove);
            window.addEventListener('pointerup', endResize, { once: true });

            e.preventDefault();
            e.stopPropagation();
        }

        function onResizeMove(e) {
            if (!resizeState) return;

            const { panel, dir, startX, startY, startCols, startHeight } = resizeState;
            const { colWidth, gap } = getGridMetrics();

            let nextCols = startCols;
            let nextHeight = startHeight;

            if (dir === 'e' || dir === 'se') {
                const dx = e.clientX - startX;
                nextCols = Math.round((startCols * colWidth + (startCols - 1) * gap + dx + gap) / (colWidth + gap));
            }

            if (dir === 's' || dir === 'se') {
                const dy = e.clientY - startY;
                nextHeight = startHeight + dy;
            }

            applyPanelSize(panel, nextCols, nextHeight);
            schedulePlotResize();
        }

        function endResize() {
            if (!resizeState) return;

            savePanelState();
            schedulePlotResize();

            resizeState = null;

            window.removeEventListener('pointermove', onResizeMove);
        }

        function canStartPanelDrag(e) {
            const target = e.target;
            if (!(target instanceof Element)) return false;

            if (target.closest('.panelResize')) return false;
            if (target.closest('button, input, select, textarea, a, label')) return false;
            if (target.closest('iframe, #imu3dWrap')) return false;

            // Keep Plotly interactions (zoom/pan/hover) intact.
            if (target.closest('.js-plotly-plot, .plotly, .plot-container, .modebar, .nsewdrag')) return false;

            return true;
        }

        function maybeStartSummaryDrag(e, panel) {
            if (e.button !== 0) return;
            if (resizeState) return;

            const pointerId = e.pointerId;
            const startX = e.clientX;
            const startY = e.clientY;
            const threshold = 6;
            let dragging = false;

            function cleanup() {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
            }

            function onMove(moveEvent) {
                if (moveEvent.pointerId !== pointerId || dragging) return;

                const dx = Math.abs(moveEvent.clientX - startX);
                const dy = Math.abs(moveEvent.clientY - startY);

                if (dx + dy < threshold) return;

                dragging = true;
                cleanup();
                startDragAtPointer(panel, moveEvent.clientX, moveEvent.clientY);
                moveEvent.preventDefault();
            }

            function onUp(upEvent) {
                if (upEvent.pointerId !== pointerId) return;
                cleanup();
            }

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        }

        dashboardPanels.forEach(panel => {
            panel.addEventListener('pointerdown', e => {
                const target = e.target;
                if (target instanceof Element && target.closest('summary')) {
                    maybeStartSummaryDrag(e, panel);
                    return;
                }

                if (!canStartPanelDrag(e)) return;
                startDrag(e, panel);
            });

            panel.querySelectorAll('.panelResize').forEach(handle => {
                handle.addEventListener('pointerdown', e => startResize(e, panel, handle.dataset.dir));
            });
        });

        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver(entries => {
                for (const entry of entries) {
                    const plotDivs = entry.target.querySelectorAll('.plotWrap > div');
                    plotDivs.forEach(div => resizePlot(div));
                }
            });

            dashboardPanels.forEach(panel => observer.observe(panel));
        }

        window.addEventListener('resize', () => {
            dashboardPanels.forEach(panel => {
                if (panel.classList.contains('collapsed')) {
                    applyCollapsedPanelSize(panel);
                } else {
                    applyPanelSize(
                        panel,
                        Number(panel.dataset.cols || panel.dataset.defaultCols || 4),
                        Number(panel.dataset.height || panel.dataset.defaultHeight || 320),
                    );
                }
            });

            schedulePlotResize();
            savePanelState();
        });

        plotDetailsEls.forEach(details => {
            details.addEventListener('toggle', () => {
                const panel = details.closest('.dashboardPanel');
                if (panel) {
                    const isOpen = details.open;
                    panel.classList.toggle('collapsed', !isOpen);
                    if (isOpen) {
                        const h = Number(panel.dataset.height || panel.dataset.defaultHeight || 320);
                        applyPanelSize(
                            panel,
                            Number(panel.dataset.cols || panel.dataset.defaultCols || 4),
                            h,
                        );
                    } else {
                        applyCollapsedPanelSize(panel);
                    }
                    savePanelState();
                }
                schedulePlotResize();
            });
        });

        const panel3dDetails = document.getElementById('panel3dDetails');
        if (panel3dDetails) {
            panel3dDetails.addEventListener('toggle', () => {
                const panel = panel3dDetails.closest('.dashboardPanel');
                const isOpen = panel3dDetails.open;
                if (panel) {
                    panel.classList.toggle('collapsed', !isOpen);
                    if (isOpen) {
                        const h = Number(panel.dataset.height || panel.dataset.defaultHeight || 430);
                        applyPanelSize(
                            panel,
                            Number(panel.dataset.cols || panel.dataset.defaultCols || 5),
                            h,
                        );
                        sync3DFrame();
                    } else {
                        applyCollapsedPanelSize(panel);
                        if (imu3dFrame) imu3dFrame.setAttribute('src', '');
                    }
                    savePanelState();
                }
            });

            const saved3d = (loadPanelState())['panel-3d'] || {};
            if (saved3d.collapsed) {
                panel3dDetails.open = false;
                const panel = panel3dDetails.closest('.dashboardPanel');
                if (panel) {
                    panel.classList.add('collapsed');
                    applyCollapsedPanelSize(panel);
                }
                if (imu3dFrame) imu3dFrame.setAttribute('src', '');
            }
        }

        if (dialStats) dialStats.addEventListener('toggle', schedulePlotResize);

        schedulePlotResize();
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

    const savedLiveValues = localStorage.getItem(LIVE_VALUES_KEY);
    if (liveValuesToggle) liveValuesToggle.checked = savedLiveValues === '1';

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

    function sync3DFrame() {
        if (!imu3dFrame) return;

        const src = deviceId || 'all';
        const next = `/3d/?src=${encodeURIComponent(src)}&embed=1`;

        if (imu3dFrame.getAttribute('src') !== next) {
            imu3dFrame.setAttribute('src', next);
        }
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
        if (accelDiv && draw.accel.ts.length) {
            const latest = draw.accel.ts[draw.accel.ts.length - 1];

            Plotly.extendTraces(
                accelDiv,
                {
                    x: [draw.accel.ts, draw.accel.ts, draw.accel.ts, draw.accel.ts],
                    y: [draw.accel.x, draw.accel.y, draw.accel.z, draw.accel.mag],
                },
                [0, 1, 2, 3],
            );

            Plotly.relayout(accelDiv, { 'xaxis.range': [latest - windowSec, latest] });
            clearAccelDraw();
        }

        if (gyroDiv && draw.gyro.ts.length) {
            const latest = draw.gyro.ts[draw.gyro.ts.length - 1];

            Plotly.extendTraces(
                gyroDiv,
                {
                    x: [draw.gyro.ts, draw.gyro.ts, draw.gyro.ts, draw.gyro.ts],
                    y: [draw.gyro.x, draw.gyro.y, draw.gyro.z, draw.gyro.mag],
                },
                [0, 1, 2, 3],
            );

            Plotly.relayout(gyroDiv, { 'xaxis.range': [latest - windowSec, latest] });
            clearGyroDraw();
        }

        if (magDiv && draw.mag.ts.length) {
            const latest = draw.mag.ts[draw.mag.ts.length - 1];

            Plotly.extendTraces(
                magDiv,
                {
                    x: [draw.mag.ts, draw.mag.ts, draw.mag.ts, draw.mag.ts],
                    y: [draw.mag.x, draw.mag.y, draw.mag.z, draw.mag.mag],
                },
                [0, 1, 2, 3],
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

        schedulePlotResize();
    }

    applySettings();
    updateRecorderUI();
    initThemeAndPalette();
    // Only load the 3D iframe if the panel is already open (e.g. restored from saved state).
    // Loading it unconditionally exhausts the browser's HTTP/1.1 per-origin connection limit
    // (6 connections) when multiple device dashboards are open simultaneously, which blocks
    // the dashboard's own SSE connection and prevents data from flowing.
    if (document.getElementById('panel3dDetails')?.open) sync3DFrame();
    initPanelLayout();

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
                ts_ms: r.ts_ms,
                x: r.x,
                y: r.y,
                z: r.z,
            }));

            const ws = XLSX.utils.json_to_sheet(shaped);
            XLSX.utils.book_append_sheet(wb, ws, s.toUpperCase());
        }

        const baroRows = recorder.rows.filter(r => r.sensor === 'temp' || r.sensor === 'pressure' || r.sensor === 'altitude');
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
        const src = deviceId || 'all';
        const url = `/3d/?src=${encodeURIComponent(src)}`;
        window.location.href = url;
    });

    setConn('warn', 'connecting…');

    if (reconnectsEl) reconnectsEl.textContent = '0';
    if (lastSeenEl) lastSeenEl.textContent = '-';
    if (bufMaxEl) bufMaxEl.textContent = String(maxPoints);
    if (bufCountEl) bufCountEl.textContent = '0';

    const worker = new Worker('/plot.worker.js');

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

    // A single SharedWorker holds one SSE connection for the whole origin.
    // All dashboards and 3D iframes share it; each filters by device ID on the client side.
    const sw = new SharedWorker('/sse.shared.worker.js');
    const swPort = sw.port;
    swPort.start();

    swPort.onmessage = (ev) => {
        const msg = ev.data;
        if (msg.type === 'open') {
            setConn('ok', `connected (${deviceKey})`);
        } else if (msg.type === 'error') {
            reconnects += 1;
            if (reconnectsEl) reconnectsEl.textContent = String(reconnects);
            setConn('bad', 'disconnected (auto-retrying…)');
        } else if (msg.type === 'data') {
            // deviceId is null for the "all" view, otherwise the exact device address string.
            if (deviceId !== null && msg.device !== deviceId) return;
            // msg.payload is already a parsed array — pass directly to avoid re-serializing.
            worker.postMessage(msg.payload);
        }
    };

    window.addEventListener('pagehide', () => { swPort.postMessage('disconnect'); });

    function frame(now) {
        if (now - lastFrameMs >= FRAME_MS) {
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

        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
})();