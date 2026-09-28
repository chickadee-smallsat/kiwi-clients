import { test, expect } from '@playwright/test';
import { spawn, ChildProcess } from 'node:child_process';
import dgram from 'node:dgram';
import path from 'node:path';

// Lifecycle and robustness scenarios with real simulated boards started by the
// test itself (addresses 127.0.0.6–127.0.0.9 are reserved for this file).

const UDP_PORT = 18099; // see stack.mjs
const exe = (name: string) => path.join(__dirname, '../../target/debug', process.platform === 'win32' ? `${name}.exe` : name);
const DUMMY = exe('udp-dummy-server');

const boards: ChildProcess[] = [];

function startBoard(bind: string, ...extra: string[]) {
  return startProcess(DUMMY, ['-p', String(UDP_PORT), '-a', '127.0.0.1', '--bind', bind, ...extra]);
}

function startProcess(file: string, args: string[]) {
  const child = spawn(file, args, { stdio: 'ignore' });
  boards.push(child);
  return child;
}

async function stopBoard(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return; // already exited
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
}

test.afterEach(async () => {
  await Promise.all(boards.splice(0).map(stopBoard));
});

async function deviceIds(request: import('@playwright/test').APIRequestContext) {
  const list: { id: string; rate: number }[] = await (await request.get('/devices')).json();
  return list;
}

test('a board that starts after the page is open, restarts on a new port and reconnects', async ({ page, request }) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Page first, board later.
  await page.goto('/dashboard.html?src=127.0.0.7');
  await expect(page.locator('#connText')).toHaveText('Live'); // the stream opens before any data
  expect(await page.locator('#accelPlot').evaluate((el: any) => el.data[0].x.length)).toBe(0);

  let board = startBoard('127.0.0.7');
  await expect.poll(() => page.locator('#accelPlot').evaluate((el: any) => el.data[0].x.length), { timeout: 10000 }).toBeGreaterThan(10);

  // Disconnect: the device times out of the list and the page says data stopped.
  await stopBoard(board);
  await expect(page.locator('#connText')).toHaveText(/^No data for \d+ s$/, { timeout: 5000 });
  await expect.poll(async () => (await deviceIds(request)).some((d) => d.id === '127.0.0.7'), { timeout: 8000 }).toBe(false);

  // Reconnect from a new ephemeral source port: same device, same dashboard.
  board = startBoard('127.0.0.7');
  await expect(page.locator('#connText')).toHaveText(/^Live/, { timeout: 8000 });
  await expect.poll(async () => (await deviceIds(request)).filter((d) => d.id === '127.0.0.7').length).toBe(1);
  expect(errors).toEqual([]);
});

test('malformed packets are ignored without disturbing real boards', async ({ page, request }) => {
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.9', () => resolve()));
  const good = (await deviceIds(request)).find((d) => d.id === '127.0.0.1')!;
  expect(good.rate).toBeGreaterThan(0);

  const junk = [Buffer.alloc(0), Buffer.from('hello'), Buffer.alloc(24, 0xff), Buffer.alloc(1500, 7)];
  for (let i = 0; i < 400; i++) {
    await new Promise((resolve) => socket.send(junk[i % junk.length], UDP_PORT, '127.0.0.1', resolve));
  }
  socket.close();

  await page.waitForTimeout(1500);
  const after = await deviceIds(request);
  expect(after.some((d) => d.id === '127.0.0.9')).toBe(false); // junk never registers a device
  expect(after.find((d) => d.id === '127.0.0.1')!.rate).toBeGreaterThan(150); // still streaming
});

test('high packet rate: the server forwards every sample it counts', async ({ page, request }) => {
  test.setTimeout(45000);
  startBoard('127.0.0.8', '--rate', '400');
  await expect.poll(async () => (await deviceIds(request)).find((d) => d.id === '127.0.0.8')?.rate ?? 0, { timeout: 8000 }).toBeGreaterThan(400);

  await page.goto('/');
  const result = await page.evaluate(
    () =>
      new Promise<{ samples: number; seconds: number; gaps: number }>((resolve) => {
        const seen: number[] = [];
        const es = new EventSource('/devices/127.0.0.8/events');
        const t0 = performance.now();
        es.onmessage = (e) => {
          for (const m of JSON.parse(e.data)) if (m.measurement.Accel) seen.push(m.timestamp);
        };
        setTimeout(() => {
          es.close();
          const gaps = seen.slice(1).filter((t, i) => t <= seen[i]).length;
          resolve({ samples: seen.length, seconds: (performance.now() - t0) / 1000, gaps });
        }, 3000);
      }),
  );
  const rate = (await deviceIds(request)).find((d) => d.id === '127.0.0.8')!.rate / 4; // accel samples/s
  // Everything counted by the server reaches the browser, in order.
  expect(result.gaps).toBe(0);
  expect(result.samples / result.seconds).toBeGreaterThan(rate * 0.7);
});

test('timestamps stay exact for a board that has been up for 10 hours', async ({ page }) => {
  startBoard('127.0.0.6', '--start-uptime', '36000');
  await page.goto('/dashboard.html?src=127.0.0.6');
  await expect.poll(() => page.locator('#accelPlot').evaluate((el: any) => el.data[0].x.length), { timeout: 10000 }).toBeGreaterThan(50);
  const xs: number[] = await page.locator('#accelPlot').evaluate((el: any) => el.data[0].x);
  // Seconds since the page opened, not hours of uptime or microseconds.
  expect(Math.max(...xs)).toBeLessThan(60);
  const steps = xs.slice(1).map((x, i) => x - xs[i]).sort((a, b) => a - b);
  expect(steps[steps.length >> 1]).toBeGreaterThan(0.01);
  expect(steps[steps.length >> 1]).toBeLessThan(0.03);
});

test('a parser failure is reported instead of silently showing nothing', async ({ page }) => {
  await page.route('**/parser.worker.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: 'throw new Error("boom");' }),
  );
  await page.goto('/dashboard.html?src=127.0.0.1');
  await expect(page.locator('#connText')).toHaveText('Data parser failed · reload the page', { timeout: 10000 });
  await expect(page.locator('#connPill')).toHaveAttribute('data-state', 'bad');
});

test('a failed export keeps the recording and tells the user', async ({ page }) => {
  await page.goto('/dashboard.html?src=127.0.0.1');
  await page.locator('#recordBtn').click();
  await page.waitForTimeout(1500);
  await page.locator('#stopBtn').click();
  const recorded = await page.locator('#recCount').textContent();

  await page.route('**/xlsx.full.min.js', (route) => route.abort());
  // Handle the alert as it opens: it blocks the page until dismissed.
  let message = '';
  page.once('dialog', async (d) => {
    message = d.message();
    await d.dismiss();
  });
  await page.locator('#exportBtn').click();
  await expect.poll(() => message).toContain('Excel export failed');

  await expect(page.locator('#exportBtn')).toBeEnabled();
  await expect(page.locator('#exportBtn')).toHaveText('Export Excel');
  await expect(page.locator('#recCount')).toHaveText(recorded!);
});

test('no console errors on any page during normal use', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  for (const url of ['/', '/dashboard.html?src=127.0.0.1', '/3d/?src=127.0.0.1']) {
    await page.goto(url);
    await page.waitForTimeout(2500);
  }
  expect(problems).toEqual([]);
});

test('multicast mode: a server joined to a group receives a board sending to it', async ({ request }) => {
  // A second server on its own ports, listening to a multicast group over loopback.
  const [http, udp, group] = [28180, 28199, '239.255.42.1'];
  startProcess(exe('plotly-client'), [
    '--no-open', '--http-port', String(http), '--udp-port', String(udp),
    '--multicast-group', group, '--multicast-iface', '127.0.0.1',
  ]);
  startProcess(DUMMY, ['-p', String(udp), '-a', group, '--bind', '127.0.0.1']);

  const url = `http://127.0.0.1:${http}/devices`;
  await expect
    .poll(async () => {
      try {
        const list: { id: string; rate: number }[] = await (await request.get(url)).json();
        return list.find((d) => d.id === '127.0.0.1')?.rate ?? 0;
      } catch {
        return 0; // server still starting
      }
    }, { timeout: 15000 })
    .toBeGreaterThan(150);
});
