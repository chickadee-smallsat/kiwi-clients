// Kiwi measurement protocol, shared by the dashboard worker, the 3D viewer
// and the unit tests.
//
// The backend forwards each board's packets as JSON batches of serde-encoded
// `kiwi_measurements::SingleMeasurement`:
//   [{ "measurement": { "Accel": [x, y, z] }, "timestamp": 3965479 }, ...]
// `timestamp` is always microseconds since the board booted. Values are passed
// through exactly as the firmware reports them (sensor frame, no remapping).

/** Units of each decoded sensor, as defined by kiwi-measurements. */
export const UNITS = Object.freeze({
  accel: 'g',
  gyro: 'deg/s',
  mag: 'mG',
  temp: '°C',
  pressure: 'hPa',
  altitude: 'm',
  probe_temp: '°C',
  humi_temp: '°C',
  humidity: '%',
  aqi: 'AQI',
  lux: 'lx',
});

export function isVectorSensor(sensor) {
  return sensor === 'accel' || sensor === 'gyro' || sensor === 'mag';
}

/** A timestamp jump backwards larger than this means the board rebooted. */
const REBOOT_BACKSTEP_US = 1_000_000;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function scalar(sensor, t_us, value, label) {
  const v = num(value);
  if (v === null) return null;
  return label === undefined ? { sensor, t_us, value: v } : { sensor, t_us, value: v, label };
}

/**
 * Decode one SingleMeasurement object into zero or more flat samples:
 *   vector: { sensor, t_us, x, y, z }
 *   scalar: { sensor, t_us, value, label? }
 */
export function decodeMeasurement(raw) {
  if (!raw || typeof raw !== 'object' || !raw.measurement) return [];
  const t_us = num(raw.timestamp);
  if (t_us === null || t_us < 0) return [];

  const keys = Object.keys(raw.measurement);
  if (keys.length !== 1) return [];
  const variant = keys[0];
  const v = raw.measurement[variant];
  // Temp and Lux are [label, value]; every other variant carries three numbers.
  const arity = variant === 'Temp' || variant === 'Lux' ? 2 : 3;
  if (!Array.isArray(v) || v.length !== arity) return [];

  switch (variant) {
    case 'Accel':
    case 'Gyro':
    case 'Mag': {
      const [x, y, z] = v.map(num);
      if (x === null || y === null || z === null) return [];
      return [{ sensor: variant.toLowerCase(), t_us, x, y, z }];
    }
    case 'Baro':
      return [
        scalar('temp', t_us, v[0]),
        scalar('pressure', t_us, v[1]),
        scalar('altitude', t_us, v[2]),
      ].filter(Boolean);
    case 'Humi':
      return [
        scalar('humi_temp', t_us, v[0]),
        scalar('humidity', t_us, v[1]),
        scalar('aqi', t_us, v[2]),
      ].filter(Boolean);
    case 'Temp':
      return [scalar('probe_temp', t_us, v[1], String(v[0] ?? ''))].filter(Boolean);
    case 'Lux':
      return [scalar('lux', t_us, v[1], String(v[0] ?? ''))].filter(Boolean);
    default:
      return [];
  }
}

/** Decode one SSE message (a JSON array of measurements). Invalid input → []. */
export function decodeBatch(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out = [];
  for (const raw of list) {
    for (const s of decodeMeasurement(raw)) out.push(s);
  }
  return out;
}

export function magnitude(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

/** Spherical angles of a vector: theta from +Z, phi (azimuth) from +X. */
export function anglesDeg(x, y, z) {
  const r2d = 180 / Math.PI;
  return {
    theta_deg: Math.atan2(Math.sqrt(x * x + y * y), z) * r2d,
    phi_deg: Math.atan2(y, x) * r2d,
  };
}

/** Roll/pitch (degrees) of the board from a gravity vector in g. */
export function tiltDeg(ax, ay, az) {
  const r2d = 180 / Math.PI;
  return {
    roll: Math.atan2(ay, az) * r2d,
    pitch: Math.atan2(-ax, Math.sqrt(ay * ay + az * az)) * r2d,
  };
}

/**
 * Converts device timestamps (µs since boot) to seconds since the first
 * sample of the current device session. A large backwards jump means the
 * board rebooted: a new session starts and `reset` is reported.
 */
export class SessionClock {
  constructor() {
    this.origin = null;
    this.latest = null;
    this.session = 0;
  }

  /** @returns {{ t_s: number, reset: boolean }} */
  update(t_us) {
    let reset = false;
    if (this.origin === null) {
      this.origin = t_us;
    } else if (t_us < this.latest - REBOOT_BACKSTEP_US) {
      this.origin = t_us;
      this.session += 1;
      reset = true;
    }
    if (this.latest === null || reset || t_us > this.latest) this.latest = t_us;
    return { t_s: (t_us - this.origin) / 1e6, reset };
  }
}
