import { test, expect, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// End-to-end checks of the data itself, against the dummy boards started by
// stack.mjs: 127.0.0.1 and 127.0.0.2 at 50 Hz, 127.0.0.3 rebooting every 6 s,
// 127.0.0.4 / 127.0.0.5 motionless (level / rolled 30°).

const SAMPLE_PERIOD_US = 20_000; // 50 Hz
const REBOOT_EVERY_S = 6;

// SheetJS is a browser UMD bundle; evaluate it in a sandbox to read exports.
function loadXlsx(): any {
  const src = readFileSync(path.join(__dirname, '../../plotly-client/web/xlsx.full.min.js'), 'utf8');
  const ctx: any = {};
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.XLSX;
}

async function waitForData(page: Page) {
  await expect
    .poll(() => page.locator('#accelPlot').evaluate((el: any) => el.data?.[0]?.x?.length ?? 0), { timeout: 10000 })
    .toBeGreaterThan(10);
}

test.describe('Backend contract', () => {
  test('lists every board by IP with its real packet rate', async ({ request }) => {
    const list = async () => (await (await request.get('/devices')).json()) as { id: string; rate: number }[];
    // A newly seen board reports rate 0 until its first full second is counted.
    await expect
      .poll(async () => (await list()).filter((d) => d.rate > 0).length, { timeout: 10000 })
      .toBe(5);
    const devices = await list();
    expect(devices.map((d) => d.id)).toEqual(['127.0.0.1', '127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.5']);
    for (const d of devices) {
      // 4 packets (accel, gyro, mag, baro) × 50 Hz
      expect(d.rate).toBeGreaterThan(150);
      expect(d.rate).toBeLessThan(250);
    }
  });

  test('the dead /events endpoint is gone', async ({ request }) => {
    expect((await request.get('/events')).status()).toBe(404);
  });

  test('each device stream carries only that device, unknown devices get nothing', async ({ page }) => {
    await page.goto('/');
    const counts = await page.evaluate(async () => {
      const listen = (id: string) =>
        new Promise<number>((resolve) => {
          let n = 0;
          const es = new EventSource(`/devices/${id}/events`);
          es.onmessage = () => n++;
          setTimeout(() => (es.close(), resolve(n)), 1500);
        });
      const [a, b, none] = await Promise.all([listen('127.0.0.1'), listen('127.0.0.2'), listen('10.9.9.9')]);
      return { a, b, none };
    });
    expect(counts.a).toBeGreaterThan(5);
    expect(counts.b).toBeGreaterThan(5);
    expect(counts.none).toBe(0);
  });
});

test.describe('Routing', () => {
  test('dashboard without a device goes to the device list', async ({ page }) => {
    await page.goto('/dashboard.html');
    await expect(page).toHaveURL(/\/$/);
  });

  test('3D view without a device goes to the device list', async ({ page }) => {
    await page.goto('/3d/');
    await expect(page).toHaveURL(/\/$/);
  });

  test('the dashboard loads nothing from the internet', async ({ page, baseURL }) => {
    const external: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith(baseURL!) && !u.startsWith('blob:') && !u.startsWith('data:')) external.push(u);
    });
    await page.goto('/dashboard.html?src=127.0.0.1');
    await waitForData(page);
    expect(external).toEqual([]);
    expect(await page.evaluate(() => typeof (window as any).GridStack)).toBe('function');
  });
});

test.describe('Live plots', () => {
  test('time axis is seconds since the page opened, sampled at the board rate', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/dashboard.html?src=127.0.0.1');
    await waitForData(page);
    await page.waitForTimeout(1500);

    const xs: number[] = await page.locator('#accelPlot').evaluate((el: any) => el.data[0].x);
    // Before the fix, a board up > 26.7 min plotted ~1e9 s here.
    expect(Math.max(...xs)).toBeLessThan(60);
    const steps = xs.slice(1).map((x, i) => x - xs[i]);
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(0);
    const median = steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)];
    // The simulated board's timer jitters by a few ms on Windows; allow ±25 %.
    expect(median).toBeGreaterThan((SAMPLE_PERIOD_US / 1e6) * 0.75);
    expect(median).toBeLessThan((SAMPLE_PERIOD_US / 1e6) * 1.25);
    expect(errors).toEqual([]);
  });

  test('a board reboot is detected and the plot restarts cleanly', async ({ page }) => {
    await page.goto('/dashboard.html?src=127.0.0.3');
    await waitForData(page);
    await expect(page.locator('#connText')).toContainText('device restarted', { timeout: (REBOOT_EVERY_S + 4) * 1000 });
    await page.waitForTimeout(1000);
    const xs: number[] = await page.locator('#accelPlot').evaluate((el: any) => el.data[0].x);
    expect(Math.max(...xs)).toBeLessThan(REBOOT_EVERY_S + 1);
  });
});

test.describe('Recording and Excel export', () => {
  test('recording is complete and exact even when the page stops rendering', async ({ page }) => {
    test.setTimeout(45000);
    await page.goto('/dashboard.html?src=127.0.0.1');
    await waitForData(page);

    // Independent reference: every accel timestamp the server sends to this page.
    await page.evaluate(() => {
      const w = window as any;
      w.__ref = [] as number[];
      const es = new EventSource('/devices/127.0.0.1/events');
      es.onmessage = (e) => {
        for (const m of JSON.parse(e.data)) if (m.measurement.Accel) w.__ref.push(m.timestamp);
      };
    });
    await page.waitForTimeout(500);

    await page.locator('#recordBtn').click();
    // Stop the render loop, as a background tab or minimised window does.
    await page.evaluate(() => {
      (window as any).requestAnimationFrame = () => 0;
    });
    await page.waitForTimeout(4000);
    await page.locator('#stopBtn').click();
    const reference: number[] = await page.evaluate(() => (window as any).__ref);

    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#exportBtn').click()]);
    expect(download.suggestedFilename()).toMatch(/^kiwi_127\.0\.0\.1_\d{8}_\d{6}\.xlsx$/);

    const XLSX = loadXlsx();
    const wb = XLSX.read(new Uint8Array(readFileSync((await download.path())!)), { type: 'array' });
    expect(wb.SheetNames).toEqual(['ACCEL', 'GYRO', 'MAG', 'BARO']);
    const sheet = (name: string) => XLSX.utils.sheet_to_json(wb.Sheets[name]) as any[];

    const accel = sheet('ACCEL');
    // ~4 s at 50 Hz.
    expect(accel.length).toBeGreaterThan(150);
    const t = accel.map((r) => r.device_time_us);
    expect(t.slice(1).every((v, i) => v > t[i])).toBe(true);
    // Complete: every sample the server sent during the recording is in the file.
    const recorded = new Set(t);
    const expected = reference.filter((ts) => ts >= t[0] && ts <= t.at(-1));
    expect(expected.length).toBeGreaterThan(150);
    expect(expected.filter((ts) => !recorded.has(ts))).toEqual([]);
    // elapsed_s shares one origin across all sheets: the first sample of any sensor.
    expect(accel[0].elapsed_s).toBeGreaterThanOrEqual(0);
    expect(accel[0].elapsed_s).toBeLessThan(0.1);
    expect(accel.at(-1).elapsed_s - accel[0].elapsed_s).toBeCloseTo((t.at(-1) - t[0]) / 1e6, 6);

    for (const r of accel) {
      const m = Math.hypot(r['x (g)'], r['y (g)'], r['z (g)']);
      expect(r['magnitude (g)']).toBeCloseTo(m, 5);
    }
    expect(Object.keys(sheet('GYRO')[0])).toContain('x (deg/s)');
    expect(Object.keys(sheet('MAG')[0])).toContain('magnitude (mG)');

    const baro = sheet('BARO');
    expect(baro.length).toBeGreaterThan(150);
    for (const r of baro) {
      const p = r['pressure (hPa)'];
      expect(p).toBeGreaterThan(990);
      expect(p).toBeLessThan(1040);
      const alt = 44330 * (1 - Math.pow(p / 1013.25, 1 / 5.255));
      expect(Math.abs(r['altitude (m)'] - alt)).toBeLessThan(0.5);
      expect(r['temp (°C)']).toBeGreaterThan(20);
    }
  });
});
