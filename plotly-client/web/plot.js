(() => {
  const connPill = document.getElementById("connPill");
  const connDot = document.getElementById("connDot");
  const connText = document.getElementById("connText");
  const reconnectsEl = document.getElementById("reconnects");
  const lastSeenEl = document.getElementById("lastSeen");
  const bufCountEl = document.getElementById("bufCount");
  const bufMaxEl = document.getElementById("bufMax");

  const pauseBtn = document.getElementById("pauseBtn");
  const windowInput = document.getElementById("windowSec");
  const rateInput = document.getElementById("rateHz");
  const streamSelect = document.getElementById("streamSelect");

  const recordBtn = document.getElementById("recordBtn");
  const stopBtn = document.getElementById("stopBtn");
  const exportBtn = document.getElementById("exportBtn");
  const recCountEl = document.getElementById("recCount");

  const tEl = document.getElementById("t");
  const xEl = document.getElementById("x");
  const yEl = document.getElementById("y");
  const zEl = document.getElementById("z");
  const magEl = document.getElementById("mag");
  const thetaEl = document.getElementById("theta");
  const phiEl = document.getElementById("phi");

  const accelDiv = document.getElementById("accelPlot");
  const gyroDiv = document.getElementById("gyroPlot");
  const magDiv = document.getElementById("magPlot");
  const tempDiv = document.getElementById("tempPlot");
  const pressureDiv = document.getElementById("pressurePlot");
  const dialDiv = document.getElementById("dial");

  let paused = false;
  let reconnects = 0;
  let lastSeenMs = null;

  let windowSec = toInt(windowInput.value, 2);
  let rateHz = toInt(rateInput.value, 60);
  let maxPoints = Math.max(1, Math.round(windowSec * rateHz));
  let bufferedPoints = 0;

  const recorder = {
    isRecording: false,
    rows: [],
  };

  let latestVectorSample = null;
  let uiStream = streamSelect ? streamSelect.value : "all";

  const FRAME_MS = 50;
  let pending = [];

  function toInt(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : fallback;
  }

  function setConn(state, text) {
    connText.textContent = text;
    const ok = getCss("--ok");
    const warn = getCss("--warn");
    const bad = getCss("--bad");

    if (state === "ok") {
      connDot.style.background = ok;
      connPill.style.borderColor = ok;
      connText.style.color = "#bfffe2";
      return;
    }
    if (state === "warn") {
      connDot.style.background = warn;
      connPill.style.borderColor = warn;
      connText.style.color = "#ffe6a8";
      return;
    }
    connDot.style.background = bad;
    connPill.style.borderColor = bad;
    connText.style.color = "#ffb8c0";
  }

  function getCss(varName) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(varName)
      .trim();
  }

  function fmtTime(ms) {
    if (!ms) return "-";
    return new Date(ms).toLocaleTimeString();
  }

  function normalizeTimestampToMs(t) {
    const n = Number(t);
    if (!Number.isFinite(n)) return Date.now();
    if (n > 1e18) return Math.round(n / 1e6);
    if (n > 1e15) return Math.round(n / 1e3);
    if (n > 1e12) return Math.round(n);
    return Math.round(n * 1000);
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

  function safeNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function isVectorSensor(s) {
    return s === "accel" || s === "gyro" || s === "mag";
  }

  function normalizeItem(raw) {
    const type = (raw.sensor ?? "").toString().toLowerCase();
    const ts_ms = normalizeTimestampToMs(raw.ts);

    if (isVectorSensor(type)) {
      const x = safeNum(raw.x);
      const y = safeNum(raw.y);
      const z = safeNum(raw.z);
      if (x === null || y === null || z === null) return null;

      const mag = magnitude(x, y, z);
      const ang = anglesDeg(x, y, z);

      return {
        sensor: type,
        ts_ms,
        x,
        y,
        z,
        mag,
        theta_deg: ang.theta_deg,
        phi_deg: ang.phi_deg,
        value: null,
      };
    }

    if (type === "pressure") {
      const value = safeNum(raw.value);
      if (value === null) return null;
      return {
        sensor: "pressure",
        ts_ms,
        x: null,
        y: null,
        z: null,
        mag: null,
        theta_deg: null,
        phi_deg: null,
        value,
      };
    }

    return null;
  }

  function unpackSerde(raw) {
    if (!raw || !raw.measurement || typeof raw.timestamp !== "number") return null;

    const keys = Object.keys(raw.measurement);
    if (keys.length !== 1) return null;

    const variant = keys[0];
    const values = raw.measurement[variant];
    const sensor = variant.toLowerCase();

    if (
      (sensor === "accel" || sensor === "gyro" || sensor === "mag") &&
      Array.isArray(values) &&
      values.length === 3
    ) {
      return {
        sensor,
        x: values[0],
        y: values[1],
        z: values[2],
        ts: raw.timestamp,
      };
    }

    if (sensor === "baro" && Array.isArray(values) && values.length === 3) {
      return {
        sensor: "pressure",
        value: values[1],
        ts: raw.timestamp,
      };
    }
    console.log("Unknown sensor type:", type);
    return null;
  }

  function applySettings() {
    windowSec = Math.max(1, Math.min(10, toInt(windowInput.value, 2)));
    rateHz = Math.max(1, Math.min(240, toInt(rateInput.value, 60)));
    windowInput.value = String(windowSec);
    rateInput.value = String(rateHz);
    maxPoints = Math.max(1, Math.round(windowSec * rateHz));
    bufMaxEl.textContent = String(maxPoints);
  }

  function updateLastSeen() {
    lastSeenMs = Date.now();
    lastSeenEl.textContent = fmtTime(lastSeenMs);
  }

  setInterval(() => {
    if (!lastSeenMs) return;
    const age = Date.now() - lastSeenMs;
    if (age > 2000) setConn("warn", "connected (stale…)");
  }, 500);

  const baseLayout = {
    margin: { l: 40, r: 10, t: 10, b: 30 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: { title: "", showgrid: true, zeroline: false },
    yaxis: { title: "", showgrid: true, zeroline: false },
    showlegend: true,
    legend: { orientation: "h" },
  };

  const config = { displayModeBar: false, responsive: true };

  function initVectorPlot(div, title) {
    const traces = [
      { name: "x", mode: "lines", x: [], y: [] },
      { name: "y", mode: "lines", x: [], y: [] },
      { name: "z", mode: "lines", x: [], y: [] },
      { name: "mag", mode: "lines", x: [], y: [] },
    ];
    const layout = structuredClone(baseLayout);
    layout.yaxis.title = title;
    Plotly.newPlot(div, traces, layout, config);
  }

  function initScalarPlot(div, title) {
    const traces = [{ name: "value", mode: "lines", x: [], y: [] }];
    const layout = structuredClone(baseLayout);
    layout.yaxis.title = title;
    Plotly.newPlot(div, traces, layout, config);
  }

  function initDial() {
    const traces = [{ name: "dir", mode: "lines+markers", x: [0, 1], y: [0, 0] }];
    const layout = {
      margin: { l: 20, r: 20, t: 10, b: 20 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      xaxis: { range: [-1.2, 1.2], showgrid: true, zeroline: true, scaleanchor: "y" },
      yaxis: { range: [-1.2, 1.2], showgrid: true, zeroline: true },
      showlegend: false,
    };
    Plotly.newPlot(dialDiv, traces, layout, config);
  }

  function extendVector(div, ts, x, y, z, mag) {
    Plotly.extendTraces(
      div,
      { x: [[ts], [ts], [ts], [ts]], y: [[x], [y], [z], [mag]] },
      [0, 1, 2, 3],
      maxPoints
    );
  }

  function extendScalar(div, ts, v) {
    Plotly.extendTraces(div, { x: [[ts]], y: [[v]] }, [0], maxPoints);
  }

  function renderDial(phi_deg) {
    const a = (phi_deg - 90) * (Math.PI / 180);
    const x = Math.cos(a);
    const y = Math.sin(a);
    Plotly.restyle(dialDiv, { x: [[0, x]], y: [[0, y]] }, [0]);
  }

  initVectorPlot(accelDiv, "accel");
  initVectorPlot(gyroDiv, "gyro");
  initVectorPlot(magDiv, "mag");
  initScalarPlot(pressureDiv, "pressure");
  initDial();

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
      mag: item.mag,
      theta_deg: item.theta_deg,
      phi_deg: item.phi_deg,
      value: item.value,
    });
  }

  function shouldDraw(sensor) {
    return uiStream === "all" || uiStream === sensor;
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
    bufferedPoints += 1;
    bufCountEl.textContent = String(Math.min(bufferedPoints, maxPoints));

    if (recorder.isRecording) {
      recordRow(item);
      updateRecorderUI();
    }

    if (isVectorSensor(item.sensor)) {
      latestVectorSample = item;
      updateValuePanel(item);
      renderDial(item.phi_deg);
    }

    if (paused) return;
    const ts = item.ts_ms;

    if (item.sensor === "accel" && shouldDraw("accel")) {
      extendVector(accelDiv, ts, item.x, item.y, item.z, item.mag);
    } else if (item.sensor === "gyro" && shouldDraw("gyro")) {
      extendVector(gyroDiv, ts, item.x, item.y, item.z, item.mag);
    } else if (item.sensor === "mag" && shouldDraw("mag")) {
      extendVector(magDiv, ts, item.x, item.y, item.z, item.mag);
    } else if (item.sensor === "pressure" && shouldDraw("pressure")) {
      extendScalar(pressureDiv, ts, item.value);
    }
  }

  setInterval(() => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    for (const item of batch) handleItem(item);
    setConn("ok", "connected");
    updateLastSeen();
  }, FRAME_MS);

  applySettings();
  updateRecorderUI();

  windowInput.addEventListener("change", () => {
    applySettings();
    setConn("ok", "connected");
  });

  rateInput.addEventListener("change", () => {
    applySettings();
    setConn("ok", "connected");
  });

  if (streamSelect) {
    streamSelect.addEventListener("change", () => {
      uiStream = streamSelect.value;
    });
  }

  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
  });

  recordBtn.addEventListener("click", () => {
    recorder.isRecording = true;
    recorder.rows.length = 0;
    updateRecorderUI();
  });

  stopBtn.addEventListener("click", () => {
    recorder.isRecording = false;
    updateRecorderUI();
  });

  setConn("warn", "connecting…");
  reconnectsEl.textContent = "0";
  lastSeenEl.textContent = "-";
  bufMaxEl.textContent = String(maxPoints);
  bufCountEl.textContent = "0";

  const es = new EventSource("/events");

  es.onopen = () => {
    console.log("SSE connected");
    setConn("ok", "connected");
  };

  es.onmessage = (e) => {
    let parsed;
    try {
      /*
        data: [{"measurement":{"Gyro":[-0.24088828,-0.066879265,0.0]},"timestamp":232715507},{"measurement":{"Mag":[-526.0639,-255.0,-79.647964]},"timestamp":232715507},{"measurement":{"Baro":[24.819702,1000.097,1165.5216]},"timestamp":232715507},{"measurement":{"Accel":[-0.5336549,0.5843661,-0.11799745]},"timestamp":232735571},{"measurement":{"Gyro":[-0.23912565,-0.07293094,0.0]},"timestamp":232735571},{"measurement":{"Mag":[-513.9635,-276.37805,-87.01168]},"timestamp":232735571},{"measurement":{"Baro":[24.802967,1000.19226,1167.2623]},"timestamp":232735571},{"measurement":{"Accel":[-0.56830263,0.5485306,-0.12796712]},"timestamp":232755634},{"measurement":{"Gyro":[-0.23721115,-0.07893584,0.0]},"timestamp":232755634},{"measurement":{"Mag":[-500.91873,-297.1419,-94.36114]},"timestamp":232755634},{"measurement":{"Baro":[24.78625,1000.28796,1169.0231]},"timestamp":232755634},{"measurement":{"Accel":[-0.6004555,0.51058745,-0.13791412]},"timestamp":232775690},{"measurement":{"Gyro":[-0.23514658,-0.08488868,0.0]},"timestamp":232775690},{"measurement":{"Mag":[-486.9657,-317.24207,-101.69336]},"timestamp":232775690},{"measurement":{"Baro":[24.76955,1000.3842,1170.8031]},"timestamp":232775690},{"measurement":{"Accel":[-0.63000137,0.47068822,-0.1478436]},"timestamp":232795754},{"measurement":{"Gyro":[-0.23293184,-0.09078966,0.0]},"timestamp":232795754},{"measurement":{"Mag":[-472.12976,-336.6489,-109.01207]},"timestamp":232795754},{"measurement":{"Baro":[24.752863,1000.48096,1172.6035]},"timestamp":232795754},{"measurement":{"Accel":[-0.65681255,0.4290238,-0.15775234]},"timestamp":232815821}]
      */
      parsed = JSON.parse(e.data);
    } catch {
      console.log("Failed to parse SSE data:", e.data);
      return;
    }

    const items = Array.isArray(parsed) ? parsed : [parsed];

    for (const raw of items) {
      const unpacked = unpackSerde(raw);
      if (!unpacked) continue;
      const item = normalizeItem(unpacked);
      if (!item) continue;
      pending.push(item);
    }
  };

  es.onerror = () => {
    reconnects += 1;
    reconnectsEl.textContent = String(reconnects);
    setConn("bad", "disconnected (auto-retrying…)");
  };
})();