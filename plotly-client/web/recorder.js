// Recording and Excel export.
//
// Samples are recorded the moment the parser worker delivers them — before
// any display throttling — so a recording is complete regardless of pause,
// plot settings, or whether the tab is in the background.

import { UNITS } from './kiwi-protocol.js';

/** Stay under Excel's 1,048,576-row sheet limit; larger sheets are split. */
export const XLSX_MAX_ROWS = 1_000_000;

export class Recorder {
  constructor() {
    this.isRecording = false;
    this.startedAt = null;
    this.rows = [];
    this.origins = new Map(); // session -> first device timestamp (µs) in this recording
  }

  start(now = Date.now()) {
    this.isRecording = true;
    this.startedAt = now;
    this.rows = [];
    this.origins.clear();
  }

  stop() {
    this.isRecording = false;
  }

  /** Append a worker batch. `host_ms` is when the batch reached this browser. */
  add(items, host_ms) {
    if (!this.isRecording) return;
    for (const it of items) {
      if (!this.origins.has(it.session)) this.origins.set(it.session, it.t_us);
      this.rows.push({
        session: it.session,
        t_us: it.t_us,
        elapsed_s: (it.t_us - this.origins.get(it.session)) / 1e6,
        host_ms,
        sensor: it.sensor,
        label: it.label ?? null,
        x: it.x ?? null,
        y: it.y ?? null,
        z: it.z ?? null,
        mag: it.mag ?? null,
        value: it.value ?? null,
      });
    }
  }
}

function base(r) {
  return {
    session: r.session,
    device_time_us: r.t_us,
    elapsed_s: r.elapsed_s,
    host_received: new Date(r.host_ms).toISOString(),
  };
}

function vectorSheet(rows, sensor) {
  const u = UNITS[sensor];
  return rows
    .filter((r) => r.sensor === sensor)
    .map((r) => ({
      ...base(r),
      [`x (${u})`]: r.x,
      [`y (${u})`]: r.y,
      [`z (${u})`]: r.z,
      [`magnitude (${u})`]: r.mag,
    }));
}

/** Merge scalar sensors that share a timestamp (e.g. Baro's three values) into one row. */
function mergedSheet(rows, sensors) {
  const byKey = new Map();
  for (const r of rows) {
    if (!sensors.includes(r.sensor)) continue;
    const key = `${r.session}:${r.t_us}`;
    let row = byKey.get(key);
    if (!row) {
      row = base(r);
      for (const s of sensors) row[`${s} (${UNITS[s]})`] = null;
      byKey.set(key, row);
    }
    row[`${r.sensor} (${UNITS[r.sensor]})`] = r.value;
  }
  return Array.from(byKey.values());
}

function labelledSheet(rows, sensors) {
  return rows
    .filter((r) => sensors.includes(r.sensor))
    .map((r) => ({ ...base(r), sensor: r.sensor, label: r.label, value: r.value, unit: UNITS[r.sensor] }));
}

function split(name, rows, maxRows) {
  if (rows.length <= maxRows) return [{ name, rows }];
  const out = [];
  for (let i = 0; i < rows.length; i += maxRows) {
    out.push({ name: i === 0 ? name : `${name}_${i / maxRows + 1}`, rows: rows.slice(i, i + maxRows) });
  }
  return out;
}

/** Shape recorded rows into named sheets. Empty sheets are omitted. */
export function buildSheets(rows, maxRows = XLSX_MAX_ROWS) {
  const sheets = [
    ['ACCEL', vectorSheet(rows, 'accel')],
    ['GYRO', vectorSheet(rows, 'gyro')],
    ['MAG', vectorSheet(rows, 'mag')],
    ['BARO', mergedSheet(rows, ['temp', 'pressure', 'altitude'])],
    ['HUMI', mergedSheet(rows, ['humi_temp', 'humidity', 'aqi'])],
    ['PROBES', labelledSheet(rows, ['probe_temp', 'lux'])],
  ];
  return sheets.filter(([, r]) => r.length).flatMap(([name, r]) => split(name, r, maxRows));
}

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function exportFilename(board, deviceId, startedAt) {
  const clean = (s) => String(s).replace(/[^\w.-]+/g, '_');
  return `${clean(board || 'kiwi')}_${clean(deviceId)}_${stamp(startedAt)}.xlsx`;
}
