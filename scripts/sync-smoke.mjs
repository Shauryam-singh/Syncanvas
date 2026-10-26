/**
 * End-to-end smoke test for the collaborative product.
 *
 * It starts the gateway itself (on :8099 by default) and drives four browser
 * profiles against the editor:
 *
 *   - the owner of a real room (created through the HTTP API),
 *   - an editor who joins with a share link,
 *   - a viewer who joins with a viewer share link,
 *   - a guest with neither a membership nor a link.
 *
 * It checks auth, server-enforced access, live cursors and selections, that a
 * viewer is read-only, that an editor's work propagates, and that the room
 * survives a gateway restart. Persistence is adaptive: with Postgres the scene
 * comes back from the operation log; with the memory store the old sessions
 * fail closed and the durability phase is skipped. The store mode is printed
 * by /healthz.
 *
 *   npm run dev            # the editor on :5173
 *   npm run smoke:sync     # in a second terminal
 *
 * `STORE=postgres` (and `DATABASE_URL`) can be set to force the durable path;
 * `STORE=memory` forces the fallback. Otherwise the gateway picks whichever
 * store is reachable.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { collectErrors, launchBrowser } from './browser.mjs';

const BASE_URL = process.env.SMOKE_URL ?? 'http://localhost:5173/';
const PORT = process.env.SYNC_PORT ?? '8099';
const HTTP = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const ROOM_NAME = process.env.SYNC_ROOM ?? `Smoke ${Date.now()}`;
const JWT_SECRET = process.env.JWT_SECRET ?? 'sync-smoke-secret';

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
  const env = { ...process.env, PORT, JWT_SECRET };
  return useBuild
    ? spawn(process.execPath, [BUILT_GATEWAY], { env, stdio: 'ignore' })
    : spawn(TSX, [`${ROOT}server/src/index.ts`], { env, stdio: 'ignore' });
}

/** Waits until the gateway answers, and returns its health payload. */
async function waitForGateway(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${HTTP}/healthz`);
      if (response.ok) return await response.json();
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

async function api(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${HTTP}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${method} ${path} failed with ${response.status}: ${payload?.error?.message ?? 'unknown'}`,
    );
  }
  return payload;
}

function signIn(displayName) {
  return api('/api/auth/guest', { method: 'POST', body: { displayName } });
}

let gateway = startGateway();
// Never leave the gateway behind if a check throws.
process.on('exit', () => {
  if (gateway && gateway.exitCode === null) gateway.kill('SIGKILL');
});

const health = await waitForGateway();
const storeKind = health.store;
console.log(`gateway store: ${storeKind}`);

const failures = [];
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
  if (!ok) failures.push(label);
}
function checkTrue(label, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures.push(label);
}

// ---------------------------------------------------------------------------
// Identity and room setup (HTTP)
// ---------------------------------------------------------------------------

const aliceSession = await signIn('Alice');
const bobSession = await signIn('Bob');
const mallorySession = await signIn('Mallory');
checkTrue('guest sessions are issued', Boolean(aliceSession.token && bobSession.token));

const created = await api('/api/rooms', {
  method: 'POST',
  token: aliceSession.token,
  body: { name: ROOM_NAME },
});
check('room creation returns the owner role', created.room.role, 'owner');
const roomId = created.room.id;
const editorInvite = created.invites.editor;

const aliceRooms = await api('/api/rooms', { token: aliceSession.token });
checkTrue(
  'the owner sees the room in their list',
  aliceRooms.rooms.some((room) => room.id === roomId),
);

// A viewer link is minted by the owner through the invite endpoint.
const viewerInvite = await api(`/api/rooms/${roomId}/invites`, {
  method: 'POST',
  token: aliceSession.token,
  body: { role: 'viewer' },
});
check('the minted link has the viewer role', viewerInvite.role, 'viewer');

const denied = await fetch(`${HTTP}/api/rooms/${roomId}`, {
  headers: { authorization: `Bearer ${mallorySession.token}` },
});
const deniedBody = await denied.json().catch(() => null);
check('HTTP refuses a guest with no link', denied.status, 403);
check('the refusal is a forbidden error', deniedBody?.error?.code, 'forbidden');

// ---------------------------------------------------------------------------
// Browser sessions
// ---------------------------------------------------------------------------

const browser = await launchBrowser();
const viewport = { width: 1440, height: 900 };
const aliceContext = await browser.newContext({ viewport });
const bobContext = await browser.newContext({ viewport });
const viewerContext = await browser.newContext({ viewport });
const malloryContext = await browser.newContext({ viewport });

const alice = await aliceContext.newPage();
const bob = await bobContext.newPage();
const viewer = await viewerContext.newPage();
const mallory = await malloryContext.newPage();

// The HTTP API created the room as Alice's guest. Seed that same session into
// the browser context so the owner is the same user on both sides (and so the
// owner role, not just the share link, is exercised end to end).
const SESSION_KEY = 'syncanvas.session.v1';
await aliceContext.addInitScript(
  ([key, session]) => {
    try {
      localStorage.setItem(key, JSON.stringify(session));
    } catch {
      // about:blank and opaque origins have no storage; the real document will.
    }
  },
  [SESSION_KEY, { ...aliceSession, server: HTTP }],
);

const errors = [];
collectErrors(alice, 'alice', errors);
collectErrors(bob, 'bob', errors);
collectErrors(viewer, 'viewer', errors);
collectErrors(mallory, 'mallory', errors);

/** Opens the editor in the test room and waits for the socket to be live. */
async function open(page, name, invite) {
  const url = new URL(BASE_URL);
  url.searchParams.set('room', roomId);
  url.searchParams.set('ws', WS_URL);
  url.searchParams.set('name', name);
  if (invite) url.searchParams.set('invite', invite);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await page.locator('.status-bar__connection--live').waitFor({ timeout: 15_000 });
}

// The owner keeps the editor invite in the URL so the share-link path is also
// exercised. In Postgres the owner membership wins; in memory the users and
// room are gone after a restart, so the smoke asserts fail-closed behavior and
// skips the durability phase.
await open(alice, 'Alice', editorInvite);
await open(bob, 'Bob', editorInvite);
await open(viewer, 'Viewer', viewerInvite.token);

// Mallory has neither a membership nor a link.
const malloryUrl = new URL(BASE_URL);
malloryUrl.searchParams.set('room', roomId);
malloryUrl.searchParams.set('ws', WS_URL);
malloryUrl.searchParams.set('name', 'Mallory');
await mallory.goto(malloryUrl.toString(), { waitUntil: 'domcontentloaded' });
await mallory.locator('.gate').waitFor({ timeout: 15_000 });

check(
  'Mallory is shown the access gate',
  (await mallory.locator('.gate__card h1').innerText()).includes('not open to you'),
  true,
);
checkTrue(
  'Mallory’s gate explains the missing link',
  (await mallory.locator('.gate__card').innerText()).includes('share link'),
);
checkTrue('the gate has no editor toolbar', (await mallory.locator('.toolbar').count()) === 0);

check('alice is live', await alice.locator('.status-bar__connection').innerText(), 'Live');
check('bob is live', await bob.locator('.status-bar__connection').innerText(), 'Live');
check('viewer is live', await viewer.locator('.status-bar__connection').innerText(), 'Live');

// `.role-badge` is uppercased by CSS; textContent is the value from the server.
const roleOf = (page) => page.locator('.role-badge').textContent();

check('alice is the owner', await roleOf(alice), 'owner');
check('bob is an editor', await roleOf(bob), 'editor');
check('viewer is a viewer', await roleOf(viewer), 'viewer');

checkTrue(
  'the owner can mint share links from the UI',
  (await alice.getByRole('button', { name: 'Editor link' }).count()) === 1 &&
    (await alice.getByRole('button', { name: 'Viewer link' }).count()) === 1,
);
checkTrue(
  'a viewer is not offered share links',
  (await viewer.getByRole('button', { name: 'Editor link' }).count()) === 0,
);

// ---------------------------------------------------------------------------
// Presence: roster, cursor, selection, disconnect
// ---------------------------------------------------------------------------

async function peerCount(page) {
  const locator = page.locator('.status-bar__peers strong');
  if ((await locator.count()) === 0) return 0;
  return Number(await locator.innerText());
}

async function waitForPeerCount(page, expected) {
  await page.waitForFunction(
    (count) => document.querySelector('.status-bar__peers strong')?.textContent === String(count),
    expected,
    { timeout: 5_000 },
  );
}

async function waitForPeerLabel(page, name) {
  await page.waitForFunction(
    (displayName) =>
      [...document.querySelectorAll('.peer-layer text')].some(
        (node) => node.textContent === displayName,
      ),
    name,
    { timeout: 5_000 },
  );
}

async function waitForNoPeerLabel(page, name) {
  await page.waitForFunction(
    (displayName) =>
      ![...document.querySelectorAll('.peer-layer text')].some(
        (node) => node.textContent === displayName,
      ),
    name,
    { timeout: 5_000 },
  );
}

await waitForPeerCount(alice, 3);
check('alice sees the whole room', await peerCount(alice), 3);
check('bob sees the whole room', await peerCount(bob), 3);

const aliceBox = await alice.locator('svg.scene-canvas').boundingBox();
if (!aliceBox) throw new Error('the canvas did not render for alice');

// Alice points at the canvas; Bob should see her cursor and label.
await alice.mouse.move(aliceBox.x + 420, aliceBox.y + 300, { steps: 6 });
await waitForPeerLabel(bob, 'Alice');
checkTrue('bob sees alice’s live cursor', true);

// Alice selects the demo rectangle; the selection is ephemeral too.
await alice.mouse.click(aliceBox.x + 190, aliceBox.y + 150);
await bob.waitForFunction(
  () => document.querySelectorAll('.peer-layer rect[fill="none"]').length > 0,
  undefined,
  { timeout: 5_000 },
);
checkTrue('bob sees alice’s selection outline', true);

// The viewer points somewhere so there is a cursor to remove later.
const viewerBox = await viewer.locator('svg.scene-canvas').boundingBox();
if (!viewerBox) throw new Error('the canvas did not render for viewer');
await viewer.mouse.move(viewerBox.x + 700, viewerBox.y + 400, { steps: 6 });
await waitForPeerLabel(alice, 'Viewer');
checkTrue('the viewer’s cursor is broadcast', true);

// ---------------------------------------------------------------------------
// Viewer is read-only in the UI
// ---------------------------------------------------------------------------

check(
  'viewer cannot pick a shape tool',
  await viewer.getByRole('button', { name: 'Rect' }).isDisabled(),
  true,
);
check(
  'viewer cannot mix the performance batch',
  await viewer.getByRole('button', { name: '+500' }).isDisabled(),
  true,
);
checkTrue(
  'viewer is told the room is read-only',
  (await viewer.locator('.room-panel__readonly').innerText()) === 'Read-only',
);

// Selecting is still allowed (it is presence, not an edit), but the property
// fields and the destructive actions are disabled.
await viewer.mouse.click(viewerBox.x + 190, viewerBox.y + 150);
const xField = viewer.locator('.panel .field input[type="number"]').first();
await xField.waitFor({ timeout: 5_000 });
check('viewer property fields are read-only', await xField.isDisabled(), true);
check(
  'viewer cannot delete',
  await viewer.getByRole('button', { name: 'Delete' }).isDisabled(),
  true,
);
const viewerObjectsBefore = await viewer.locator('[data-object-id]').count();
await viewer.keyboard.press('Delete');
await viewer.waitForTimeout(150);
check(
  'viewer delete changes nothing',
  await viewer.locator('[data-object-id]').count(),
  viewerObjectsBefore,
);

// A viewer cannot mint more links on the server either.
const viewerStored = await viewer.evaluate(() => {
  const raw = localStorage.getItem('syncanvas.session.v1');
  return raw ? JSON.parse(raw) : null;
});
if (viewerStored?.token) {
  const inviteAttempt = await fetch(`${HTTP}/api/rooms/${roomId}/invites`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${viewerStored.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ role: 'viewer' }),
  });
  check('the server refuses a viewer invite', inviteAttempt.status, 403);
}

// Closing the tab removes the ephemeral presence immediately, without waiting
// for the server-side TTL.
await viewerContext.close();
await waitForNoPeerLabel(alice, 'Viewer');
await waitForPeerCount(alice, 2);
check('the disconnected viewer leaves the roster', await peerCount(alice), 2);

// ---------------------------------------------------------------------------
// Editors collaborate
// ---------------------------------------------------------------------------

const rectOf = (page) =>
  page.locator('[data-object-id="demo-rect"] rect').evaluate((element) => ({
    x: element.getAttribute('x'),
    y: element.getAttribute('y'),
  }));

async function dragRect(page, dx, dy) {
  const box = await page.locator('svg.scene-canvas').boundingBox();
  if (!box) throw new Error('the canvas did not render');
  const from = { x: box.x + 190, y: box.y + 150 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

await dragRect(alice, 100, 60);
const bobRect = await rectOf(bob);
check('bob sees alice’s move (x)', bobRect.x, '180');
check('bob sees alice’s move (y)', bobRect.y, '140');

await dragRect(bob, -40, 20);
const aliceRect = await rectOf(alice);
check('alice sees bob’s move (x)', aliceRect.x, '140');
check('alice sees bob’s move (y)', aliceRect.y, '160');

await bob.getByRole('button', { name: 'Rect' }).click();
const bobBox = await bob.locator('svg.scene-canvas').boundingBox();
if (!bobBox) throw new Error('the canvas did not render for bob');
await bob.mouse.click(bobBox.x + 700, bobBox.y + 400);
const countOf = (page, count) =>
  page.waitForFunction(
    (expected) => document.querySelectorAll('[data-object-id]').length === expected,
    count,
    { timeout: 5_000 },
  );
await countOf(alice, 5);
await countOf(bob, 5);
check('alice sees bob’s new object', await alice.locator('[data-object-id]').count(), 5);
check('bob sees his new object', await bob.locator('[data-object-id]').count(), 5);

// Undo is an ordinary operation and travels to the other replica.
await alice.getByRole('button', { name: 'Undo' }).click();
await bob.waitForFunction(
  () => document.querySelector('[data-object-id="demo-rect"] rect')?.getAttribute('x') === '80',
  undefined,
  { timeout: 5_000 },
);
const undone = await rectOf(bob);
check('bob sees alice’s undo (x)', undone.x, '80');
check('bob sees alice’s undo (y)', undone.y, '80');

// Give the fire-and-forget persistence queue a moment before the restart.
await alice.waitForTimeout(350);

// ---------------------------------------------------------------------------
// Gateway restart
// ---------------------------------------------------------------------------

await stopGateway(gateway);
await alice.waitForSelector('.status-bar__connection--offline', { timeout: 15_000 });
check(
  'alice notices the drop',
  await alice.locator('.status-bar__connection').innerText(),
  'Offline',
);

gateway = startGateway();
const restarted = await waitForGateway();
check('the gateway restarts with the same store', restarted.store, storeKind);

if (storeKind === 'postgres') {
  await alice.waitForSelector('.status-bar__connection--live', { timeout: 20_000 });
  await bob.waitForSelector('.status-bar__connection--live', { timeout: 20_000 });
  check('alice is back', await alice.locator('.status-bar__connection').innerText(), 'Live');
  check('bob is back', await bob.locator('.status-bar__connection').innerText(), 'Live');

  // `joined` arrives just before the room state; give the state frame time to
  // land before inspecting the scene.
  await alice.waitForTimeout(300);

  const aliceRole = await roleOf(alice);
  await countOf(bob, 5);
  check('the persisted scene comes back', await bob.locator('[data-object-id]').count(), 5);
  check('the owner keeps the room', aliceRole, 'owner');

  // The room still works after the restart.
  await dragRect(alice, 20, 0);
  const afterRestart = await rectOf(bob);
  check('bob still receives edits (x)', afterRestart.x, '100');

  // -------------------------------------------------------------------------
  // Creating a room from the UI
  // -------------------------------------------------------------------------

  await alice.getByRole('button', { name: 'New room' }).click();
  await alice.getByLabel('New room name').fill(`Fresh ${Date.now()}`);
  await alice.getByRole('button', { name: 'Create' }).click();
  await alice.waitForURL((url) => url.searchParams.get('room') !== roomId, {
    timeout: 15_000,
  });
  await alice.waitForFunction(
    () => document.querySelector('.role-badge')?.textContent === 'owner',
    undefined,
    { timeout: 15_000 },
  );
  check('the UI creates a fresh room where you are owner', await roleOf(alice), 'owner');
  checkTrue('the fresh room link has no invite', !new URL(alice.url()).searchParams.has('invite'));
} else {
  // The memory store is intentionally ephemeral: users, rooms and memberships
  // are gone after a restart, so an old access token is rejected even though
  // its signature is valid. The product must fail closed, not silently let a
  // session into a fresh store.
  await alice.locator('.gate').waitFor({ timeout: 20_000 });
  await bob.locator('.gate').waitFor({ timeout: 20_000 });
  checkTrue(
    'a memory restart invalidates the old sessions',
    (await alice.locator('.gate__card').innerText()).includes('no longer exists'),
  );
  console.log('SKIP  restart recovery (memory store is ephemeral; use STORE=postgres)');
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

await browser.close();
await stopGateway(gateway);

check('no console errors', errors.length, 0);
if (errors.length > 0) console.error(errors.join('\n'));

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nall checks passed');
