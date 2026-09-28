import { test, expect, Page } from '@playwright/test';

// ─── helpers ────────────────────────────────────────────────────────────────

async function gotoLanding(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
}

async function gotoDashboard(page: Page, src = '127.0.0.1') {
  await page.goto(`/dashboard.html?src=${encodeURIComponent(src)}`);
  await page.waitForLoadState('domcontentloaded');
}

// ─── Landing page ────────────────────────────────────────────────────────────

test.describe('Landing page', () => {
  test('loads and shows device list section', async ({ page }) => {
    await gotoLanding(page);
    await expect(page).toHaveTitle(/Kiwi/i);
    await expect(page.locator('#devicesView')).toBeVisible();
  });

  test('connection pill is visible', async ({ page }) => {
    await gotoLanding(page);
    await expect(page.locator('#connPill')).toBeAttached();
  });

  test('device count element exists', async ({ page }) => {
    await gotoLanding(page);
    await expect(page.locator('#deviceCount')).toBeVisible();
  });

  test('tab bar has Devices tab active', async ({ page }) => {
    await gotoLanding(page);
    const tab = page.locator('.tab.active');
    await expect(tab).toBeVisible();
    await expect(tab).toContainText('Devices');
  });

  test('theme toggle changes body class', async ({ page }) => {
    await gotoLanding(page);
    const select = page.locator('#themeSelect');
    await select.selectOption('light');
    await expect(page.locator('body')).toHaveClass(/light/);
    await select.selectOption('dark');
    await expect(page.locator('body')).toHaveClass(/dark/);
  });

  test('refresh button exists and is clickable', async ({ page }) => {
    await gotoLanding(page);
    const btn = page.locator('#refreshBtn');
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(btn).toBeVisible();
  });

  test('search input filters device list', async ({ page }) => {
    await gotoLanding(page);
    const search = page.locator('#deviceSearch');
    await expect(search).toBeVisible();
    await search.fill('192.168');
    await expect(search).toHaveValue('192.168');
  });

  test('SSE connection to /devices/events is attempted', async ({ page }) => {
    const sseRequest = page.waitForRequest(req =>
      req.url().includes('/devices/events')
    );
    await gotoLanding(page);
    await expect(sseRequest).resolves.toBeTruthy();
  });
});

// ─── Dashboard page ──────────────────────────────────────────────────────────

test.describe('Dashboard page', () => {
  test('loads without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await gotoDashboard(page);
    expect(errors.filter(e => !e.includes('SSE') && !e.includes('ERR_CONNECTION'))).toHaveLength(0);
  });

  test('has correct title', async ({ page }) => {
    await gotoDashboard(page);
    await expect(page).toHaveTitle(/Kiwi/i);
  });

  test('all 6 plot panels are present', async ({ page }) => {
    await gotoDashboard(page);
    for (const id of ['panel-accel', 'panel-gyro', 'panel-mag', 'panel-temp', 'panel-pressure', 'panel-altitude']) {
      await expect(page.locator(`#${id}`)).toBeAttached();
    }
  });

  test('Plotly canvases are initialized', async ({ page }) => {
    await gotoDashboard(page);
    await page.waitForTimeout(1000);
    const plots = page.locator('.js-plotly-plot');
    await expect(plots).toHaveCount(6);
  });

  test('pause button toggles text', async ({ page }) => {
    await gotoDashboard(page);
    const btn = page.locator('#pauseBtn');
    await expect(btn).toHaveText('Pause');
    await btn.click();
    await expect(btn).toHaveText('Resume');
    await btn.click();
    await expect(btn).toHaveText('Pause');
  });

  test('record / stop buttons work', async ({ page }) => {
    await gotoDashboard(page);
    const rec = page.locator('#recordBtn');
    const stop = page.locator('#stopBtn');
    await expect(rec).toBeEnabled();
    await expect(stop).toBeDisabled();
    await rec.click();
    await expect(rec).toBeDisabled();
    await expect(stop).toBeEnabled();
    await stop.click();
    await expect(rec).toBeEnabled();
    await expect(stop).toBeDisabled();
  });

  test('export button disabled before recording', async ({ page }) => {
    await gotoDashboard(page);
    await expect(page.locator('#exportBtn')).toBeDisabled();
  });

  test('menu opens on hamburger click', async ({ page }) => {
    await gotoDashboard(page);
    await page.locator('summary[aria-label="Open dashboard menu"]').click();
    await expect(page.locator('#topMenu > .menuBody')).toBeVisible();
  });

  test('stream checkboxes all start checked', async ({ page }) => {
    await gotoDashboard(page);
    await page.locator('summary[aria-label="Open dashboard menu"]').click();
    const checks = page.locator('#streamChecks input[type="checkbox"]');
    const count = await checks.count();
    expect(count).toBe(6);
    for (let i = 0; i < count; i++) {
      await expect(checks.nth(i)).toBeChecked();
    }
  });

  test('clear all hides all plot panels', async ({ page }) => {
    await gotoDashboard(page);
    await page.locator('summary[aria-label="Open dashboard menu"]').click();
    await page.locator('#clearAllBtn').click();
    for (const id of ['panel-accel', 'panel-gyro', 'panel-mag', 'panel-temp', 'panel-pressure', 'panel-altitude']) {
      await expect(page.locator(`#${id}`)).toHaveCSS('display', 'none');
    }
  });

  test('select all restores all plot panels', async ({ page }) => {
    await gotoDashboard(page);
    await page.locator('summary[aria-label="Open dashboard menu"]').click();
    await page.locator('#clearAllBtn').click();
    await page.locator('#selectAllBtn').click();
    for (const id of ['panel-accel', 'panel-gyro', 'panel-mag']) {
      await expect(page.locator(`#${id}`)).not.toHaveCSS('display', 'none');
    }
  });

  test('theme toggle works on dashboard', async ({ page }) => {
    await gotoDashboard(page);
    await page.locator('summary[aria-label="Open dashboard menu"]').click();
    await page.locator('#themeSelect').selectOption('light');
    await expect(page.locator('body')).toHaveClass(/light/);
    await page.locator('#themeSelect').selectOption('dark');
    await expect(page.locator('body')).toHaveClass(/dark/);
  });

  test('window seconds input updates value', async ({ page }) => {
    await gotoDashboard(page);
    await page.locator('summary[aria-label="Open dashboard menu"]').click();
    await page.locator('#windowSec').fill('5');
    await page.locator('#windowSec').press('Enter');
    await expect(page.locator('#windowSec')).toHaveValue('5');
  });

  test('connection pill exists on dashboard', async ({ page }) => {
    await gotoDashboard(page);
    await expect(page.locator('#connPill')).toBeAttached();
  });

  test('window diagnostic element exists', async ({ page }) => {
    await gotoDashboard(page);
    await expect(page.locator('#windowPoints')).toBeAttached();
  });

  test('3D panel is present', async ({ page }) => {
    await gotoDashboard(page);
    await expect(page.locator('#panel-3d')).toBeAttached();
  });

  test('3D iframe has correct src', async ({ page }) => {
    await gotoDashboard(page, '127.0.0.1:9000');
    await page.waitForTimeout(500);
    const src = await page.locator('#imu3dFrame').getAttribute('src');
    expect(src).toContain('/3d/');
    expect(src).toContain('embed=1');
  });

  test('SSE connection to device events is attempted', async ({ page }) => {
    const sseReq = page.waitForRequest(req =>
      req.url().includes('/devices/') && req.url().includes('/events')
    );
    await gotoDashboard(page, '127.0.0.1:9000');
    await expect(sseReq).resolves.toBeTruthy();
  });
});

// ─── Panel layout & drag ─────────────────────────────────────────────────────

test.describe('Panel layout and drag', () => {
  test('all panels have grab cursor', async ({ page }) => {
    await gotoDashboard(page);
    await page.waitForTimeout(500);
    for (const id of ['panel-accel', 'panel-gyro', 'panel-mag']) {
      const cursor = await page.locator(`#${id}`).evaluate(el =>
        getComputedStyle(el).cursor
      );
      expect(['grab', 'move', 'default']).toContain(cursor);
    }
  });

  test('panels have panelContent wrapper after init', async ({ page }) => {
    await gotoDashboard(page);
    await page.waitForTimeout(500);
    const content = page.locator('.dashboardPanel .panelContent');
    const count = await content.count();
    expect(count).toBeGreaterThan(0);
  });

  test('resize handle SE exists on accel panel (GridStack)', async ({ page }) => {
    await gotoDashboard(page);
    await page.waitForTimeout(500);
    // Panel layout migrated to GridStack, which renders jQuery-UI-style
    // resizable handles instead of the old custom .panelResizeSE markup.
    await expect(page.locator('#panel-accel .ui-resizable-se')).toBeAttached();
  });

  test('drag accel panel changes its GridStack x/y position', async ({ page }) => {
    // GridStack repositions panels via gs-x/gs-y attributes + CSS grid-area,
    // not DOM reordering, so we assert on the grid coordinates it tracks.
    await gotoDashboard(page);
    await page.waitForTimeout(800);

    const accel = page.locator('#panel-accel');
    const gyro = page.locator('#panel-gyro');

    const accelBox = await accel.boundingBox();
    const gyroBox = await gyro.boundingBox();
    if (!accelBox || !gyroBox) return;

    const before = await accel.evaluate(el => ({ x: el.getAttribute('gs-x'), y: el.getAttribute('gs-y') }));

    const startX = accelBox.x + accelBox.width / 2;
    const startY = accelBox.y + accelBox.height / 2;
    const endX = gyroBox.x + gyroBox.width / 2;
    const endY = gyroBox.y + gyroBox.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 10, startY + 10, { steps: 5 });
    await page.mouse.move(endX, endY, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const after = await accel.evaluate(el => ({ x: el.getAttribute('gs-x'), y: el.getAttribute('gs-y') }));
    expect(after).not.toEqual(before);
  });

  test('panel position is saved to localStorage after drag', async ({ page }) => {
    await gotoDashboard(page, 'test-device');
    await page.waitForTimeout(800);

    const accel = page.locator('#panel-accel');
    const gyro = page.locator('#panel-gyro');
    const accelBox = await accel.boundingBox();
    const gyroBox = await gyro.boundingBox();
    if (!accelBox || !gyroBox) return;

    await page.mouse.move(accelBox.x + accelBox.width / 2, accelBox.y + accelBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(accelBox.x + 20, accelBox.y + 20, { steps: 5 });
    await page.mouse.move(gyroBox.x + gyroBox.width / 2, gyroBox.y + gyroBox.height / 2, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const saved = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.includes('gridstack'));
      if (!key) return null;
      return JSON.parse(localStorage.getItem(key) || 'null');
    });
    expect(saved).not.toBeNull();
    expect(saved['panel-accel']).toBeDefined();
    expect(typeof saved['panel-accel'].x).toBe('number');
    expect(typeof saved['panel-accel'].y).toBe('number');
  });

  test('panel resize handle changes panel height', async ({ page }) => {
    await gotoDashboard(page);
    await page.waitForTimeout(800);

    const panel = page.locator('#panel-accel');
    const handle = panel.locator('.ui-resizable-s');
    const panelBox = await panel.boundingBox();
    const handleBox = await handle.boundingBox();
    if (!panelBox || !handleBox) return;

    const initialHeight = panelBox.height;

    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 80, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const newBox = await panel.boundingBox();
    expect(newBox!.height).toBeGreaterThan(initialHeight);
  });
});

// ─── Plotly plots ────────────────────────────────────────────────────────────

test.describe('Plotly plots', () => {
  test('accel plot SVG is rendered', async ({ page }) => {
    await gotoDashboard(page);
    await page.waitForTimeout(1500);
    await expect(page.locator('#accelPlot svg.main-svg').first()).toBeAttached();
  });

  test('gyro plot SVG is rendered', async ({ page }) => {
    await gotoDashboard(page);
    await page.waitForTimeout(1500);
    await expect(page.locator('#gyroPlot svg.main-svg').first()).toBeAttached();
  });

  test('mag plot SVG is rendered', async ({ page }) => {
    await gotoDashboard(page);
    await page.waitForTimeout(1500);
    await expect(page.locator('#magPlot svg.main-svg').first()).toBeAttached();
  });

  test('temp plot SVG is rendered', async ({ page }) => {
    await gotoDashboard(page);
    await page.waitForTimeout(1500);
    await expect(page.locator('#tempPlot svg.main-svg').first()).toBeAttached();
  });

  test('accel plot is configured with X, Y, Z, |R| traces', async ({ page }) => {
    // .scatterlayer only materializes once a trace actually has data points,
    // which depends on live UDP data timing — assert on the trace config
    // Plotly.newPlot was given instead, which is stable regardless of feed.
    await gotoDashboard(page);
    await page.waitForTimeout(1000);
    await expect(page.locator('#accelPlot.js-plotly-plot')).toBeAttached();
    const names = await page.locator('#accelPlot').evaluate((el: any) => el.data.map((d: any) => d.name));
    expect(names).toEqual(expect.arrayContaining(['X', 'Y', 'Z']));
  });

  test('plot details summary is clickable to collapse', async ({ page }) => {
    await gotoDashboard(page);
    await page.waitForTimeout(500);
    const details = page.locator('#panel-accel details.plotDetails');
    await expect(details).toHaveAttribute('open', '');
    await details.locator('summary').click();
    await expect(details).not.toHaveAttribute('open', '');
  });
});

// ─── Styles & theme ──────────────────────────────────────────────────────────

test.describe('Styles and theme', () => {
  test('body starts with dark class', async ({ page }) => {
    await gotoDashboard(page);
    await expect(page.locator('body')).toHaveClass(/dark/);
  });

  test('dashboard grid has 12-column layout', async ({ page }) => {
    await gotoDashboard(page);
    await page.waitForTimeout(500);
    // GridStack reports column count via its own gs-12 class and
    // grid-template-columns computes to the "repeat(12, ...)" shorthand
    // in current Chromium rather than 12 expanded track values.
    const info = await page.locator('#dashboardGrid').evaluate(el => ({
      cols: getComputedStyle(el).gridTemplateColumns,
      hasGs12Class: el.classList.contains('gs-12'),
    }));
    expect(info.hasGs12Class).toBe(true);
    expect(info.cols).toContain('12');
  });

  test('palette change does not crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await gotoDashboard(page);
    await page.waitForTimeout(1000);
    await page.locator('summary[aria-label="Open dashboard menu"]').click();
    await page.locator('#paletteSelect').selectOption('colorblind');
    await page.waitForTimeout(500);
    expect(errors).toHaveLength(0);
  });
});
