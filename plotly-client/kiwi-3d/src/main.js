import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import AHRS from "ahrs";

const params = new URLSearchParams(location.search);
const deviceKey = params.get("src") || "all";
const demo = params.get("demo") === "1";
const isEmbed = params.get("embed") === "1";

// Use the shared SSE worker so this iframe does not open its own connection.
const sw = new SharedWorker('/sse.shared.worker.js');
const swPort = sw.port;
swPort.start();
window.addEventListener('pagehide', () => { swPort.postMessage('disconnect'); });

const scene = new THREE.Scene();

const gravityArrow = new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 0), 0.8, 0xff4444);
scene.add(gravityArrow);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 100);
camera.position.set(0.6, 0.4, 1.0);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
document.body.appendChild(renderer.domElement);

let hud = null;
let resetBtn = null;
let freezeBtn = null;
let betaWrap = null;
let betaVal = null;
let betaSlider = null;

if (!isEmbed) {
  hud = document.createElement("div");
  hud.style.position = "fixed";
  hud.style.left = "12px";
  hud.style.top = "12px";
  hud.style.padding = "10px 12px";
  hud.style.borderRadius = "10px";
  hud.style.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
  hud.style.background = "rgba(0,0,0,0.55)";
  hud.style.color = "#fff";
  hud.style.zIndex = "9999";
  hud.style.whiteSpace = "pre";
  hud.textContent = "starting…";
  document.body.appendChild(hud);

  resetBtn = document.createElement("button");
  resetBtn.textContent = "Reset";
  resetBtn.style.position = "fixed";
  resetBtn.style.left = "12px";
  resetBtn.style.top = "92px";
  resetBtn.style.padding = "8px 10px";
  resetBtn.style.borderRadius = "10px";
  resetBtn.style.border = "1px solid rgba(255,255,255,0.25)";
  resetBtn.style.background = "rgba(0,0,0,0.55)";
  resetBtn.style.color = "#fff";
  resetBtn.style.cursor = "pointer";
  resetBtn.style.zIndex = "9999";
  document.body.appendChild(resetBtn);

  freezeBtn = document.createElement("button");
  freezeBtn.textContent = "Freeze";
  freezeBtn.style.position = "fixed";
  freezeBtn.style.left = "82px";
  freezeBtn.style.top = "92px";
  freezeBtn.style.padding = "8px 10px";
  freezeBtn.style.borderRadius = "10px";
  freezeBtn.style.border = "1px solid rgba(255,255,255,0.25)";
  freezeBtn.style.background = "rgba(0,0,0,0.55)";
  freezeBtn.style.color = "#fff";
  freezeBtn.style.cursor = "pointer";
  freezeBtn.style.zIndex = "9999";
  document.body.appendChild(freezeBtn);

  betaWrap = document.createElement("div");
  betaWrap.style.position = "fixed";
  betaWrap.style.left = "12px";
  betaWrap.style.top = "132px";
  betaWrap.style.padding = "10px 12px";
  betaWrap.style.borderRadius = "10px";
  betaWrap.style.border = "1px solid rgba(255,255,255,0.15)";
  betaWrap.style.background = "rgba(0,0,0,0.55)";
  betaWrap.style.color = "#fff";
  betaWrap.style.zIndex = "9999";
  betaWrap.style.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
  betaWrap.style.display = "flex";
  betaWrap.style.gap = "10px";
  betaWrap.style.alignItems = "center";
  document.body.appendChild(betaWrap);

  const betaLabel = document.createElement("span");
  betaLabel.textContent = "beta";
  betaWrap.appendChild(betaLabel);

  betaVal = document.createElement("span");
  betaVal.textContent = "0.08";
  betaWrap.appendChild(betaVal);

  betaSlider = document.createElement("input");
  betaSlider.type = "range";
  betaSlider.min = "0.02";
  betaSlider.max = "0.25";
  betaSlider.step = "0.01";
  betaSlider.value = "0.08";
  betaSlider.style.width = "140px";
  betaWrap.appendChild(betaSlider);
}

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableRotate = false;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0.12, 0);
controls.update();

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const dir = new THREE.DirectionalLight(0xffffff, 1.2);
dir.position.set(1, 2, 1);
scene.add(dir);

let model = null;
const loader = new GLTFLoader();
loader.load("kiwi.glb", (gltf) => {
  model = gltf.scene;
  model.scale.setScalar(3);
  scene.add(model);
});

let lastAccel = null;
let lastGyro = null;
let lastMag = null;

let lastTemp = null;
let lastPressure = null;
let lastAltitude = null;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

let betaUi = 0.08;
const ahrs = new AHRS({ algorithm: "Madgwick", sampleInterval: 5, beta: betaUi });

let qOffset = new THREE.Quaternion();
let qTarget = new THREE.Quaternion();
let qDisplay = new THREE.Quaternion();
const qModelAlign = new THREE.Quaternion();

let frozen = false;

let baroUI = null;
let gTemp = null,
  gPress = null,
  gAlt = null;
let lastGaugeUpdateMs = 0;

function remapAccel(x, y, z) {
  return [x, z, -y];
}

function remapGyro(x, y, z) {
  return [x, z, -y];
}

function remapMag(x, y, z) {
  return [x, z, -y];
}

if (resetBtn) {
  resetBtn.addEventListener("click", () => {
    if (!model) return;
    qOffset.copy(model.quaternion).invert();
  });
}

if (freezeBtn) {
  freezeBtn.addEventListener("click", () => {
    frozen = !frozen;
    freezeBtn.textContent = frozen ? "Resume" : "Freeze";
  });
}

if (betaSlider) {
  betaSlider.addEventListener("input", () => {
    const v = Number(betaSlider.value);
    if (Number.isFinite(v)) {
      betaUi = v;
      ahrs.beta = betaUi;
      if (betaVal) betaVal.textContent = betaUi.toFixed(2);
    }
  });
}

function makeGauge(title, unit, min, max) {
  const wrap = document.createElement("div");
  wrap.style.width = "60px";
  wrap.style.height = "240px";
  wrap.style.borderRadius = "14px";
  wrap.style.border = "1px solid rgba(255,255,255,0.14)";
  wrap.style.background = "rgba(0,0,0,0.28)";
  wrap.style.backdropFilter = "blur(10px)";
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.padding = "10px 8px";
  wrap.style.boxSizing = "border-box";
  wrap.style.gap = "8px";
  wrap.style.boxShadow = "0 10px 24px rgba(0,0,0,0.25)";

  const head = document.createElement("div");
  head.style.display = "flex";
  head.style.flexDirection = "column";
  head.style.gap = "2px";

  const t = document.createElement("div");
  t.textContent = title;
  t.style.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  t.style.color = "rgba(255,255,255,0.92)";
  head.appendChild(t);

  const v = document.createElement("div");
  v.textContent = "—";
  v.style.font = "13px ui-monospace, SFMono-Regular, Menlo, monospace";
  v.style.color = "rgba(255,255,255,0.98)";
  head.appendChild(v);

  const u = document.createElement("div");
  u.textContent = unit;
  u.style.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  u.style.color = "rgba(255,255,255,0.55)";
  head.appendChild(u);

  wrap.appendChild(head);

  const track = document.createElement("div");
  track.style.position = "relative";
  track.style.flex = "1";
  track.style.borderRadius = "12px";
  track.style.border = "1px solid rgba(255,255,255,0.10)";
  track.style.background = "rgba(255,255,255,0.05)";
  track.style.overflow = "hidden";
  wrap.appendChild(track);

  const ticks = document.createElement("div");
  ticks.style.position = "absolute";
  ticks.style.inset = "0";
  ticks.style.backgroundImage =
    "repeating-linear-gradient(to top, rgba(255,255,255,0.16) 0px, rgba(255,255,255,0.16) 1px, transparent 1px, transparent 18px)";
  ticks.style.opacity = "0.55";
  track.appendChild(ticks);

  const fill = document.createElement("div");
  fill.style.position = "absolute";
  fill.style.left = "0";
  fill.style.right = "0";
  fill.style.bottom = "0";
  fill.style.height = "50%";
  fill.style.background = "linear-gradient(to top, rgba(120,200,255,0.22), rgba(120,200,255,0.03))";
  track.appendChild(fill);

  const marker = document.createElement("div");
  marker.style.position = "absolute";
  marker.style.left = "0";
  marker.style.right = "0";
  marker.style.height = "2px";
  marker.style.background = "rgba(255,90,90,0.95)";
  marker.style.boxShadow = "0 0 10px rgba(255,90,90,0.42)";
  marker.style.top = "50%";
  track.appendChild(marker);

  function setValue(val) {
    if (!Number.isFinite(val)) {
      v.textContent = "—";
      marker.style.top = "50%";
      fill.style.height = "50%";
      return;
    }
    v.textContent = `${val.toFixed(2)}`;
    const t = (val - min) / (max - min);
    const cl = t < 0 ? 0 : t > 1 ? 1 : t;
    marker.style.top = `${(1 - cl) * 100}%`;
    fill.style.height = `${cl * 100}%`;
  }

  return { el: wrap, setValue };
}

function ensureBaroUI() {
  if (baroUI) return;

  const safe = "12px";

  baroUI = document.createElement("div");
  baroUI.style.position = "fixed";
  baroUI.style.inset = "0";
  baroUI.style.zIndex = "9998";
  baroUI.style.pointerEvents = "none";
  document.body.appendChild(baroUI);

  const leftCol = document.createElement("div");
  leftCol.style.position = "absolute";
  leftCol.style.left = safe;
  leftCol.style.top = "50%";
  leftCol.style.transform = "translateY(-50%)";
  leftCol.style.display = "flex";
  leftCol.style.flexDirection = "column";
  leftCol.style.gap = "10px";
  baroUI.appendChild(leftCol);

  const rightCol = document.createElement("div");
  rightCol.style.position = "absolute";
  rightCol.style.right = safe;
  rightCol.style.top = "50%";
  rightCol.style.transform = "translateY(-50%)";
  rightCol.style.display = "flex";
  rightCol.style.flexDirection = "column";
  rightCol.style.gap = "10px";
  baroUI.appendChild(rightCol);

  gTemp = makeGauge("Temp", "°C", -20, 60);
  gPress = makeGauge("Press", "hPa", 900, 1100);
  gAlt = makeGauge("Alt", "m", -100, 5000);

  leftCol.appendChild(gTemp.el);
  rightCol.appendChild(gPress.el);
  rightCol.appendChild(gAlt.el);

  if (isEmbed) {
    gTemp.el.style.width = "56px";
    gTemp.el.style.height = "210px";
    gPress.el.style.width = "56px";
    gPress.el.style.height = "210px";
    gAlt.el.style.width = "56px";
    gAlt.el.style.height = "210px";
  }
}

function unpackSerde(raw) {
  if (!raw || !raw.measurement || typeof raw.timestamp !== "number") return null;
  const keys = Object.keys(raw.measurement);
  if (keys.length !== 1) return null;
  const variant = keys[0];
  const values = raw.measurement[variant];

  if (Array.isArray(values) && values.length === 3 && variant !== "Baro") {
    return { sensor: variant.toLowerCase(), x: values[0], y: values[1], z: values[2], ts: raw.timestamp };
  }

  if (variant === "Baro" && Array.isArray(values) && values.length === 3) {
    return [
      { sensor: "temp", value: values[0], ts: raw.timestamp },
      { sensor: "pressure", value: values[1], ts: raw.timestamp },
      { sensor: "altitude", value: values[2], ts: raw.timestamp },
    ];
  }

  return null;
}

function quatToEulerDeg(q) {
  const x = q.x,
    y = q.y,
    z = q.z,
    w = q.w;

  const sinr_cosp = 2 * (w * x + y * z);
  const cosr_cosp = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinr_cosp, cosr_cosp);

  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);

  const siny_cosp = 2 * (w * z + x * y);
  const cosy_cosp = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(siny_cosp, cosy_cosp);

  return { roll: roll * RAD2DEG, pitch: pitch * RAD2DEG, yaw: yaw * RAD2DEG };
}

function v3len(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function tsToMs(ts) {
  const n = Number(ts);
  return Number.isFinite(n) ? n / 1000 : Date.now();
}

const FUSION_STEP_MS = 5;
const MAX_CATCHUP_MS = 60;

let lastFusionMs = null;
let accumMs = 0;

let gyroBiasX = 0,
  gyroBiasY = 0,
  gyroBiasZ = 0;
let lastAHRSQuat = null;

const GYRO_DEADBAND_RAD = 0.02;
const STILL_GYRO_RAD = 0.1;
const STILL_ACC_ERR = 0.08;
const TRUST_ACC_ERR = 0.18;

function maybeInvertContinuity(q) {
  if (!lastAHRSQuat) {
    lastAHRSQuat = q.clone();
    return q;
  }
  const dot = lastAHRSQuat.x * q.x + lastAHRSQuat.y * q.y + lastAHRSQuat.z * q.z + lastAHRSQuat.w * q.w;
  if (dot < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  lastAHRSQuat.copy(q);
  return q;
}

function fuseOneStep(stepMs) {
  if (frozen) return;
  if (!lastAccel || !lastGyro) return;

  const stepSec = stepMs / 1000;
  ahrs.sampleInterval = stepMs;

  let gx0 = Number(lastGyro.x) * DEG2RAD;
  let gy0 = Number(lastGyro.y) * DEG2RAD;
  let gz0 = Number(lastGyro.z) * DEG2RAD;
  if (!Number.isFinite(gx0) || !Number.isFinite(gy0) || !Number.isFinite(gz0)) return;

  let ax0 = Number(lastAccel.x);
  let ay0 = Number(lastAccel.y);
  let az0 = Number(lastAccel.z);
  if (!Number.isFinite(ax0) || !Number.isFinite(ay0) || !Number.isFinite(az0)) return;

  const gM = remapGyro(gx0, gy0, gz0);
  const aM = remapAccel(ax0, ay0, az0);

  let gx = gM[0],
    gy = gM[1],
    gz = gM[2];
  let ax = aM[0],
    ay = aM[1],
    az = aM[2];

  if (Math.abs(gx) < GYRO_DEADBAND_RAD) gx = 0;
  if (Math.abs(gy) < GYRO_DEADBAND_RAD) gy = 0;
  if (Math.abs(gz) < GYRO_DEADBAND_RAD) gz = 0;

  const aLen = v3len(ax, ay, az);
  const accErr = Math.abs(aLen - 1.0);
  const isStill = v3len(gx, gy, gz) < STILL_GYRO_RAD && accErr < STILL_ACC_ERR;

  if (isStill) {
    const alpha = clamp(stepSec / 2.0, 0.0, 0.02);
    gyroBiasX += alpha * (gx - gyroBiasX);
    gyroBiasY += alpha * (gy - gyroBiasY);
    gyroBiasZ += alpha * (gz - gyroBiasZ);
  }

  gx -= gyroBiasX;
  gy -= gyroBiasY;
  gz -= gyroBiasZ;

  let Ax = ax,
    Ay = ay,
    Az = az;
  if (aLen > 1e-6) {
    Ax /= aLen;
    Ay /= aLen;
    Az /= aLen;
  }

  const trustAccel = accErr < TRUST_ACC_ERR;
  const uiBeta = Number.isFinite(betaUi) ? betaUi : 0.08;
  const effBeta = trustAccel ? uiBeta : uiBeta * 0.12;
  ahrs.beta = effBeta;

  const useMag =
    !!lastMag && Number.isFinite(lastMag.x) && Number.isFinite(lastMag.y) && Number.isFinite(lastMag.z) && trustAccel;

  if (useMag) {
    const mx0 = Number(lastMag.x);
    const my0 = Number(lastMag.y);
    const mz0 = Number(lastMag.z);
    if (Number.isFinite(mx0) && Number.isFinite(my0) && Number.isFinite(mz0)) {
      const mM = remapMag(mx0, my0, mz0);
      ahrs.update(gx, gy, gz, Ax, Ay, Az, mM[0], mM[1], mM[2]);
    } else {
      ahrs.update(gx, gy, gz, Ax, Ay, Az);
    }
  } else {
    ahrs.update(gx, gy, gz, Ax, Ay, Az);
  }

  const q = ahrs.getQuaternion();
  const tq = new THREE.Quaternion(q.x, q.y, q.z, q.w);
  maybeInvertContinuity(tq);
  qTarget.copy(qOffset).multiply(tq).multiply(qModelAlign);
}

function processFusionTo(tsMs) {
  if (!model) return;
  if (lastFusionMs == null) {
    lastFusionMs = tsMs;
    return;
  }
  let dt = tsMs - lastFusionMs;
  if (!Number.isFinite(dt) || dt <= 0) return;

  dt = Math.min(dt, MAX_CATCHUP_MS);
  lastFusionMs = tsMs;
  accumMs += dt;

  while (accumMs >= FUSION_STEP_MS) {
    fuseOneStep(FUSION_STEP_MS);
    accumMs -= FUSION_STEP_MS;
  }
}

let msgWin = 0;
let lastRateMs = performance.now();
let rateHz = 0;

if (!demo) {
  swPort.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'open') {
      if (hud) hud.textContent = "connected";
    } else if (msg.type === 'error') {
      if (hud) hud.textContent = "SSE error / reconnecting...";
    } else if (msg.type === 'data') {
      // Filter by device; deviceKey "all" receives data from every device.
      if (deviceKey !== 'all' && msg.device !== deviceKey) return;
      msgWin += 1;

      const items = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
      for (const raw of items) {
        const u0 = unpackSerde(raw);
        if (!u0) continue;
        const list = Array.isArray(u0) ? u0 : [u0];

        for (const u of list) {
          const tsMs = tsToMs(u.ts);

          if (u.sensor === "accel") lastAccel = { ts_ms: tsMs, x: u.x, y: u.y, z: u.z };
          if (u.sensor === "gyro") lastGyro = { ts_ms: tsMs, x: u.x, y: u.y, z: u.z };
          if (u.sensor === "mag") lastMag = { ts_ms: tsMs, x: u.x, y: u.y, z: u.z };

          if (u.sensor === "temp" && Number.isFinite(u.value)) lastTemp = { ts_ms: tsMs, v: u.value };
          if (u.sensor === "pressure" && Number.isFinite(u.value)) lastPressure = { ts_ms: tsMs, v: u.value };
          if (u.sensor === "altitude" && Number.isFinite(u.value)) lastAltitude = { ts_ms: tsMs, v: u.value };

          if (lastAccel && lastGyro) processFusionTo(Math.max(lastAccel.ts_ms, lastGyro.ts_ms));
        }
      }
    }
  };
} else {
  console.log("DEMO mode ON (no SSE)");
}

function feedDemo() {
  const t = performance.now() / 1000;

  const ax = 0.15 * Math.sin(t * 1.2);
  const ay = 0.15 * Math.cos(t * 0.9);
  const az = 1.0;

  const gx = 20 * Math.cos(t * 1.1);
  const gy = 15 * Math.sin(t * 0.7);
  const gz = 10 * Math.sin(t * 0.5);

  const mx = 0.4 * Math.cos(t * 0.35);
  const my = 0.0;
  const mz = 0.4 * Math.sin(t * 0.35);

  const temp = 23 + 2 * Math.sin(t * 0.2);
  const pressPa = 101325 + 120 * Math.sin(t * 0.15);
  const alt = 140 + 3 * Math.sin(t * 0.18);

  const ts = Math.floor(Date.now() * 1000);

  const fake = [
    { measurement: { Accel: [ax, ay, az] }, timestamp: ts },
    { measurement: { Gyro: [gx, gy, gz] }, timestamp: ts },
    { measurement: { Mag: [mx, my, mz] }, timestamp: ts },
    { measurement: { Baro: [temp, pressPa, alt] }, timestamp: ts },
  ];

  for (const raw of fake) {
    const u0 = unpackSerde(raw);
    if (!u0) continue;
    const list = Array.isArray(u0) ? u0 : [u0];

    for (const u of list) {
      const tsMs = tsToMs(u.ts);

      if (u.sensor === "accel") lastAccel = { ts_ms: tsMs, x: u.x, y: u.y, z: u.z };
      if (u.sensor === "gyro") lastGyro = { ts_ms: tsMs, x: u.x, y: u.y, z: u.z };
      if (u.sensor === "mag") lastMag = { ts_ms: tsMs, x: u.x, y: u.y, z: u.z };

      if (u.sensor === "temp" && Number.isFinite(u.value)) lastTemp = { ts_ms: tsMs, v: u.value };
      if (u.sensor === "pressure" && Number.isFinite(u.value)) lastPressure = { ts_ms: tsMs, v: u.value };
      if (u.sensor === "altitude" && Number.isFinite(u.value)) lastAltitude = { ts_ms: tsMs, v: u.value };

      if (lastAccel && lastGyro) processFusionTo(Math.max(lastAccel.ts_ms, lastGyro.ts_ms));
    }
  }
}

const modelWorldPos = new THREE.Vector3();
const worldDown = new THREE.Vector3(0, -1, 0);

let lastRenderMs = performance.now();

// Rendering is gated on whether this tab/embed is the active one.
// The parent landing page sends 'kiwi-tab-active' messages on tab switches.
// Default true so a standalone window always renders.
let tabActive = true;
window.addEventListener('message', (ev) => {
  if (ev.data?.type === 'kiwi-tab-active') {
    tabActive = !!ev.data.active;
  }
});

function animate() {
  requestAnimationFrame(animate);

  if (!tabActive) return;

  if (demo) {
    msgWin += 1;
    feedDemo();
  }

  const now = performance.now();
  const elapsedRate = now - lastRateMs;
  if (elapsedRate >= 800) {
    rateHz = (msgWin * 1000) / elapsedRate;
    msgWin = 0;
    lastRateMs = now;
  }

  const dtRender = Math.max(0.001, Math.min(0.05, (now - lastRenderMs) / 1000));
  lastRenderMs = now;

  if (model) {
    const tau = 0.07;
    const k = 1 - Math.exp(-dtRender / tau);
    qDisplay.slerp(qTarget, k);
    model.quaternion.copy(qDisplay);

    model.getWorldPosition(modelWorldPos);
    gravityArrow.position.copy(modelWorldPos);
    gravityArrow.setDirection(worldDown);
  }

  ensureBaroUI();
  if (now - lastGaugeUpdateMs >= 120) {
    gTemp.setValue(lastTemp ? lastTemp.v : NaN);

    const pRaw = lastPressure ? lastPressure.v : NaN;
    const pHpa = Number.isFinite(pRaw) ? (pRaw > 2000 ? pRaw / 100 : pRaw) : NaN;
    gPress.setValue(pHpa);

    gAlt.setValue(lastAltitude ? lastAltitude.v : NaN);

    lastGaugeUpdateMs = now;
  }

  if (hud) {
    const modeText = demo ? "DEMO" : `SSE ${deviceKey}`;
    const a = lastAccel ? `${lastAccel.x.toFixed(3)},${lastAccel.y.toFixed(3)},${lastAccel.z.toFixed(3)}` : "-";
    const g = lastGyro ? `${lastGyro.x.toFixed(3)},${lastGyro.y.toFixed(3)},${lastGyro.z.toFixed(3)}` : "-";
    const m = lastMag ? `${lastMag.x.toFixed(3)},${lastMag.y.toFixed(3)},${lastMag.z.toFixed(3)}` : "-";

    let eulerText = "-";
    if (model) {
      const e = quatToEulerDeg(model.quaternion);
      eulerText = `r:${e.roll.toFixed(1)} p:${e.pitch.toFixed(1)} y:${e.yaw.toFixed(1)}`;
    }

    hud.textContent =
      `${modeText}  ${(rateHz || 0).toFixed(1)} Hz  beta ${Number.isFinite(betaUi) ? betaUi.toFixed(2) : "0.08"}  ${
        frozen ? "FROZEN" : "LIVE"
      }\n` +
      `accel: ${a}\n` +
      `gyro:  ${g}\n` +
      `mag:   ${m}\n` +
      `euler: ${eulerText}`;
  }

  controls.update();
  renderer.render(scene, camera);
}
animate();

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
}
window.addEventListener("resize", onResize, { passive: true });
onResize();