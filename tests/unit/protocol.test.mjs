import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeMeasurement,
  decodeBatch,
  SessionClock,
  anglesDeg,
  tiltDeg,
  magnitude,
  UNITS,
} from '../../plotly-client/web/kiwi-protocol.js';

test('decodes vector sensors with raw sensor-frame values', () => {
  assert.deepEqual(decodeMeasurement({ measurement: { Accel: [0.1, -0.2, 0.98] }, timestamp: 5 }), [
    { sensor: 'accel', t_us: 5, x: 0.1, y: -0.2, z: 0.98 },
  ]);
  assert.equal(decodeMeasurement({ measurement: { Gyro: [1, 2, 3] }, timestamp: 1 })[0].sensor, 'gyro');
  assert.equal(decodeMeasurement({ measurement: { Mag: [1, 2, 3] }, timestamp: 1 })[0].sensor, 'mag');
});

test('splits Baro into temp, pressure and altitude with the same timestamp', () => {
  const out = decodeMeasurement({ measurement: { Baro: [24.5, 1013.25, 12.0] }, timestamp: 42 });
  assert.deepEqual(out, [
    { sensor: 'temp', t_us: 42, value: 24.5 },
    { sensor: 'pressure', t_us: 42, value: 1013.25 },
    { sensor: 'altitude', t_us: 42, value: 12.0 },
  ]);
});

test('decodes the other firmware variants instead of dropping them', () => {
  assert.deepEqual(decodeMeasurement({ measurement: { Temp: ['cpu', 41.5] }, timestamp: 1 }), [
    { sensor: 'probe_temp', t_us: 1, value: 41.5, label: 'cpu' },
  ]);
  assert.deepEqual(
    decodeMeasurement({ measurement: { Humi: [22, 45, 30] }, timestamp: 1 }).map((s) => s.sensor),
    ['humi_temp', 'humidity', 'aqi'],
  );
  assert.equal(decodeMeasurement({ measurement: { Lux: ['amb', 300] }, timestamp: 1 })[0].sensor, 'lux');
  for (const s of ['probe_temp', 'humi_temp', 'humidity', 'aqi', 'lux']) assert.ok(UNITS[s], s);
});

test('rejects malformed measurements', () => {
  for (const bad of [
    null,
    {},
    { measurement: { Accel: [1, 2] }, timestamp: 1 },
    { measurement: { Accel: [1, 'x', 3] }, timestamp: 1 },
    { measurement: { Accel: [1, 2, 3] } },
    { measurement: { Accel: [1, 2, 3] }, timestamp: -1 },
    { measurement: { Accel: [1, 2, 3], Gyro: [1, 2, 3] }, timestamp: 1 },
    { measurement: { Unknown: [1, 2, 3] }, timestamp: 1 },
  ]) {
    assert.deepEqual(decodeMeasurement(bad), [], JSON.stringify(bad));
  }
  assert.deepEqual(decodeBatch('not json'), []);
});

test('decodes a backend batch exactly as the server sends it', () => {
  const text =
    '[{"measurement":{"Gyro":[0.06687057,-0.2408907,0.0]},"timestamp":3965479},' +
    '{"measurement":{"Baro":[26.99186,1019.6362,1251.1578]},"timestamp":3965479}]';
  const out = decodeBatch(text);
  assert.equal(out.length, 4);
  assert.equal(out[0].x, 0.06687057);
});

test('timestamps stay correct long after the old 26.7-minute failure point', () => {
  // Regression: values above 1.6e9 µs used to be read as Unix seconds.
  for (const uptimeS of [10, 1599, 1601, 3600, 86_400, 30 * 86_400]) {
    const clock = new SessionClock();
    const t0 = uptimeS * 1e6;
    assert.equal(clock.update(t0).t_s, 0);
    assert.equal(clock.update(t0 + 20_000).t_s, 0.02, `at uptime ${uptimeS}s`);
    assert.equal(clock.update(t0 + 1_000_000).t_s, 1, `at uptime ${uptimeS}s`);
  }
});

test('a board reboot starts a new session instead of corrupting the time axis', () => {
  const clock = new SessionClock();
  clock.update(5_000_000);
  clock.update(6_000_000);
  const r = clock.update(20_000); // clock restarted
  assert.equal(r.reset, true);
  assert.equal(r.t_s, 0);
  assert.equal(clock.session, 1);
  assert.equal(clock.update(1_020_000).t_s, 1);
});

test('small reordering inside a batch is not mistaken for a reboot', () => {
  const clock = new SessionClock();
  clock.update(10_000_000);
  const r = clock.update(9_990_000);
  assert.equal(r.reset, false);
});

test('vector math', () => {
  assert.equal(magnitude(3, 4, 12), 13);
  const up = anglesDeg(0, 0, 1);
  assert.equal(up.theta_deg, 0);
  const { roll, pitch } = tiltDeg(0, 0, 1);
  assert.equal(roll, 0);
  assert.equal(Math.abs(pitch), 0);
  assert.ok(Math.abs(tiltDeg(0, 1, 0).roll - 90) < 1e-9);
});
