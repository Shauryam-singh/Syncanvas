/**
 * End-to-end smoke test for the collaborative sync.
 *
 * Opens two browser pages on the same room and checks that an edit in one
 * page shows up in the other, that both pages converge on the same scene,
 * that the gateway really is the ordering point and that the clients survive
 * a gateway restart.
 *
 * The script starts the gateway itself (on :8099 by default) so it can kill
 * and restart it; the editor itself has to be served separately:
 *
 *   npm run dev            # the editor on :5173
 *   npm run smoke:sync     # in a second terminal
 *
 * The room id is unique per run, so the test never sees the leftovers of an
 * earlier run.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { collectErrors, launchBrowser } from './browser.mjs';

const BASE_URL = process.env.SMOKE_URL ?? 'http://localhost:5173/';
const PORT = process.env.SYNC_PORT ?? '8099';
const WS_URL = `ws://localhost:${PORT}/ws`;
const ROOM = process.env.SYNC_ROOM ?? `smoke-${Date.now()}`;

const ROOT = new URL('..', import.meta.url).pathname;
const BUILT_GATEWAY = `${ROOT}server/dist/index.js`;
const TSX = `${ROOT}node_modules/.bin/tsx`;

/**
 * Starts the gateway.
 *
 * The compiled gateway is used when it exists; otherwise the TypeScript
 * source is run through `tsx`, so the test works without a build step.
 */
function startGateway() {
  const useBuild = existsSync(BUILT_GATEWAY);
  const child = useBuild
    ? spawn(process.execPath, [BUILT_GATEWAY], {
        env: { ...process.env, PORT },
        stdio: 'ignore',
      })
    : spawn(TSX, [`${ROOT}server/src/index.ts`], {
        env: { ...process.env, PORT },
        stdio: 'ignore',
      });
  return child;
}

/** Waits until the gateway answers its health check. */
async function waitForGateway(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://localhost:${PORT}/healthz`);
      if (response.ok) return;
    } catch {
      // The gateway is not up yet.
    }
    if (Date.now() > deadline) throw new Error('the gateway did not start');
    await sleep(100);
  }
}

/** Stops the gateway and waits until the port is free again. */
async function stopGateway(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
  // The socket needs a moment to close on the client side.
  await sleep(200);
}

let gateway = startGateway();
await waitForGateway();

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

const errors = [];

const alice = await context.newPage();
collectErrors(alice, 'alice', errors);
const bob = await context.newPage();
collectErrors(bob, 'bob', errors);

const failures = [];
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
  if (!ok) failures.push(label);
}

/** Opens the editor in a room and waits until the gateway is connected. */
async function open(page, name) {
  const url = new URL(BASE_URL);
  url.searchParams.set('room', ROOM);
  url.searchParams.set('ws', WS_URL);
  url.searchParams.set('name', name);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await page.locator('.status-bar__connection--live').waitFor({ timeout: 10_000 });
}

await open(alice, 'Alice');
await open(bob, 'Bob');

check('alice is live', await alice.locator('.status-bar__connection').innerText(), 'Live');
check('bob is live', await bob.locator('.status-bar__connection').innerText(), 'Live');

// --- the room roster -----------------------------------------------------
await alice.waitForFunction(
  () => document.querySelector('.status-bar__peers')?.textContent?.includes('2'),
  undefined,
  { timeout: 5_000 },
);
check('alice sees two people', await alice.locator('.status-bar__peers strong').innerText(), '2');
check('bob sees two people', await bob.locator('.status-bar__peers strong').innerText(), '2');

// --- the same scene ------------------------------------------------------
check('alice renders the room', await alice.locator('[data-object-id]').count(), 4);
check('bob renders the room', await bob.locator('[data-object-id]').count(), 4);

/** The position of the demo rectangle, as the page renders it. */
const rectOf = (page) =>
  page.locator('[data-object-id="demo-rect"] rect').evaluate((element) => ({
    x: element.getAttribute('x'),
    y: element.getAttribute('y'),
  }));

/** Drags the demo rectangle by the given amount, in world coordinates. */
async function dragRect(page, dx, dy) {
  const box = await page.locator('svg.scene-canvas').boundingBox();
  if (!box) throw new Error('the canvas did not render');
  const from = { x: box.x + 190, y: box.y + 150 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

// --- alice edits, bob sees ------------------------------------------------
await dragRect(alice, 100, 60);
const bobRect = await rectOf(bob);
check('bob sees alice’s move (x)', bobRect.x, '180');
check('bob sees alice’s move (y)', bobRect.y, '140');

// --- bob edits, alice sees ------------------------------------------------
await dragRect(bob, -40, 20);
const aliceRect = await rectOf(alice);
check('alice sees bob’s move (x)', aliceRect.x, '140');
check('alice sees bob’s move (y)', aliceRect.y, '160');

// --- creation propagates --------------------------------------------------
await bob.getByRole('button', { name: 'Rect' }).click();
const box = await bob.locator('svg.scene-canvas').boundingBox();
if (!box) throw new Error('the canvas did not render');
await bob.mouse.click(box.x + 700, box.y + 400);
// The author only sees its own object once the gateway has echoed it back,
// so both pages are given a moment to catch up.
const countOf = (page, count) =>
  page.waitForFunction(
    (expected) => document.querySelectorAll('[data-object-id]').length === expected,
    count,
    { timeout: 5_000 },
  );
await countOf(alice, 5);
await countOf(bob, 5);
check('alice sees the new object', await alice.locator('[data-object-id]').count(), 5);
check('bob sees the new object', await bob.locator('[data-object-id]').count(), 5);

// --- both pages converge --------------------------------------------------
const aliceState = await alice.evaluate(() =>
  [...document.querySelectorAll('[data-object-id]')].map((element) =>
    element.getAttribute('data-object-id'),
  ),
);
const bobState = await bob.evaluate(() =>
  [...document.querySelectorAll('[data-object-id]')].map((element) =>
    element.getAttribute('data-object-id'),
  ),
);
check('both pages hold the same objects', aliceState.join(','), bobState.join(','));
check('the room has five objects', aliceState.length, 5);

// --- undo travels as an ordinary operation -------------------------------
// Alice's undo stack holds her own drag, so undoing puts the rectangle back
// where it started — on both pages.
await alice.getByRole('button', { name: 'Undo' }).click();
await bob.waitForFunction(
  () => document.querySelector('[data-object-id="demo-rect"] rect')?.getAttribute('x') === '80',
  undefined,
  { timeout: 5_000 },
);
const undoneRect = await rectOf(bob);
check('bob sees alice’s undo (x)', undoneRect.x, '80');
check('bob sees alice’s undo (y)', undoneRect.y, '80');

// --- the clients survive a gateway restart -------------------------------
// The rooms live in memory, so a restart brings the room back from the seed
// scene — but the clients reconnect on their own and carry on.
await stopGateway(gateway);
await alice.waitForSelector('.status-bar__connection--offline', { timeout: 15_000 });
check(
  'alice notices the drop',
  await alice.locator('.status-bar__connection').innerText(),
  'Offline',
);

gateway = startGateway();
await waitForGateway();
await alice.waitForSelector('.status-bar__connection--live', { timeout: 20_000 });
await bob.waitForSelector('.status-bar__connection--live', { timeout: 20_000 });
check('alice is back', await alice.locator('.status-bar__connection').innerText(), 'Live');
check('bob is back', await bob.locator('.status-bar__connection').innerText(), 'Live');
check('the room restarts from the seed scene', await bob.locator('[data-object-id]').count(), 4);

// And the room still works.
await dragRect(alice, 20, 0);
const afterRestart = await rectOf(bob);
check('bob still receives edits (x)', afterRestart.x, '100');

check('no console errors', errors.length, 0);
if (errors.length > 0) console.error(errors.join('\n'));

await browser.close();
await stopGateway(gateway);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nall checks passed');
