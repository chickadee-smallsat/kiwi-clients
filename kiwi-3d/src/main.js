import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import AHRS from "ahrs";

const params = new URLSearchParams(location.search);
const deviceKey = params.get("src") || "all";
const devicePort = deviceKey === "all" ? null : Number(deviceKey);
const demo = params.get("demo") === "1";
const isEmbed = params.get("embed") === "1";

const esUrl = devicePort ? `/devices/${devicePort}/events` : "/events";
const es = new EventSource(esUrl);

const scene = new THREE.Scene();

const gravityArrow = new THREE.ArrowHelper(
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 0),
  0.8,
  0xff4444
);
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
loader.load("/kiwi.glb", (gltf) => {
  model = gltf.scene;
  model.scale.setScalar(3);
  scene.add(model);
});

let lastAccel = null;
let lastGyro = null;
let lastMag = null;
let lastTsMs = null;

const ahrs = new AHRS({ algorithm: "Madgwick", sampleInterval: 20, beta: 0.08 });
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

let baseTs = null;
let baseWall = null;
let tsScale = null;

let qOffset = new THREE.Quaternion();
let qTmp = new THREE.Quaternion();

let frozen = false;

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
      ahrs.beta = v;
      if (betaVal) betaVal.textContent = v.toFixed(2);
    }
  });
}

function updateScale(rawDelta, wallDeltaMs) {
  if (tsScale != null) return;
  const perMs = rawDelta / wallDeltaMs;
  if (perMs > 5e5) tsScale = 1e6;
  else if (perMs > 5e2) tsScale = 1e3;
  else tsScale = 1;
}

function tsToMs(ts, wallNow) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return wallNow;
  if (baseTs == null) {
    baseTs = n;
    baseWall = wallNow;
    return baseWall;
  }
  const rawDelta = n - baseTs;
  const wallDelta = Math.max(1, wallNow - baseWall);
  if (rawDelta > 0) updateScale(rawDelta, wallDelta);
  const s = tsScale == null ? 1 : tsScale;
  return baseWall + rawDelta / s;
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

function applyOrientation(q) {
  if (!model) return;
  qTmp.set(q.x, q.y, q.z, q.w);
  model.quaternion.copy(qOffset).multiply(qTmp);
}

function quatToEulerDeg(q) {
  const x = q.x, y = q.y, z = q.z, w = q.w;

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

function fuseIfReady(tsMs) {
  if (frozen) return;
  if (!lastAccel || !lastGyro || !model) return;

  if (lastTsMs == null) lastTsMs = tsMs;
  const dt = Math.max(5, Math.min(50, tsMs - lastTsMs));
  lastTsMs = tsMs;

  ahrs.sampleInterval = dt;

  let gx = Number(lastGyro.x) * DEG2RAD;
  let gy = Number(lastGyro.y) * DEG2RAD;
  let gz = Number(lastGyro.z) * DEG2RAD;

  const GYRO_DEADBAND = 0.02;
  if (Math.abs(gx) < GYRO_DEADBAND) gx = 0;
  if (Math.abs(gy) < GYRO_DEADBAND) gy = 0;
  if (Math.abs(gz) < GYRO_DEADBAND) gz = 0;

  let ax = Number(lastAccel.x);
  let ay = Number(lastAccel.y);
  let az = Number(lastAccel.z);

  let Ax = ax;
  let Ay = ay;
  let Az = az;

  let Gx = gx;
  let Gy = gy;
  let Gz = gz;

  const n = Math.sqrt(Ax * Ax + Ay * Ay + Az * Az);
  if (n > 1e-6) {
    Ax /= n;
    Ay /= n;
    Az /= n;
  }

  const useMag = !!(lastMag && Number.isFinite(lastMag.x) && Number.isFinite(lastMag.y) && Number.isFinite(lastMag.z));

  if (useMag) {
    const mx = Number(lastMag.x);
    const my = Number(lastMag.y);
    const mz = Number(lastMag.z);
    ahrs.update(Gx, Gy, Gz, Ax, Ay, Az, mx, my, mz);
  } else {
    ahrs.update(Gx, Gy, Gz, Ax, Ay, Az);
  }

  applyOrientation(ahrs.getQuaternion());
}

let msgCount = 0;
let msgWin = 0;
let lastRateMs = performance.now();
let rateHz = 0;

if (!demo) {
  es.onopen = () => console.log("SSE connected:", esUrl);
  es.onerror = () => console.log("SSE error / reconnecting...");

  es.onmessage = (e) => {
    msgCount += 1;
    msgWin += 1;

    let parsed;
    try { parsed = JSON.parse(e.data); } catch { return; }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const wallNow = Date.now();

    for (const raw of items) {
      const u0 = unpackSerde(raw);
      if (!u0) continue;
      const list = Array.isArray(u0) ? u0 : [u0];

      for (const u of list) {
        const tsMs = tsToMs(u.ts, wallNow);

        if (u.sensor === "accel") lastAccel = { ts_ms: tsMs, x: u.x, y: u.y, z: u.z };
        if (u.sensor === "gyro") lastGyro = { ts_ms: tsMs, x: u.x, y: u.y, z: u.z };
        if (u.sensor === "mag") lastMag = { ts_ms: tsMs, x: u.x, y: u.y, z: u.z };

        if (lastAccel && lastGyro) fuseIfReady(Math.max(lastAccel.ts_ms, lastGyro.ts_ms));
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

  const ts = Math.floor(Date.now() * 1000);

  const fake = [
    { measurement: { Accel: [ax, ay, az] }, timestamp: ts },
    { measurement: { Gyro: [gx, gy, gz] }, timestamp: ts },
    { measurement: { Mag: [mx, my, mz] }, timestamp: ts },
  ];

  const wallNow = Date.now();

  for (const raw of fake) {
    const u0 = unpackSerde(raw);
    if (!u0) continue;
    const list = Array.isArray(u0) ? u0 : [u0];

    for (const u of list) {
      const tsMs = tsToMs(u.ts, wallNow);

      if (u.sensor === "accel") lastAccel = { ts_ms: tsMs, x: u.x, y: u.y, z: u.z };
      if (u.sensor === "gyro") lastGyro = { ts_ms: tsMs, x: u.x, y: u.y, z: u.z };
      if (u.sensor === "mag") lastMag = { ts_ms: tsMs, x: u.x, y: u.y, z: u.z };

      if (lastAccel && lastGyro) fuseIfReady(Math.max(lastAccel.ts_ms, lastGyro.ts_ms));
    }
  }
}

const modelWorldPos = new THREE.Vector3();
const worldDown = new THREE.Vector3(0, -1, 0);

function animate() {
  requestAnimationFrame(animate);

  if (demo) {
    msgWin += 1;
    feedDemo();
  }

  const now = performance.now();
  const elapsed = now - lastRateMs;
  if (elapsed >= 800) {
    rateHz = (msgWin * 1000) / elapsed;
    msgWin = 0;
    lastRateMs = now;
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
      `${modeText}  ${(rateHz || 0).toFixed(1)} Hz  beta ${Number(ahrs.beta).toFixed(2)}  ${frozen ? "FROZEN" : "LIVE"}\n` +
      `accel: ${a}\n` +
      `gyro:  ${g}\n` +
      `mag:   ${m}\n` +
      `euler: ${eulerText}`;
  }

  if (model) {
    model.getWorldPosition(modelWorldPos);
    gravityArrow.position.copy(modelWorldPos);
    gravityArrow.setDirection(worldDown);
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