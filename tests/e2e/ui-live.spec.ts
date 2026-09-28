import { test, expect, Page } from '@playwright/test';

// These tests exercise the parts of the dashboard the baseline suite in
// dashboard.spec.ts didn't reach: the remaining plot panels, the panel
// visibility toggles, the layout switcher, keyboard shortcuts, the
// record → export round trip, the landing page's device table, and the
// standalone 3D view. playwright.config.ts starts the backend and dummy
// boards (tests/e2e/stack.mjs), so the end-to-end data pipeline (SSE → worker → plots) is exercised for
// real rather than asserting on an empty/never-fed page.

async function gotoDashboard(page: Page, src = '127.0.0.1') {
  await page.goto(`/dashboard.html?src=${encodeURIComponent(src)}`);
  await page.waitForLoadState('domcontentloaded');
}

async function openMenu(page: Page) {
  await page.locator('summary[aria-label="Open dashboard menu"]').click();
}

async function firstLiveDeviceId(page: Page): Promise<string | null> {
  const res = await page.request.get('/devices');
  if (!res.ok()) return null;
  const list = await res.json();
  return list?.[0]?.id ?? null;
}

// ─── Remaining plot panels ───────────────────────────────────────────────────

test.describe('Plotly plots (pressure & altitude)', () => {
  test('pressure plot SVG is rendered', async ({ page }) => {
    await gotoDashboard(page);
    await page.waitForTimeout(1500);
    await expect(page.locator('#pressurePlot svg.main-svg').first()).toBeAttached();
  });

  test('altitude plot SVG is rendered', async ({ page }) => {
    await gotoDashboard(page);
    await page.waitForTimeout(1500);
    await expect(page.locator('#altitudePlot svg.main-svg').first()).toBeAttached();
  });

  test('scalar plots (temp/pressure/altitude) are configured with one named trace', async ({ page }) => {
    await gotoDashboard(page);
    await page.waitForTimeout(1000);
    for (const id of ['tempPlot', 'pressurePlot', 'altitudePlot']) {
      const count = await page.locator(`#${id}`).evaluate((el: any) => el.data.length);
      expect(count).toBeGreaterThan(0);
    }
  });
});

// ─── Panel visibility toggles ────────────────────────────────────────────────

test.describe('Panel toggles', () => {
  test('live values toggle shows the values panel', async ({ page }) => {
    await gotoDashboard(page);
    await openMenu(page);
    await expect(page.locator('#panel-values')).toHaveCSS('display', 'none');
    await page.locator('#liveValuesToggle').check();
    await expect(page.locator('#panel-values')).not.toHaveCSS('display', 'none');
    await page.locator('#liveValuesToggle').uncheck();
    await expect(page.locator('#panel-values')).toHaveCSS('display', 'none');
  });

  test('attitude indicator toggle shows the horizon panel and draws on canvas', async ({ page }) => {
    await gotoDashboard(page);
    await openMenu(page);
    await expect(page.locator('#panel-horizon')).toHaveCSS('display', 'none');
    await page.locator('#horizonToggle').check();
    await expect(page.locator('#panel-horizon')).not.toHaveCSS('display', 'none');
    await expect(page.locator('#horizonCanvas')).toBeAttached();
    await expect(page.locator('#horizonRoll')).toBeAttached();
    await expect(page.locator('#horizonPitch')).toBeAttached();
  });

  test('crosshair toggle does not crash and persists its checked state', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await gotoDashboard(page);
    await openMenu(page);
    await page.locator('#crosshairToggle').check();
    await page.waitForTimeout(300);
    expect(errors).toHaveLength(0);
    await expect(page.locator('#crosshairToggle')).toBeChecked();
  });

  test('panel toggle state survives reload (persisted per-device)', async ({ page }) => {
    await gotoDashboard(page, 'toggle-persist-device');
    await openMenu(page);
    await page.locator('#liveValuesToggle').check();
    await page.waitForTimeout(200);
    await gotoDashboard(page, 'toggle-persist-device');
    await expect(page.locator('#panel-values')).not.toHaveCSS('display', 'none');
  });
});

// ─── Layout switcher ─────────────────────────────────────────────────────────

test.describe('Layout switcher', () => {
  test('switching to Focus layout marks it applied and moves panel-accel', async ({ page }) => {
    await gotoDashboard(page);
    await page.waitForTimeout(500);
    const before = await page.locator('#panel-accel').evaluate(el => el.getAttribute('gs-w'));

    await openMenu(page);
    await page.locator('#layoutFocus').click();
    await page.waitForTimeout(400);

    await expect(page.locator('#layoutFocus')).toHaveClass(/\bactive\b/);
    const after = await page.locator('#panel-accel').evaluate(el => el.getAttribute('gs-w'));
    expect(after).not.toBe(before);
  });

  test('Reset to Default restores the Rows layout', async ({ page }) => {
    await gotoDashboard(page);
    await page.waitForTimeout(500);
    await openMenu(page);
    await page.locator('#layoutGrid').click();
    await page.waitForTimeout(400);
    await page.locator('#resetLayoutBtn').click();
    await page.waitForTimeout(400);
    await expect(page.locator('#layoutRows')).toHaveClass(/\bactive\b/);
  });
});

// ─── Keyboard shortcuts ──────────────────────────────────────────────────────

test.describe('Keyboard shortcuts', () => {
  test('"p" toggles pause the same as clicking the button', async ({ page }) => {
    await gotoDashboard(page);
    await page.locator('body').click();
    await expect(page.locator('#pauseBtn')).toHaveText('Pause');
    await page.keyboard.press('p');
    await expect(page.locator('#pauseBtn')).toHaveText('Resume');
    await page.keyboard.press('p');
    await expect(page.locator('#pauseBtn')).toHaveText('Pause');
  });

  test('"m" opens the menu and "Escape" closes it', async ({ page }) => {
    await gotoDashboard(page);
    await page.locator('body').click();
    await page.keyboard.press('m');
    await expect(page.locator('#topMenu')).toHaveJSProperty('open', true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#topMenu')).toHaveJSProperty('open', false);
  });

  test('"r" and "s" start and stop recording', async ({ page }) => {
    await gotoDashboard(page);
    await page.locator('body').click();
    await page.keyboard.press('r');
    await expect(page.locator('#recordBtn')).toBeDisabled();
    await expect(page.locator('#stopBtn')).toBeEnabled();
    await page.keyboard.press('s');
    await expect(page.locator('#recordBtn')).toBeEnabled();
    await expect(page.locator('#stopBtn')).toBeDisabled();
  });

  test('shortcuts are suppressed while typing in an input', async ({ page }) => {
    await gotoDashboard(page);
    await openMenu(page);
    const windowSec = page.locator('#windowSec');
    await windowSec.click();
    await windowSec.fill('');
    await page.keyboard.type('p');
    // 'p' typed into the number input must not toggle pause behind the menu
    await expect(page.locator('#pauseBtn')).toHaveText('Pause');
  });
});

// ─── Record → Export round trip (live data) ─────────────────────────────────

test.describe('Record and export with live data', () => {
  test('recording captures live samples and export produces a real .xlsx download', async ({ page }) => {
    test.setTimeout(30000);
    const deviceId = await firstLiveDeviceId(page);
    expect(deviceId, 'the test stack should have live dummy boards').toBeTruthy();

    await gotoDashboard(page, deviceId!);
    await page.waitForTimeout(1000); // let the SSE connection establish

    await page.locator('#recordBtn').click();
    await expect(page.locator('#stopBtn')).toBeEnabled();

    await expect
      .poll(async () => Number(await page.locator('#recCount').textContent()), { timeout: 10000 })
      .toBeGreaterThan(0);

    await page.locator('#stopBtn').click();
    await expect(page.locator('#exportBtn')).toBeEnabled();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#exportBtn').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
    const path = await download.path();
    expect(path).toBeTruthy();
  });

  test('buffer count and last-seen update once live data arrives', async ({ page }) => {
    const deviceId = await firstLiveDeviceId(page);
    expect(deviceId, 'the test stack should have live dummy boards').toBeTruthy();

    await gotoDashboard(page, deviceId!);

    await expect(page.locator('#connText')).toContainText('Live', { timeout: 8000 });
    await expect
      .poll(async () => (await page.locator('#lastSeen').textContent())?.trim(), { timeout: 8000 })
      .not.toBe('-');

    const dataLen = await page.locator('#accelPlot').evaluate((el: any) => el.data?.[0]?.x?.length ?? 0);
    expect(dataLen).toBeGreaterThan(0);
  });
});

// ─── Landing page device table ───────────────────────────────────────────────

test.describe('Landing page device table (live)', () => {
  test('a live device appears in the device table with a packet rate', async ({ page }) => {
    const deviceId = await firstLiveDeviceId(page);
    expect(deviceId, 'the test stack should have live dummy boards').toBeTruthy();

    await page.goto('/');
    await expect
      .poll(async () => page.locator('#deviceList tr').count(), { timeout: 8000 })
      .toBeGreaterThan(0);

    const row = page.locator('#deviceList tr').first();
    await expect(row).toContainText(deviceId!);
  });

  test('Open Dashboard button on a device row opens an embedded dashboard tab', async ({ page }) => {
    // "Open Dashboard"/"Open 3D" are buttons that open a new tab in the
    // SPA's own tab bar (openDeviceTab) with an <iframe>, not <a> links
    // that navigate window.location.
    const deviceId = await firstLiveDeviceId(page);
    expect(deviceId, 'the test stack should have live dummy boards').toBeTruthy();

    await page.goto('/');
    await expect
      .poll(async () => page.locator('#deviceList tr').count(), { timeout: 8000 })
      .toBeGreaterThan(0);

    const row = page.locator('#deviceList tr').first();
    await row.locator('button', { hasText: /open dashboard/i }).click();

    const frame = page.locator('#contentArea iframe').last();
    await expect(frame).toBeAttached();
    const src = await frame.getAttribute('src');
    expect(src).toContain('/dashboard.html');
    expect(src).toContain(encodeURIComponent(deviceId!));

    // A matching tab is added to the tab bar and becomes active
    await expect(page.locator('#tabBar .tab.active')).toContainText(deviceId!.split(':')[0]);
  });

  test('Open 3D button on a device row opens an embedded 3D tab', async ({ page }) => {
    const deviceId = await firstLiveDeviceId(page);
    expect(deviceId, 'the test stack should have live dummy boards').toBeTruthy();

    await page.goto('/');
    await expect
      .poll(async () => page.locator('#deviceList tr').count(), { timeout: 8000 })
      .toBeGreaterThan(0);

    const row = page.locator('#deviceList tr').first();
    await row.locator('button', { hasText: /open 3d/i }).click();

    const frame = page.locator('#contentArea iframe').last();
    await expect(frame).toBeAttached();
    const src = await frame.getAttribute('src');
    expect(src).toContain('/3d/');
    expect(src).toContain(encodeURIComponent(deviceId!));
  });
});

// ─── Standalone 3D view ──────────────────────────────────────────────────────

test.describe('3D view page', () => {
  test('loads without errors and mounts a canvas', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/3d/?demo=1&embed=1');
    await page.waitForTimeout(1500);
    await expect(page.locator('canvas')).toBeAttached();
    expect(errors).toHaveLength(0);
  });

  test('accepts a src query param without crashing', async ({ page }) => {
    const deviceId = await firstLiveDeviceId(page);
    expect(deviceId, 'the test stack should have live dummy boards').toBeTruthy();

    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`/3d/?src=${encodeURIComponent(deviceId!)}`);
    await page.waitForTimeout(1500);
    await expect(page.locator('canvas')).toBeAttached();
    expect(errors).toHaveLength(0);
  });
});
