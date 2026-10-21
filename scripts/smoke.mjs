/**
 * End-to-end smoke test for the editor.
 *
 * Drives a real Chromium against the dev server: it drags an object, resizes
 * it, rotates it, undoes the change and renders 500 objects — the checks
 * from the stage 1 checklist that cannot be expressed as unit tests.
 *
 *   npm run dev            # in one terminal
 *   npm run smoke          # in another
 *
 * Browser selection, in order of precedence:
 *   CHROMIUM_PATH  exact binary to drive
 *   SMOKE_CHANNEL  playwright channel ('chrome' uses the system Google Chrome)
 *   default        a Chromium in the playwright browser cache, if there is one
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const URL = process.env.SMOKE_URL ?? 'http://localhost:5173/';
// GitHub runners ship Google Chrome, which playwright can drive directly.
const CHANNEL = process.env.SMOKE_CHANNEL;

/** Any Chromium already downloaded into the playwright browser cache. */
function cachedChromium() {
  const root = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(root)) return undefined;
  const builds = readdirSync(root)
    .filter((entry) => entry.startsWith('chromium-'))
    .sort()
    .reverse();
  for (const build of builds) {
    for (const relative of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = join(root, build, relative);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function resolveExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  // A channel names a browser that playwright resolves itself. Passing an
  // `executablePath` as well would override the channel and fail, because the
  // bundled Chromium is not installed on a plain CI runner.
  if (CHANNEL) return undefined;
  const bundled = chromium.executablePath?.();
  if (bundled && existsSync(bundled)) return bundled;
  return cachedChromium();
}

const browser = await chromium.launch({
  executablePath: resolveExecutable(),
  channel: CHANNEL,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('404')) {
    errors.push(message.text());
  }
});
page.on('pageerror', (error) => errors.push(String(error)));

const failures = [];
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
  if (!ok) failures.push(label);
}

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const canvas = page.locator('svg.scene-canvas');
const box = await canvas.boundingBox();
if (!box) throw new Error('the canvas did not render');
const at = (wx, wy) => ({ x: box.x + wx, y: box.y + wy });

const demoRect = page.locator('[data-object-id="demo-rect"] rect');
const status = async () => (await page.locator('.status-bar').innerText()).replace(/\n/g, ' | ');

check('objects rendered', await page.locator('[data-object-id]').count(), 4);

// --- drag ---------------------------------------------------------------
await page.mouse.move(at(190, 150).x, at(190, 150).y);
await page.mouse.down();
await page.mouse.move(at(290, 210).x, at(290, 210).y, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(120);
check('drag moved x', await demoRect.getAttribute('x'), '180');
check('drag moved y', await demoRect.getAttribute('y'), '140');

// --- undo ---------------------------------------------------------------
await page.keyboard.press('Control+z');
await page.waitForTimeout(120);
check('undo restored x', await demoRect.getAttribute('x'), '80');
check('undo restored y', await demoRect.getAttribute('y'), '80');

// --- resize -------------------------------------------------------------
await page.mouse.click(at(190, 150).x, at(190, 150).y);
await page.waitForTimeout(80);
const handle = await page.locator('.handle-e').boundingBox();
if (!handle) throw new Error('the resize handle did not render');
await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
await page.mouse.down();
await page.mouse.move(handle.x + handle.width / 2 + 60, handle.y + handle.height / 2, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(120);
check('resize changed width', await demoRect.getAttribute('width'), '280');

// --- rotate -------------------------------------------------------------
const rotate = await page.locator('.handle-rotate').boundingBox();
if (!rotate) throw new Error('the rotate handle did not render');
await page.mouse.move(rotate.x + rotate.width / 2, rotate.y + rotate.height / 2);
await page.mouse.down();
await page.mouse.move(rotate.x + rotate.width / 2 + 80, rotate.y + rotate.height / 2 + 80, {
  steps: 10,
});
await page.mouse.up();
await page.waitForTimeout(120);
const rotation = await demoRect.getAttribute('transform');
check('rotate applied', /rotate\((?!0 )/.test(rotation ?? ''), true);

// --- create with a tool -------------------------------------------------
await page.getByRole('button', { name: 'Ellipse' }).click();
await page.mouse.click(at(700, 400).x, at(700, 400).y);
await page.waitForTimeout(120);
check('object created', await page.locator('[data-object-id]').count(), 5);

// --- zoom ---------------------------------------------------------------
await page.mouse.move(at(400, 300).x, at(400, 300).y);
await page.mouse.wheel(0, -400);
await page.waitForTimeout(120);
const worldTransform = await page.locator('svg.scene-canvas > g').getAttribute('transform');
check('zoom applied', /scale\(1\.1\)/.test(worldTransform ?? ''), true);

// --- performance: 500 objects ------------------------------------------
await page.getByRole('button', { name: '+500' }).click();
await page.waitForTimeout(1500);
check('stress objects', await page.locator('[data-object-id]').count(), 505);
console.log(`status: ${await status()}`);

check('no console errors', errors.length, 0);

await browser.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nall checks passed');
