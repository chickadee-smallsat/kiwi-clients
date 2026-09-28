import { test, expect, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Field-by-field correctness. Every expected value is computed here from
// physics (the still boards' known tilt, field and pressure) or from the raw
// SSE stream, never from the app's own code.
//
// Boards (see stack.mjs): 127.0.0.4 still and level, 127.0.0.5 still and
// rolled 30° about x, 127.0.0.1 moving.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const f32 = (v: number) => Math.fround(v);

/** What a motionless board rolled by `roll` degrees reports (as float32, like the firmware). */
function stillBoard(roll: number) {
  const s = Math.sin(roll * D2R);
  const c = Math.cos(roll * D2R);
  const accel = [0, f32(s), f32(c)];
  const mag = [300, f32(-500 * s), f32(-500 * c)];
  const pressure = 1000;
  const altitude = f32(44330 * (1 - Math.pow(pressure / 1013.25, 1 / 5.255)));
  return { accel, gyro: [0, 0, 0], mag, temp: 21.5, pressure, altitude };
}

const TILTED = stillBoard(30);
const LEVEL = stillBoard(0);
const norm = (v: number[]) => Math.hypot(...v);

async function openMenu(page: Page) {
  await page.locator('summary[aria-label="Open dashboard menu"]').click();
}

async function dashboard(page: Page, id: string) {
  await page.goto(`/dashboard.html?src=${id}`);
  await expect.poll(() => page.locator('#accelPlot').evaluate((el: any) => el.data?.[0]?.x?.length ?? 0), { timeout: 10000 }).toBeGreaterThan(20);
}

function loadXlsx(): any {
  const ctx: any = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(__dirname, '../../plotly-client/web/xlsx.full.min.js'), 'utf8'), ctx);
  return ctx.XLSX;
}

// ─── Device list ─────────────────────────────────────────────────────────────

test.describe('Device list fields', () => {
  test('every row shows the board IP and the rate the server reports', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('#deviceList tr')).toHaveCount(5, { timeout: 10000 });
    await page.waitForTimeout(1500); // let rates settle past the first second

    const api: { id: string; rate: number }[] = await (await request.get('/devices')).json();
    await expect(page.locator('#deviceCount')).toHaveText(String(api.length));

    const rows = page.locator('#deviceList tr');
    for (let i = 0; i < api.length; i++) {
      await expect(rows.nth(i).locator('.deviceName')).toHaveText(api[i].id);
      const shown = Number((await rows.nth(i).locator('.rateNum').textContent())!.replace(/\D/g, ''));
      expect(Math.abs(shown - api[i].rate), `rate of ${api[i].id}`).toBeLessThanOrEqual(30);
      const bar = await rows.nth(i).locator('.rateBar > span').evaluate((el) => parseFloat((el as HTMLElement).style.width));
      expect(bar).toBeCloseTo(Math.min(100, (shown / 250) * 100), 0);
    }
  });

  test('filter narrows the list to matching IPs', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#deviceList tr')).toHaveCount(5, { timeout: 10000 });
    await page.locator('#deviceSearch').fill('127.0.0.5');
    await expect(page.locator('#deviceList tr:visible')).toHaveCount(1);
    await expect(page.locator('#deviceList tr:visible .deviceName')).toHaveText('127.0.0.5');
  });
});

// ─── Dashboard: exact values from a still board ─────────────────────────────

test.describe('Dashboard fields (still board rolled 30°)', () => {
  test('header shows the device, live status and a current packet time', async ({ page }) => {
    await dashboard(page, '127.0.0.5');
    await expect(page.locator('#boardName')).toHaveText('127.0.0.5');
    await expect(page).toHaveTitle('Kiwi · 127.0.0.5');
    await expect(page.locator('#connText')).toHaveText('Live');
    await expect(page.locator('#connPill')).toHaveAttribute('data-state', 'ok');
    const shown = (await page.locator('#lastSeen').textContent())!;
    const [h, m, s] = shown.split(':').map(Number);
    const now = new Date();
    const diff = Math.abs(now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() - (h * 3600 + m * 60 + s));
    expect(diff).toBeLessThanOrEqual(3);
  });

  test('value tiles show the exact magnitudes and readings', async ({ page }) => {
    await dashboard(page, '127.0.0.5');
    await expect(page.locator('#kpi-accel')).toHaveText(norm(TILTED.accel).toFixed(3));
    await expect(page.locator('#kpi-gyro')).toHaveText((0).toFixed(2));
    await expect(page.locator('#kpi-mag')).toHaveText(norm(TILTED.mag).toFixed(1));
    await expect(page.locator('#kpi-temp')).toHaveText(TILTED.temp.toFixed(2));
    await expect(page.locator('#kpi-pressure')).toHaveText(TILTED.pressure.toFixed(2));
    await expect(page.locator('#kpi-altitude')).toHaveText(TILTED.altitude.toFixed(1));

    const axes = (v: number[], d: number) => `x ${v[0].toFixed(d)} · y ${v[1].toFixed(d)} · z ${v[2].toFixed(d)}`;
    await expect(page.locator('#kpi-accel-xyz')).toHaveText(axes(TILTED.accel, 3));
    await expect(page.locator('#kpi-gyro-xyz')).toHaveText(axes(TILTED.gyro, 2));
    await expect(page.locator('#kpi-mag-xyz')).toHaveText(axes(TILTED.mag, 1));
  });

  test('every plotted point equals the board readings, with correct units', async ({ page }) => {
    await dashboard(page, '127.0.0.5');
    const plots = await page.evaluate(() => {
      const grab = (id: string) => {
        const el: any = document.getElementById(id);
        return { traces: el.data.map((t: any) => ({ name: t.name, x: Array.from(t.x), y: Array.from(t.y) })), yTitle: el.layout.yaxis.title.text, xTitle: el.layout.xaxis.title.text };
      };
      return { accel: grab('accelPlot'), gyro: grab('gyroPlot'), mag: grab('magPlot'), temp: grab('tempPlot'), pressure: grab('pressurePlot'), altitude: grab('altitudePlot') };
    });

    const expectVector = (p: any, v: number[], unit: string) => {
      expect(p.yTitle).toContain(`(${unit})`);
      expect(p.xTitle).toBe('Time (s)');
      expect(p.traces.map((t: any) => t.name)).toEqual(['X', 'Y', 'Z', '|R|']);
      const [xs, ys, zs, rs] = p.traces;
      expect(xs.y.length).toBeGreaterThan(20);
      for (let i = 0; i < xs.y.length; i++) {
        expect(xs.y[i]).toBeCloseTo(v[0], 5);
        expect(ys.y[i]).toBeCloseTo(v[1], 5);
        expect(zs.y[i]).toBeCloseTo(v[2], 5);
        expect(rs.y[i]).toBeCloseTo(norm(v), 4);
      }
      // Time axis: increasing, in seconds, ~20 ms apart at 50 Hz.
      const t = xs.x as number[];
      expect(t.every((x, i) => i === 0 || x >= t[i - 1])).toBe(true);
    };
    expectVector(plots.accel, TILTED.accel, 'g');
    expectVector(plots.gyro, TILTED.gyro, '°/s');
    expectVector(plots.mag, TILTED.mag, 'mG');

    for (const [key, unit] of [['temp', '°C'], ['pressure', 'hPa'], ['altitude', 'm']] as const) {
      const p = plots[key];
      expect(p.yTitle).toContain(`(${unit})`);
      expect(p.traces).toHaveLength(1);
      for (const y of p.traces[0].y) expect(y).toBeCloseTo(TILTED[key], 3);
    }
  });

  test('live values panel shows the accelerometer vector and its angles', async ({ page }) => {
    await dashboard(page, '127.0.0.5');
    await openMenu(page);
    await page.locator('#liveValuesToggle').check();
    // Escape closes the menu even while the checkbox inside it has focus.
    await page.keyboard.press('Escape');
    await expect(page.locator('#topMenu')).toHaveJSProperty('open', false);
    const [x, y, z] = TILTED.accel;
    await expect(page.locator('#x')).toHaveText(x.toFixed(3));
    await expect(page.locator('#y')).toHaveText(y.toFixed(3));
    await expect(page.locator('#z')).toHaveText(z.toFixed(3));
    await expect(page.locator('#mag')).toHaveText(norm(TILTED.accel).toFixed(3));
    await expect(page.locator('#theta')).toHaveText((Math.atan2(Math.hypot(x, y), z) * R2D).toFixed(1)); // 30.0 from vertical
    await expect(page.locator('#phi')).toHaveText((Math.atan2(y, x) * R2D).toFixed(1)); // 90.0
    await expect(page.locator('#t')).toHaveText(/^\d+\.\d{3} s$/);
  });

  test('attitude indicator reads 30° roll and 0° pitch', async ({ page }) => {
    test.setTimeout(60000); // loads two dashboards
    await dashboard(page, '127.0.0.5');
    await openMenu(page);
    await page.locator('#horizonToggle').check();
    await page.keyboard.press('Escape');
    await expect(page.locator('#horizonRoll')).toHaveText('30.0°');
    await expect(page.locator('#horizonPitch')).toHaveText('0.0°');
    // A level board reads 0 / 0 (the panel toggle is remembered per device).
    await dashboard(page, '127.0.0.4');
    await openMenu(page);
    await page.locator('#horizonToggle').check();
    await page.keyboard.press('Escape');
    expect(norm(LEVEL.accel)).toBeCloseTo(1, 6);
    await expect(page.locator('#horizonRoll')).toHaveText('0.0°');
    await expect(page.locator('#horizonPitch')).toHaveText('0.0°');
  });

  test('window diagnostic counts the samples in the plotted window', async ({ page }) => {
    // ~12 s of deliberate waiting plus eight clicks; with the embedded 3D view
    // rendering on the CPU-only test browser each click takes a few seconds.
    test.setTimeout(90000);
    await dashboard(page, '127.0.0.5');
    for (const windowSec of [2, 5]) {
      await openMenu(page); // clicking Pause below closes it again
      await page.locator('#windowSec').fill(String(windowSec));
      await page.locator('#windowSec').press('Enter');
      await page.waitForTimeout(windowSec * 1000 + 1500); // fill the window, let it resync
      await page.locator('#pauseBtn').click(); // hold still while reading
      await page.waitForTimeout(1200); // one more resync on the held data
      const { span, inWindow, shown } = await page.evaluate((w) => {
        const x: number[] = (document.getElementById('accelPlot') as any).data[0].x;
        const latest = x[x.length - 1];
        return {
          span: latest - x[0],
          inWindow: x.filter((t) => t >= latest - w).length,
          shown: Number(document.getElementById('windowPoints')!.textContent),
        };
      }, windowSec);
      // The plot holds exactly the configured window …
      expect(span).toBeGreaterThan(windowSec - 0.15);
      expect(span).toBeLessThanOrEqual(windowSec + 0.001);
      // … and the diagnostic reports the samples in it.
      expect(shown).toBe(inWindow);
      await page.locator('#pauseBtn').click();
    }
  });

  test('pause freezes the plots and resume continues them', async ({ page }) => {
    await dashboard(page, '127.0.0.5');
    const last = () => page.locator('#accelPlot').evaluate((el: any) => el.data[0].x.at(-1));
    await page.locator('#pauseBtn').click();
    const frozen = await last();
    await page.waitForTimeout(1000);
    expect(await last()).toBe(frozen);
    await page.locator('#pauseBtn').click();
    await expect.poll(last, { timeout: 5000 }).toBeGreaterThan(frozen);
  });

  test('recorded count, timer and exported rows agree', async ({ page }) => {
    test.setTimeout(45000);
    await dashboard(page, '127.0.0.5');
    await page.locator('#recordBtn').click();
    await expect(page.locator('#recChip')).toBeVisible();
    await page.waitForTimeout(3200);
    await expect(page.locator('#recTimer')).toHaveText(/^00:0[3-5]$/);
    await page.locator('#stopBtn').click();
    await expect(page.locator('#recChip')).toBeHidden();

    const recorded = Number((await page.locator('#recCount').textContent())!.replace(/,/g, ''));
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#exportBtn').click()]);
    const XLSX = loadXlsx();
    const wb = XLSX.read(new Uint8Array(readFileSync((await download.path())!)), { type: 'array' });
    const rows = (n: string) => XLSX.utils.sheet_to_json(wb.Sheets[n]) as any[];
    // Each Baro packet is recorded as three samples but exported as one row.
    const total = rows('ACCEL').length + rows('GYRO').length + rows('MAG').length + 3 * rows('BARO').length;
    expect(total).toBe(recorded);

    const a = rows('ACCEL')[0];
    expect(a['y (g)']).toBeCloseTo(TILTED.accel[1], 6);
    expect(a['magnitude (g)']).toBeCloseTo(norm(TILTED.accel), 6);
    expect(rows('BARO')[0]['altitude (m)']).toBeCloseTo(TILTED.altitude, 3);
  });
});

// ─── Dashboard: graphs match the raw stream for a moving board ──────────────

test('every plotted point of a moving board matches the raw data stream', async ({ page }) => {
  await page.goto('/dashboard.html?src=127.0.0.1');
  // Independent reference stream opened alongside the dashboard.
  await page.evaluate(() => {
    const w = window as any;
    w.__raw = new Map();
    const es = new EventSource('/devices/127.0.0.1/events');
    es.onmessage = (e) => {
      for (const m of JSON.parse(e.data)) if (m.measurement.Accel) w.__raw.set(m.timestamp, m.measurement.Accel);
    };
  });
  await page.waitForTimeout(3500);
  await page.locator('#pauseBtn').click(); // hold the plot still while we read it

  const result = await page.evaluate(() => {
    const raw: Map<number, number[]> = (window as any).__raw;
    const el: any = document.getElementById('accelPlot');
    const [X, Y, Z, R] = el.data;
    // Recover the plot's time origin from one point whose value appears in the raw stream.
    let origin: number | null = null;
    for (let i = X.x.length - 1; i >= 0 && origin === null; i--) {
      for (const [t, v] of raw) {
        if (v[0] === X.y[i] && v[1] === Y.y[i] && v[2] === Z.y[i]) {
          origin = t - Math.round(X.x[i] * 1e6);
          break;
        }
      }
    }
    if (origin === null) return { error: 'no overlap' };
    const firstRaw = Math.min(...raw.keys());
    let checked = 0;
    const mismatches: string[] = [];
    for (let i = 0; i < X.x.length; i++) {
      const t = origin + Math.round(X.x[i] * 1e6);
      if (t < firstRaw) continue; // plotted before the reference stream opened
      const v = raw.get(t);
      checked++;
      if (!v) mismatches.push(`no raw sample at ${t}`);
      else if (v[0] !== X.y[i] || v[1] !== Y.y[i] || v[2] !== Z.y[i] || Math.abs(Math.hypot(...v) - R.y[i]) > 1e-9) mismatches.push(`value at ${t}`);
    }
    return { checked, mismatches: mismatches.slice(0, 5) };
  });

  expect(result.error).toBeUndefined();
  expect(result.checked).toBeGreaterThan(50);
  expect(result.mismatches).toEqual([]);
});

// ─── 3D view ─────────────────────────────────────────────────────────────────

function quatAngleDeg(a: number[], b: number[]) {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, dot)) * R2D;
}

async function settledModelQuat(page: Page, id: string) {
  await page.goto(`/3d/?src=${id}`);
  await page.waitForFunction(() => (window as any).kiwi3d?.modelQuaternion(), null, { timeout: 15000 });
  // The filter starts from the first reading; give it a few seconds of live
  // updates to prove it stays there.
  await page.waitForTimeout(5000);
  return page.evaluate(() => (window as any).kiwi3d.modelQuaternion());
}

test.describe('3D view fields', () => {
  test('readout and gauges show the exact board values', async ({ page }) => {
    await page.goto('/3d/?src=127.0.0.5');
    const vals = page.locator('.hudVal');
    const fmt = (v: number[], d: number) => v.map((n) => n.toFixed(d)).join('  ');
    await expect(vals.nth(0)).toHaveText(fmt(TILTED.accel, 3));
    await expect(vals.nth(1)).toHaveText(fmt(TILTED.gyro, 2));
    await expect(vals.nth(2)).toHaveText(fmt(TILTED.mag, 1));
    await expect(page.locator('.gaugeValue')).toHaveText([TILTED.temp.toFixed(2), TILTED.pressure.toFixed(1), TILTED.altitude.toFixed(1)]);
  });

  test('the fused orientation explains the measured gravity', async ({ page }) => {
    test.setTimeout(40000);
    await settledModelQuat(page, '127.0.0.5');
    const err = await page.evaluate(() => {
      const q = (window as any).kiwi3d.fusionQuaternion();
      const { accel } = (window as any).kiwi3d.latest();
      // The 3D view remaps sensor axes (x, z, -y) before fusion.
      const a = [accel.x, accel.z, -accel.y];
      const { w, x, y, z } = q;
      const up = [
        a[0] * (1 - 2 * (y * y + z * z)) + a[1] * 2 * (x * y - w * z) + a[2] * 2 * (x * z + w * y),
        a[0] * 2 * (x * y + w * z) + a[1] * (1 - 2 * (x * x + z * z)) + a[2] * 2 * (y * z - w * x),
        a[0] * 2 * (x * z - w * y) + a[1] * 2 * (y * z + w * x) + a[2] * (1 - 2 * (x * x + y * y)),
      ];
      return (Math.acos(up[2] / Math.hypot(...up)) * 180) / Math.PI;
    });
    expect(err).toBeLessThan(2);
  });

  test('the model is rotated by exactly the tilt between a level and a 30° board', async ({ browser }) => {
    test.setTimeout(60000);
    const [a, b] = await Promise.all(
      ['127.0.0.4', '127.0.0.5'].map(async (id) => settledModelQuat(await browser.newPage(), id)),
    );
    expect(Math.abs(quatAngleDeg(a, b) - 30)).toBeLessThan(2);
  });

  test('the filter gain slider really changes the filter', async ({ page }) => {
    await page.goto('/3d/?src=127.0.0.5');
    await page.waitForFunction(() => (window as any).kiwi3d);
    expect(await page.evaluate(() => (window as any).kiwi3d.beta())).toBeCloseTo(0.08, 5);
    await page.locator('.hudSlider input').fill('0.2');
    await expect.poll(() => page.evaluate(() => (window as any).kiwi3d.beta())).toBeCloseTo(0.2, 5);
    await expect(page.locator('.hudSlider .hudVal')).toHaveText('0.20');
  });

  test('freeze holds the model still; reset re-levels it', async ({ page }) => {
    // The full-window WebGL page renders at ~5 fps on the CPU-only test
    // browser, and every click waits for stable frames: allow for it.
    test.setTimeout(90000);
    await settledModelQuat(page, '127.0.0.5');
    const q = () => page.evaluate(() => (window as any).kiwi3d.modelQuaternion());

    await page.getByRole('button', { name: 'Freeze' }).click();
    await expect(page.locator('.hudBadge')).toHaveText('FROZEN');
    const held = await q();
    await page.waitForTimeout(1000);
    expect(quatAngleDeg(held, await q())).toBeLessThan(0.01);
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(page.locator('.hudBadge')).toHaveText('LIVE');

    // Reset makes the current attitude the reference; pressing it again must
    // not compound the offset.
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: 'Reset orientation' }).click();
      await expect.poll(async () => quatAngleDeg(await q(), [0, 0, 0, 1]), { timeout: 5000 }).toBeLessThan(2);
    }
    await expect(page.locator('.hudVal').nth(4)).toHaveText(/^\d+\.\d Hz$/);
  });

  test('the embedded 3D panel shows the attitude instead of repeating the gauges', async ({ page }) => {
    await page.goto('/dashboard.html?src=127.0.0.5');
    const frame = page.frameLocator('#imu3dFrame');
    const deg = /^-?\d+\.\d°$/;
    await expect(frame.locator('.attitudeVal')).toHaveText([deg, deg, deg], { timeout: 10000 });
    await expect(frame.locator('.gaugeValue')).toHaveCount(0);
  });
});
