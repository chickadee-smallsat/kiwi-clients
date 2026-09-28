// Madgwick orientation filter (S. Madgwick, "An efficient orientation filter
// for inertial and inertial/magnetic sensor arrays", 2010).
//
// The quaternion q = [w, x, y, z] rotates sensor-frame vectors into the earth
// frame (z up). Each update integrates the gyro rate and takes one normalised
// gradient-descent step of size `beta` towards the attitude that best explains
// the measured gravity (and, when given, the magnetic field).
//
// Written in matrix form (residual f, Jacobian J, step s = Jᵀ f) so each row
// can be checked against the paper.

export class Madgwick {
  /**
   * @param {{ beta?: number, sampleIntervalMs?: number }} [options]
   */
  constructor({ beta = 0.1, sampleIntervalMs = 5 } = {}) {
    this.beta = beta;
    this.dt = sampleIntervalMs / 1000;
    this.q = [1, 0, 0, 0];
  }

  /**
   * Set the orientation directly from one still reading, so the filter starts
   * at the right attitude instead of converging from identity. Earth frame:
   * z up, x along the horizontal part of the field (magnetic north).
   */
  initFrom(ax, ay, az, mx, my, mz) {
    const up = unit([ax, ay, az]);
    if (!up) return;
    let north = mx === undefined ? null : unit([mx, my, mz]);
    // Without a usable field, pick any horizontal reference.
    if (!north || Math.abs(dot(north, up)) > 0.99) north = Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const west = unit(cross(up, north));
    const northH = cross(west, up);
    // Rows are the earth axes expressed in the sensor frame: R maps sensor → earth.
    this.q = quatFromRows(northH, west, up);
  }

  /** @returns {{ w: number, x: number, y: number, z: number }} */
  getQuaternion() {
    const [w, x, y, z] = this.q;
    return { w, x, y, z };
  }

  /**
   * Gyro in rad/s. Accel and mag in any unit (only their direction is used).
   * Pass mag as undefined (or all zero) for the gravity-only variant.
   */
  update(gx, gy, gz, ax, ay, az, mx, my, mz, dt = this.dt) {
    const [q0, q1, q2, q3] = this.q;

    // Rate of change from the gyro: q̇ = ½ q ⊗ (0, ω).
    let d0 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz);
    let d1 = 0.5 * (q0 * gx + q2 * gz - q3 * gy);
    let d2 = 0.5 * (q0 * gy - q1 * gz + q3 * gx);
    let d3 = 0.5 * (q0 * gz + q1 * gy - q2 * gx);

    const aNorm = Math.hypot(ax, ay, az);
    if (aNorm > 0 && this.beta > 0) {
      ax /= aNorm;
      ay /= aNorm;
      az /= aNorm;

      // Gravity: predicted earth z in the sensor frame minus the measurement.
      const f = [2 * (q1 * q3 - q0 * q2) - ax, 2 * (q0 * q1 + q2 * q3) - ay, 2 * (0.5 - q1 * q1 - q2 * q2) - az];
      const J = [
        [-2 * q2, 2 * q3, -2 * q0, 2 * q1],
        [2 * q1, 2 * q0, 2 * q3, 2 * q2],
        [0, -4 * q1, -4 * q2, 0],
      ];

      const mNorm = mx === undefined ? 0 : Math.hypot(mx, my, mz);
      if (mNorm > 0) {
        mx /= mNorm;
        my /= mNorm;
        mz /= mNorm;

        // Reference field b = (bx, 0, bz): the measured field in the earth
        // frame, with its horizontal part rotated onto the x axis.
        const hx = mx * (1 - 2 * (q2 * q2 + q3 * q3)) + my * 2 * (q1 * q2 - q0 * q3) + mz * 2 * (q1 * q3 + q0 * q2);
        const hy = mx * 2 * (q1 * q2 + q0 * q3) + my * (1 - 2 * (q1 * q1 + q3 * q3)) + mz * 2 * (q2 * q3 - q0 * q1);
        const bz = mx * 2 * (q1 * q3 - q0 * q2) + my * 2 * (q2 * q3 + q0 * q1) + mz * (1 - 2 * (q1 * q1 + q2 * q2));
        const bx = Math.hypot(hx, hy);

        f.push(
          2 * bx * (0.5 - q2 * q2 - q3 * q3) + 2 * bz * (q1 * q3 - q0 * q2) - mx,
          2 * bx * (q1 * q2 - q0 * q3) + 2 * bz * (q0 * q1 + q2 * q3) - my,
          2 * bx * (q0 * q2 + q1 * q3) + 2 * bz * (0.5 - q1 * q1 - q2 * q2) - mz,
        );
        J.push(
          [-2 * bz * q2, 2 * bz * q3, -4 * bx * q2 - 2 * bz * q0, -4 * bx * q3 + 2 * bz * q1],
          [-2 * bx * q3 + 2 * bz * q1, 2 * bx * q2 + 2 * bz * q0, 2 * bx * q1 + 2 * bz * q3, -2 * bx * q0 + 2 * bz * q2],
          [2 * bx * q2, 2 * bx * q3 - 4 * bz * q1, 2 * bx * q0 - 4 * bz * q2, 2 * bx * q1],
        );
      }

      // Step direction s = Jᵀ f, normalised, scaled by beta.
      const s = [0, 0, 0, 0];
      for (let r = 0; r < f.length; r++) {
        for (let c = 0; c < 4; c++) s[c] += J[r][c] * f[r];
      }
      const sNorm = Math.hypot(...s);
      if (sNorm > 0) {
        d0 -= (this.beta * s[0]) / sNorm;
        d1 -= (this.beta * s[1]) / sNorm;
        d2 -= (this.beta * s[2]) / sNorm;
        d3 -= (this.beta * s[3]) / sNorm;
      }
    }

    const n = [q0 + d0 * dt, q1 + d1 * dt, q2 + d2 * dt, q3 + d3 * dt];
    const qNorm = Math.hypot(...n);
    this.q = n.map((v) => v / qNorm);
  }
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(v) {
  const n = Math.hypot(...v);
  return n > 0 ? v.map((c) => c / n) : null;
}

/** Quaternion [w, x, y, z] of the rotation matrix with the given rows. */
function quatFromRows([m00, m01, m02], [m10, m11, m12], [m20, m21, m22]) {
  const trace = m00 + m11 + m22;
  let w, x, y, z;
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    [w, x, y, z] = [s / 4, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    [w, x, y, z] = [(m21 - m12) / s, s / 4, (m01 + m10) / s, (m02 + m20) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    [w, x, y, z] = [(m02 - m20) / s, (m01 + m10) / s, s / 4, (m12 + m21) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    [w, x, y, z] = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, s / 4];
  }
  return [w, x, y, z];
}
