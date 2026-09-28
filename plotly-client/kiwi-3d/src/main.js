import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Madgwick } from "./madgwick.js";
import { decodeMeasurement } from "../../web/kiwi-protocol.js";
import "./style.css";

const params = new URLSearchParams(location.search);
const deviceKey = params.get("src");
const demo = params.get("demo") === "1";
const isEmbed = params.get("embed") === "1";

// The viewer shows one device; without one (and outside demo mode) go pick it.
if (!deviceKey && !demo) location.replace("/");
const esUrl = `/devices/${encodeURIComponent(deviceKey ?? "")}/events`;

// Shared fonts and colour tokens (served by plotly-client, not bundled).
const themeLink = document.createElement("link");
themeLink.rel = "stylesheet";
themeLink.href = "/theme.css";
document.head.appendChild(themeLink);

function applyTheme(theme) {
  for (const node of [document.documentElement, document.body]) {
    node.classList.toggle("light", theme === "light");
    node.classList.toggle("dark", theme !== "light");
  }
}
document.documentElement.classList.toggle("embed", isEmbed);
document.body.classList.toggle("embed", isEmbed);
applyTheme(localStorage.getItem("theme") || "dark");
// The dashboard calls this when its theme changes.
window.kiwiSetTheme = applyTheme;
window.addEventListener("storage", (e) => {
  if (e.key === "theme" && e.newValue) applyTheme(e.newValue);
});

/** Create an element with a class name and optional text. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const scene = new THREE.Scene();

const gravityArrow = new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 0), 0.8, 0xff4444);
scene.add(gravityArrow);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100);
camera.position.set(0.6, 0.4, 1.0);
const CAMERA_DIR = new THREE.Vector3(0.6, 0.4, 1.0).normalize();

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
document.body.appendChild(renderer.domElement);

let hud = null;
let hudBadge = null;
const hudVals = {};
let resetBtn = null;
let freezeBtn = null;
let betaVal = null;
let betaSlider = null;

if (!isEmbed) {
  hud = el("div", "hud glass");

  const head = el("div", "hudHead");
  head.append(el("span", "hudTitle", "Orientation"), el("span", "hudDevice", deviceKey || "demo"));
  hudBadge = el("span", "hudBadge", "LIVE");
  head.appendChild(hudBadge);
  hud.appendChild(head);

  const rows = el("div", "hudRows");
  for (const [key, label, color] of [
    ["accel", "Accel (g)", "var(--c-accel)"],
    ["gyro", "Gyro (°/s)", "var(--c-gyro)"],
    ["mag", "Mag (mG)", "var(--c-mag)"],
    [null],
    ["euler", "Roll · pitch · yaw", "var(--accent)"],
    ["rate", "Sample rate", "var(--text-3)"],
  ]) {
    if (!key) {
      rows.appendChild(el("div", "hudDivider"));
      continue;
    }
    const l = el("span", "hudLabel", label);
    l.style.setProperty("--c", color);
    hudVals[key] = el("span", "hudVal", "—");
    rows.append(l, hudVals[key]);
  }
  hud.appendChild(rows);

  const ctl = el("div", "hudControls");
  resetBtn = el("button", "hudBtn", "Reset orientation");
  freezeBtn = el("button", "hudBtn", "Freeze");
  ctl.append(resetBtn, freezeBtn);
  hud.appendChild(ctl);

  const slider = el("label", "hudSlider");
  betaSlider = document.createElement("input");
  betaSlider.type = "range";
  betaSlider.min = "0.02";
  betaSlider.max = "0.25";
  betaSlider.step = "0.01";
  betaSlider.value = "0.08";
  betaVal = el("span", "hudVal", "0.08");
  slider.append(el("span", null, "Filter gain β"), betaSlider, betaVal);
  hud.appendChild(slider);

  document.body.appendChild(hud);
}

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableRotate = false;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.update();

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const dir = new THREE.DirectionalLight(0xffffff, 1.2);
dir.position.set(1, 2, 1);
scene.add(dir);

let model = null;
const loader = new GLTFLoader();
// Radius of the sphere the model sweeps while rotating about its origin.
let modelRadius = 0;
loader.load("kiwi.glb", (gltf) => {
  model = gltf.scene;
  model.scale.setScalar(3);
  scene.add(model);

  const box = new THREE.Box3().setFromObject(model);
  modelRadius = Math.max(box.min.length(), box.max.length());
  // Keep the gravity arrow in proportion to the board, just past its edge.
  gravityArrow.setLength(modelRadius * 1.4, modelRadius * 0.25, modelRadius * 0.12);
  frameModel();
});

/** Place the camera so the rotating board fills most of the view. */
function frameModel() {
  if (!modelRadius) return;
  const vFov = camera.fov * DEG2RAD;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const fill = isEmbed ? 0.8 : 0.6; // fraction of the view the board spans
  const dist = modelRadius / Math.sin(Math.min(vFov, hFov) / 2) / fill;
  controls.target.set(0, 0, 0);
  camera.position.copy(CAMERA_DIR).multiplyScalar(dist);
  controls.update();
}

let lastAccel = null;
let lastGyro = null;
let lastMag = null;

// Latest barometer readings (plain numbers).
let lastTemp = NaN;
let lastPressure = NaN;
let lastAltitude = NaN;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

let betaUi = 0.08;
const ahrs = new Madgwick({ beta: betaUi }); // step size is passed with each update

const qOffset = new THREE.Quaternion(); // set by "Reset orientation"
const qTarget = new THREE.Quaternion();
const qDisplay = new THREE.Quaternion();

let frozen = false;

let baroUI = null;
let gTemp = null,
  gPress = null,
  gAlt = null;
let lastGaugeUpdateMs = 0;

// Sensor axes → the model's frame (three.js is y-up).
function toModelFrame(x, y, z) {
  return [x, z, -y];
}

if (resetBtn) {
  // Make the current attitude the reference, so the model shows level.
  resetBtn.addEventListener("click", () => {
    if (lastAHRSQuat) qOffset.copy(lastAHRSQuat).invert();
  });
}

if (freezeBtn) {
  freezeBtn.addEventListener("click", () => {
    frozen = !frozen;
    freezeBtn.textContent = frozen ? "Resume" : "Freeze";
    if (hudBadge) {
      hudBadge.textContent = frozen ? "FROZEN" : "LIVE";
      hudBadge.classList.toggle("frozen", frozen);
    }
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

function makeGauge(title, unit, min, max, color, digits) {
  const wrap = el("div", "gauge glass");
  wrap.style.setProperty("--c", color);
  const value = el("div", "gaugeValue", "—");
  const track = el("div", "gaugeTrack");
  const fill = el("div", "gaugeFill");
  const marker = el("div", "gaugeMarker");
  track.append(fill, marker);
  wrap.append(el("div", "gaugeTitle", title), value, el("div", "gaugeUnit", unit), track);

  function setValue(val) {
    if (!Number.isFinite(val)) {
      value.textContent = "—";
      return;
    }
    value.textContent = val.toFixed(digits);
    const t = Math.min(1, Math.max(0, (val - min) / (max - min)));
    marker.style.top = `calc(${(1 - t) * 100}% - 1px)`;
    fill.style.height = `${t * 100}%`;
  }

  setValue(NaN);
  return { el: wrap, setValue };
}

// The dashboard already shows temperature, pressure and altitude, so the
// embedded panel shows the board's attitude instead of the gauges.
let attitudeVals = null;

function ensureAttitudeUI() {
  if (attitudeVals) return;
  const chip = el("div", "attitudeChip glass");
  attitudeVals = {};
  for (const [key, label] of [["roll", "Roll"], ["pitch", "Pitch"], ["yaw", "Yaw"]]) {
    const item = el("div", "attitudeItem");
    attitudeVals[key] = el("span", "attitudeVal", "—");
    item.append(el("span", "attitudeLabel", label), attitudeVals[key]);
    chip.appendChild(item);
  }
  document.body.appendChild(chip);
}

function ensureBaroUI() {
  if (baroUI) return;

  baroUI = el("div", "gaugeLayer");
  const leftCol = el("div", "gaugeCol left");
  const rightCol = el("div", "gaugeCol right");
  baroUI.append(leftCol, rightCol);
  document.body.appendChild(baroUI);

  gTemp = makeGauge("Temp", "°C", -20, 60, "var(--c-temp)", 2);
  gPress = makeGauge("Press", "hPa", 900, 1100, "var(--c-pressure)", 1);
  gAlt = makeGauge("Alt", "m", -100, 5000, "var(--c-altitude)", 1);

  leftCol.appendChild(gTemp.el);
  rightCol.append(gPress.el, gAlt.el);
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
// The first reading sets the attitude directly; later ones refine it.
let fusionInitialised = false;
// Jump the displayed model to the target once, instead of easing from identity.
let snapDisplay = false;

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

  const gx0 = Number(lastGyro.x) * DEG2RAD;
  const gy0 = Number(lastGyro.y) * DEG2RAD;
  const gz0 = Number(lastGyro.z) * DEG2RAD;
  if (!Number.isFinite(gx0) || !Number.isFinite(gy0) || !Number.isFinite(gz0)) return;

  const ax0 = Number(lastAccel.x);
  const ay0 = Number(lastAccel.y);
  const az0 = Number(lastAccel.z);
  if (!Number.isFinite(ax0) || !Number.isFinite(ay0) || !Number.isFinite(az0)) return;

  const gM = toModelFrame(gx0, gy0, gz0);
  const aM = toModelFrame(ax0, ay0, az0);

  let gx = gM[0],
    gy = gM[1],
    gz = gM[2];
  const ax = aM[0],
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

  const mag = lastMag ? toModelFrame(lastMag.x, lastMag.y, lastMag.z) : null;

  if (!fusionInitialised) {
    const m = mag ?? [];
    ahrs.initFrom(ax, ay, az, ...m);
    fusionInitialised = true;
    snapDisplay = true;
  }

  const trustAccel = accErr < TRUST_ACC_ERR;
  const uiBeta = Number.isFinite(betaUi) ? betaUi : 0.08;
  const effBeta = trustAccel ? uiBeta : uiBeta * 0.12;
  ahrs.beta = effBeta;

  // The magnetometer is only trusted while the accelerometer is (not while shaken).
  const [mx, my, mz] = mag && trustAccel ? mag : [];
  ahrs.update(gx, gy, gz, Ax, Ay, Az, mx, my, mz, stepSec);

  const q = ahrs.getQuaternion();
  const tq = new THREE.Quaternion(q.x, q.y, q.z, q.w);
  maybeInvertContinuity(tq);
  qTarget.copy(qOffset).multiply(tq);
}

function processFusionTo(tsMs) {
  if (!model) return;
  if (lastFusionMs == null) {
    lastFusionMs = tsMs;
    return;
  }
  let dt = tsMs - lastFusionMs;
  if (!Number.isFinite(dt)) return;
  if (dt < -1000) {
    // Board rebooted (its µs clock restarted): resync instead of freezing.
    lastFusionMs = tsMs;
    return;
  }
  if (dt <= 0) return;

  dt = Math.min(dt, MAX_CATCHUP_MS);
  lastFusionMs = tsMs;
  accumMs += dt;

  while (accumMs >= FUSION_STEP_MS) {
    fuseOneStep(FUSION_STEP_MS);
    accumMs -= FUSION_STEP_MS;
  }
}

/** Apply one SingleMeasurement to the latest-value state and advance fusion. */
function ingest(raw) {
  for (const u of decodeMeasurement(raw)) {
    const tsMs = tsToMs(u.t_us);

    if (u.sensor === "accel") {
      lastAccel = { ts_ms: tsMs, x: u.x, y: u.y, z: u.z };
      accelSamples += 1;
    }
    if (u.sensor === "gyro") lastGyro = { ts_ms: tsMs, x: u.x, y: u.y, z: u.z };
    if (u.sensor === "mag") lastMag = { x: u.x, y: u.y, z: u.z };

    if (u.sensor === "temp") lastTemp = u.value;
    if (u.sensor === "pressure") lastPressure = u.value;
    if (u.sensor === "altitude") lastAltitude = u.value;

    if (lastAccel && lastGyro) processFusionTo(Math.max(lastAccel.ts_ms, lastGyro.ts_ms));
  }
}

// Accelerometer samples per second, shown in the readout.
let accelSamples = 0;
let lastRateMs = performance.now();
let rateHz = 0;

if (!demo && deviceKey) {
  const es = new EventSource(esUrl);
  es.onerror = () => {
    if (hudBadge && !frozen) hudBadge.textContent = "RECONNECTING";
  };
  es.onmessage = (e) => {
    if (hudBadge && !frozen) hudBadge.textContent = "LIVE";
    let parsed;
    try {
      parsed = JSON.parse(e.data);
    } catch {
      return;
    }
    for (const raw of Array.isArray(parsed) ? parsed : [parsed]) ingest(raw);
  };
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
  const pressHpa = 1013.25 + 1.2 * Math.sin(t * 0.15);
  const alt = 140 + 3 * Math.sin(t * 0.18);

  const ts = Math.floor(performance.now() * 1000); // µs, like a board clock

  const fake = [
    { measurement: { Accel: [ax, ay, az] }, timestamp: ts },
    { measurement: { Gyro: [gx, gy, gz] }, timestamp: ts },
    { measurement: { Mag: [mx, my, mz] }, timestamp: ts },
    { measurement: { Baro: [temp, pressHpa, alt] }, timestamp: ts },
  ];

  for (const raw of fake) ingest(raw);
}

const modelWorldPos = new THREE.Vector3();
const worldDown = new THREE.Vector3(0, -1, 0);

let lastRenderMs = performance.now();

// The embedded view is a small panel; 30 fps is plenty and halves GPU/CPU cost.
const EMBED_FRAME_MS = 1000 / 30;
let lastDrawMs = 0;

function animate() {
  requestAnimationFrame(animate);

  // The dashboard sets kiwiPaused while a panel is dragged or resized.
  if (window.kiwiPaused) return;
  if (isEmbed && performance.now() - lastDrawMs < EMBED_FRAME_MS) return;
  lastDrawMs = performance.now();

  if (demo) feedDemo();

  const now = performance.now();
  const elapsedRate = now - lastRateMs;
  if (elapsedRate >= 1000) {
    rateHz = (accelSamples * 1000) / elapsedRate;
    accelSamples = 0;
    lastRateMs = now;
  }

  // Real elapsed time (capped only for tab switches), so the model eases at the
  // same speed whatever the frame rate.
  const dtRender = Math.max(0.001, Math.min(0.5, (now - lastRenderMs) / 1000));
  lastRenderMs = now;

  if (model) {
    const tau = 0.07;
    const k = 1 - Math.exp(-dtRender / tau);
    if (snapDisplay) {
      qDisplay.copy(qTarget);
      snapDisplay = false;
    } else if (!frozen) {
      qDisplay.slerp(qTarget, k);
    }
    model.quaternion.copy(qDisplay);

    model.getWorldPosition(modelWorldPos);
    gravityArrow.position.copy(modelWorldPos);
    gravityArrow.setDirection(worldDown);
  }

  if (isEmbed) {
    ensureAttitudeUI();
    if (model && now - lastGaugeUpdateMs >= 120) {
      const e = quatToEulerDeg(model.quaternion);
      attitudeVals.roll.textContent = `${e.roll.toFixed(1)}°`;
      attitudeVals.pitch.textContent = `${e.pitch.toFixed(1)}°`;
      attitudeVals.yaw.textContent = `${e.yaw.toFixed(1)}°`;
      lastGaugeUpdateMs = now;
    }
  } else {
    ensureBaroUI();
    if (now - lastGaugeUpdateMs >= 120) {
      gTemp.setValue(lastTemp);
      gPress.setValue(lastPressure);
      gAlt.setValue(lastAltitude);
      lastGaugeUpdateMs = now;
    }
  }

  if (hud) {
    const fmt = (v, d) => (v ? `${v.x.toFixed(d)}  ${v.y.toFixed(d)}  ${v.z.toFixed(d)}` : "—");
    hudVals.accel.textContent = fmt(lastAccel, 3);
    hudVals.gyro.textContent = fmt(lastGyro, 2);
    hudVals.mag.textContent = fmt(lastMag, 1);
    if (model) {
      const e = quatToEulerDeg(model.quaternion);
      hudVals.euler.textContent = `${e.roll.toFixed(1)}°  ${e.pitch.toFixed(1)}°  ${e.yaw.toFixed(1)}°`;
    }
    hudVals.rate.textContent = `${rateHz.toFixed(1)} Hz${demo ? " (demo)" : ""}`;
  }

  controls.update();
  renderer.render(scene, camera);
}

// Read-only state for automated tests and debugging in the browser console.
window.kiwi3d = Object.freeze({
  fusionQuaternion: () => ahrs.getQuaternion(),
  modelQuaternion: () => (model ? model.quaternion.toArray() : null),
  beta: () => ahrs.beta,
  latest: () => ({ accel: lastAccel, gyro: lastGyro, mag: lastMag, temp: lastTemp, pressure: lastPressure, altitude: lastAltitude }),
});

animate();

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  frameModel();
}
window.addEventListener("resize", onResize, { passive: true });
onResize();