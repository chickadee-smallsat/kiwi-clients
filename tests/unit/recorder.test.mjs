import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder, buildSheets, exportFilename } from '../../plotly-client/web/recorder.js';

const HOST = Date.UTC(2026, 0, 2, 3, 4, 5);

function vec(sensor, t_us, x, y, z, session = 0) {
  return { sensor, t_us, session, x, y, z, mag: Math.hypot(x, y, z) };
}
function sc(sensor, t_us, value, session = 0) {
  return { sensor, t_us, session, value };
}

test('records nothing until started, everything once started', () => {
  const r = new Recorder();
  r.add([vec('accel', 1, 0, 0, 1)], HOST);
  assert.equal(r.rows.length, 0);
  r.start(HOST);
  r.add([vec('accel', 1_000, 0, 0, 1), vec('accel', 21_000, 0, 0, 1)], HOST);
  r.stop();
  r.add([vec('accel', 41_000, 0, 0, 1)], HOST);
  assert.equal(r.rows.length, 2);
});

test('elapsed time is relative to the first recorded sample', () => {
  const r = new Recorder();
  r.start(HOST);
  r.add([vec('accel', 5_000_000, 0, 0, 1), vec('accel', 5_020_000, 0, 0, 1)], HOST);
  assert.deepEqual(r.rows.map((x) => x.elapsed_s), [0, 0.02]);
});

test('vector sheets carry units, raw device time and a filled magnitude', () => {
  const r = new Recorder();
  r.start(HOST);
  r.add([vec('accel', 1_000, 3, 4, 0), vec('gyro', 1_000, 1, 0, 0), vec('mag', 1_000, 0, 0, 500)], HOST);
  const sheets = Object.fromEntries(buildSheets(r.rows).map((s) => [s.name, s.rows]));
  assert.deepEqual(Object.keys(sheets), ['ACCEL', 'GYRO', 'MAG']);
  assert.deepEqual(sheets.ACCEL[0], {
    session: 0,
    device_time_us: 1_000,
    elapsed_s: 0,
    host_received: '2026-01-02T03:04:05.000Z',
    'x (g)': 3,
    'y (g)': 4,
    'z (g)': 0,
    'magnitude (g)': 5,
  });
  assert.ok('x (deg/s)' in sheets.GYRO[0]);
  assert.ok('magnitude (mG)' in sheets.MAG[0]);
});

test('baro values sharing a timestamp merge into one row', () => {
  const r = new Recorder();
  r.start(HOST);
  r.add([sc('temp', 7, 25), sc('pressure', 7, 1013.25), sc('altitude', 7, 0), sc('temp', 27, 25.1)], HOST);
  const baro = buildSheets(r.rows).find((s) => s.name === 'BARO').rows;
  assert.equal(baro.length, 2);
  assert.equal(baro[0]['pressure (hPa)'], 1013.25);
  assert.equal(baro[0]['altitude (m)'], 0);
  assert.equal(baro[1]['pressure (hPa)'], null);
});

test('samples from different sessions never merge', () => {
  const r = new Recorder();
  r.start(HOST);
  r.add([sc('temp', 7, 25, 0), sc('temp', 7, 26, 1)], HOST);
  assert.equal(buildSheets(r.rows)[0].rows.length, 2);
});

test('labelled probe sensors are exported, not dropped', () => {
  const r = new Recorder();
  r.start(HOST);
  r.add([{ sensor: 'probe_temp', t_us: 1, session: 0, value: 41.5, label: 'cpu' }], HOST);
  const [sheet] = buildSheets(r.rows);
  assert.equal(sheet.name, 'PROBES');
  assert.equal(sheet.rows[0].label, 'cpu');
  assert.equal(sheet.rows[0].unit, '°C');
});

test('sheets beyond the Excel row limit are split, not truncated', () => {
  const rows = [];
  const r = new Recorder();
  r.start(HOST);
  for (let i = 0; i < 25; i++) rows.push(vec('accel', i * 1000, 0, 0, 1));
  r.add(rows, HOST);
  const sheets = buildSheets(r.rows, 10);
  assert.deepEqual(sheets.map((s) => [s.name, s.rows.length]), [['ACCEL', 10], ['ACCEL_2', 10], ['ACCEL_3', 5]]);
});

test('export filename is safe for any device id', () => {
  const name = exportFilename('Kiwi board #2', '192.168.1.20', new Date(2026, 0, 2, 3, 4, 5).getTime());
  assert.equal(name, 'Kiwi_board_2_192.168.1.20_20260102_030405.xlsx');
});
