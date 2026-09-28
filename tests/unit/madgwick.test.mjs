import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Madgwick } from '../../plotly-client/kiwi-3d/src/madgwick.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const DT = 0.005;

/** Rotate vector v by unit quaternion q = {w, x, y, z} (sensor → earth). */
function rotate(q, [vx, vy, vz]) {
  const { w, x, y, z } = q;
  return [
    vx * (1 - 2 * (y * y + z * z)) + vy * 2 * (x * y - w * z) + vz * 2 * (x * z + w * y),
    vx * 2 * (x * y + w * z) + vy * (1 - 2 * (x * x + z * z)) + vz * 2 * (y * z - w * x),
    vx * 2 * (x * z - w * y) + vy * 2 * (y * z + w * x) + vz * (1 - 2 * (x * x + y * y)),
  ];
}

function angleDeg(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.min(1, Math.max(-1, dot / (Math.hypot(...a) * Math.hypot(...b))))) * R2D;
}

// A board rolled by `rollDeg` about its x axis, sitting still in a field that
// points north and down (earth frame: x north, z up).
function stillBoard(rollDeg) {
  const r = rollDeg * D2R;
  const earthMag = [300, 0, -500];
  return {
    accel: [0, Math.sin(r), Math.cos(r)],
    mag: [earthMag[0], earthMag[1] * Math.cos(r) + earthMag[2] * Math.sin(r), -earthMag[1] * Math.sin(r) + earthMag[2] * Math.cos(r)],
  };
}

function run(filter, { accel, mag, gyro = [0, 0, 0] }, seconds) {
  for (let i = 0; i < seconds / DT; i++) filter.update(...gyro, ...accel, ...(mag ?? [undefined, undefined, undefined]), DT);
  return filter.getQuaternion();
}

test('a level, still board stays level', () => {
  const q = run(new Madgwick({ beta: 0.5 }), stillBoard(0), 5);
  assert.ok(angleDeg(rotate(q, [0, 0, 1]), [0, 0, 1]) < 0.5);
});

test('converges to the true tilt of a still board (gravity and heading)', () => {
  for (const roll of [15, 30, 60, -45]) {
    const board = stillBoard(roll);
    const q = run(new Madgwick({ beta: 0.5 }), board, 20);
    // Measured gravity maps back onto earth "up".
    assert.ok(angleDeg(rotate(q, board.accel), [0, 0, 1]) < 0.5, `gravity at roll ${roll}`);
    // Measured field maps back onto north-and-down (no heading error).
    assert.ok(angleDeg(rotate(q, board.mag), [300, 0, -500]) < 0.5, `heading at roll ${roll}`);
    // The board's own z axis is tilted by exactly the roll angle.
    assert.ok(Math.abs(angleDeg(rotate(q, [0, 0, 1]), [0, 0, 1]) - Math.abs(roll)) < 0.5, `tilt at roll ${roll}`);
  }
});

test('works without a magnetometer (gravity only)', () => {
  const { accel } = stillBoard(30);
  const q = run(new Madgwick({ beta: 0.5 }), { accel, mag: null }, 20);
  assert.ok(angleDeg(rotate(q, accel), [0, 0, 1]) < 0.5);
});

test('integrates the gyro exactly: 90 °/s about z for 1 s is a 90° turn', () => {
  const q = run(new Madgwick({ beta: 0 }), { accel: [0, 0, 1], mag: null, gyro: [0, 0, 90 * D2R] }, 1);
  const heading = Math.atan2(rotate(q, [1, 0, 0])[1], rotate(q, [1, 0, 0])[0]) * R2D;
  assert.ok(Math.abs(heading - 90) < 0.5, `heading ${heading}`);
});

test('beta is live: 0 ignores the accelerometer, >0 corrects towards it', () => {
  const board = stillBoard(30);
  const f = new Madgwick({ beta: 0 });
  run(f, board, 2);
  assert.deepEqual(f.q, [1, 0, 0, 0]);
  f.beta = 0.5;
  const q = run(f, board, 20);
  assert.ok(angleDeg(rotate(q, board.accel), [0, 0, 1]) < 0.5);
});

test('quaternion stays normalised', () => {
  const f = new Madgwick({ beta: 0.2 });
  run(f, { ...stillBoard(20), gyro: [0.3, -0.2, 0.5] }, 10);
  assert.ok(Math.abs(Math.hypot(...f.q) - 1) < 1e-12);
});

test('initFrom sets the exact attitude from a single still reading', () => {
  for (const roll of [0, 30, -70, 150]) {
    const board = stillBoard(roll);
    const f = new Madgwick();
    f.initFrom(...board.accel, ...board.mag);
    const q = f.getQuaternion();
    assert.ok(angleDeg(rotate(q, board.accel), [0, 0, 1]) < 1e-6, `gravity at roll ${roll}`);
    assert.ok(angleDeg(rotate(q, board.mag), [300, 0, -500]) < 1e-6, `heading at roll ${roll}`);
    // Already converged: further updates only jitter by the filter's fixed
    // normalised step (well under 0.1°).
    const before = f.getQuaternion();
    const after = run(f, board, 2);
    const d = Math.abs(before.w * after.w + before.x * after.x + before.y * after.y + before.z * after.z);
    assert.ok(2 * Math.acos(Math.min(1, d)) * R2D < 0.1);
  }
});

test('initFrom without a magnetometer still levels the board', () => {
  const { accel } = stillBoard(40);
  const f = new Madgwick();
  f.initFrom(...accel);
  assert.ok(angleDeg(rotate(f.getQuaternion(), accel), [0, 0, 1]) < 1e-6);
});
