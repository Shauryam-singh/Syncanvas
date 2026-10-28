/**
 * Two-gateway scale/failover smoke test.
 *
 * Topology:
 *
 *   browser A ── TCP proxy A ──▶ gateway A (:8101)
 *   browser B ── TCP proxy B ──▶ gateway B (:8102)
 *
 * Both gateways share Postgres and Redis. The proxies pin new connections to
 * one gateway, and fail over to the other when a health check fails — the same
 * job Nginx does in the Docker Compose deployment. The script checks:
 *
 *   - edits and presence cross gateway instances,
 *   - killing one gateway reconnects its client to the survivor without losing
 *     the scene,
 *   - restarting both gateways restores the room from Postgres,
 *   - the restored replicas still exchange edits.
 *
 * Requirements: Postgres and Redis on the URLs below, a running client
 * (`npm run preview`), and a build (`npm run build`). If the server build is
 * missing, the gateways run from TypeScript through `tsx`.
 *
 *   npm run smoke:scale
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { collectErrors, launchBrowser } from './browser.mjs';

const BASE_URL = process.env.SMOKE_URL ?? 'http://localhost:4173/';
const GATEWAY_A_PORT = Number(process.env.SCALE_GATEWAY_A_PORT ?? 8101);
const GATEWAY_B_PORT = Number(process.env.SCALE_GATEWAY_B_PORT ?? 8102);
const PROXY_A_PORT = Number(process.env.SCALE_PROXY_A_PORT ?? 8111);
const PROXY_B_PORT = Number(process.env.SCALE_PROXY_B_PORT ?? 8112);
const API_A = `http://127.0.0.1:${PROXY_A_PORT}`;
const API_B = `http://127.0.0.1:${PROXY_B_PORT}`;
const WS_A = `ws://127.0.0.1:${PROXY_A_PORT}/ws`;
const WS_B = `ws://127.0.0.1:${PROXY_B_PORT}/ws`;
const ROOM_NAME = process.env.SCALE_ROOM ?? `Scale smoke ${Date.now()}`;
const JWT_SECRET = process.env.JWT_SECRET ?? 'scale-smoke-secret';
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://syncanvas:syncanvas@localhost:5432/syncanvas';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const ROOT = new URL('..', import.meta.url).pathname;
const BUILT_GATEWAY = `${ROOT}server/dist/index.js`;
const TSX = `${ROOT}node_modules/.bin/tsx`;

const failures = [];
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
  if (!ok) failures.push(label);
}

// ---------------------------------------------------------------------------
// Gateways
// ---------------------------------------------------------------------------

function startGateway(port, instanceId) {
  const useBuild = existsSync(BUILT_GATEWAY);
  const env = {
    ...process.env,
    PORT: String(port),
    INSTANCE_ID: instanceId,
    STORE: 'postgres',
    DATABASE_URL,
    REDIS_URL,
    JWT_SECRET,
    SNAPSHOT_EVERY: '25',
    SNAPSHOT_INTERVAL_MS: '1000',
    // The script creates its own room; skip the sandbox seed in both instances.
    PUBLIC_DEMO_ROOM: '',
  };
  return useBuild
    ? spawn(process.execPath, [BUILT_GATEWAY], { env, stdio: 'ignore' })
    : spawn(TSX, [`${ROOT}server/src/index.ts`], { env, stdio: 'ignore' });
}

async function stopGateway(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
  await sleep(200);
}

async function waitForGateway(port, instanceId, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const health = await response.json();
        if (health.store !== 'postgres') {
          throw new Error(`gateway ${port} is using the ${health.store} store, not Postgres`);
        }
        if (health.bus !== 'redis') {
          throw new Error(`gateway ${port} has no Redis bus (health: ${JSON.stringify(health)})`);
        }
        if (health.instance !== instanceId) {
          throw new Error(`gateway ${port} reported instance ${health.instance}`);
        }
        return health;
      }
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    if (Date.now() > deadline) throw new Error(`gateway ${port} did not start`);
    await sleep(100);
  }
}

let gatewayA = startGateway(GATEWAY_A_PORT, 'gateway-a');
let gatewayB = startGateway(GATEWAY_B_PORT, 'gateway-b');

process.on('exit', () => {
  for (const child of [gatewayA, gatewayB]) {
    if (child && child.exitCode === null) child.kill('SIGKILL');
  }
});

const [healthA, healthB] = await Promise.all([
  waitForGateway(GATEWAY_A_PORT, 'gateway-a'),
  waitForGateway(GATEWAY_B_PORT, 'gateway-b'),
]);
console.log(`gateways: ${healthA.instance}/${healthA.bus}, ${healthB.instance}/${healthB.bus}`);

// ---------------------------------------------------------------------------
// Failover proxies
// ---------------------------------------------------------------------------

const proxies = [];

async function startProxy(listenPort, preferredPort, fallbackPort) {
  let preferredUp = true;
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const response = await fetch(`http://127.0.0.1:${preferredPort}/healthz`, {
        signal: AbortSignal.timeout(500),
      });
      preferredUp = response.ok;
    } catch {
      preferredUp = false;
    } finally {
      checking = false;
    }
  }, 200);
  timer.unref();

  const sockets = new Set();
  const server = createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    const upstream = createConnection({
      host: '127.0.0.1',
      port: preferredUp ? preferredPort : fallbackPort,
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', resolve);
  });
  const proxy = {
    async close() {
      clearInterval(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  proxies.push(proxy);
  return proxy;
}

await startProxy(PROXY_A_PORT, GATEWAY_A_PORT, GATEWAY_B_PORT);
await startProxy(PROXY_B_PORT, GATEWAY_B_PORT, GATEWAY_A_PORT);

async function api(base, path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
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

function signIn(base, displayName) {
  return api(base, '/api/auth/guest', { method: 'POST', body: { displayName } });
}

// ---------------------------------------------------------------------------
// Identity and room setup, through separate gateways
// ---------------------------------------------------------------------------

const aliceSession = await signIn(API_A, 'Alice');
const bobSession = await signIn(API_B, 'Bob');
const created = await api(API_A, '/api/rooms', {
  method: 'POST',
  token: aliceSession.token,
  body: { name: ROOM_NAME },
});
const roomId = created.room.id;
const editorInvite = created.invites.editor;
check('the room is created through gateway A', created.room.role, 'owner');

// ---------------------------------------------------------------------------
// Browser sessions
// ---------------------------------------------------------------------------

const browser = await launchBrowser();
const viewport = { width: 1440, height: 900 };
const aliceContext = await browser.newContext({ viewport });
const bobContext = await browser.newContext({ viewport });
const alice = await aliceContext.newPage();
const bob = await bobContext.newPage();

const SESSION_KEY = 'syncanvas.session.v1';
await aliceContext.addInitScript(
  ([key, session]) => {
    try {
      localStorage.setItem(key, JSON.stringify(session));
    } catch {
      // about:blank has no storage; the real document will.
    }
  },
  [SESSION_KEY, { ...aliceSession, server: API_A }],
);
await bobContext.addInitScript(
  ([key, session]) => {
    try {
      localStorage.setItem(key, JSON.stringify(session));
    } catch {
      // about:blank has no storage; the real document will.
    }
  },
  [SESSION_KEY, { ...bobSession, server: API_B }],
);

const errors = [];
collectErrors(alice, 'alice', errors);
collectErrors(bob, 'bob', errors);

async function open(page, name, ws, invite) {
  const url = new URL(BASE_URL);
  url.searchParams.set('room', roomId);
  url.searchParams.set('ws', ws);
  url.searchParams.set('name', name);
  if (invite) url.searchParams.set('invite', invite);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await page.locator('.status-bar__connection--live').waitFor({ timeout: 20_000 });
}

await open(alice, 'Alice', WS_A, editorInvite);
await open(bob, 'Bob', WS_B, editorInvite);

async function peerCount(page) {
  const locator = page.locator('.status-bar__peers strong');
  if ((await locator.count()) === 0) return 0;
  return Number(await locator.innerText());
}

async function waitForPeerCount(page, expected) {
  await page.waitForFunction(
    (count) => document.querySelector('.status-bar__peers strong')?.textContent === String(count),
    expected,
    { timeout: 8_000 },
  );
}

await waitForPeerCount(alice, 2);
await waitForPeerCount(bob, 2);
check('gateway A sees both sessions', await peerCount(alice), 2);
check('gateway B sees both sessions', await peerCount(bob), 2);

// ---------------------------------------------------------------------------
// Cross-instance edits
// ---------------------------------------------------------------------------

const rectOf = (page) =>
  page.locator('[data-object-id="demo-rect"] rect').evaluate((element) => ({
    x: element.getAttribute('x'),
    y: element.getAttribute('y'),
  }));

async function dragRect(page, dx, dy) {
  const target = await page.locator('[data-object-id="demo-rect"] rect').boundingBox();
  if (!target) throw new Error('the demo rectangle did not render');
  const from = { x: target.x + target.width * 0.3, y: target.y + target.height * 0.3 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}

await dragRect(alice, 100, 60);
const bobRect = await rectOf(bob);
check('gateway B receives gateway A’s edit (x)', bobRect.x, '180');
check('gateway B receives gateway A’s edit (y)', bobRect.y, '140');

await dragRect(bob, -40, 20);
const aliceRect = await rectOf(alice);
check('gateway A receives gateway B’s edit (x)', aliceRect.x, '140');
check('gateway A receives gateway B’s edit (y)', aliceRect.y, '160');

// ---------------------------------------------------------------------------
// Kill gateway A; Alice must reconnect through proxy A to gateway B
// ---------------------------------------------------------------------------

await stopGateway(gatewayA);
gatewayA = null;
check(
  'Alice notices gateway A is gone',
  await alice.locator('.status-bar__connection').innerText(),
  'Offline',
);
check(
  'Bob stays live on gateway B',
  await bob.locator('.status-bar__connection').innerText(),
  'Live',
);

await alice.waitForSelector('.status-bar__connection--live', { timeout: 30_000 });
check(
  'Alice reconnects to the surviving gateway',
  await alice.locator('.status-bar__connection').innerText(),
  'Live',
);
await alice.waitForTimeout(400);

const afterFailover = await rectOf(alice);
check('the scene survives failover (x)', afterFailover.x, '140');
check('the scene survives failover (y)', afterFailover.y, '160');

await dragRect(bob, 30, 0);
const afterFailoverEdit = await rectOf(alice);
check('the failed-over client still receives edits', afterFailoverEdit.x, '170');

const beforeCount = await bob.locator('[data-object-id]').count();
await bob.getByRole('button', { name: 'Rect' }).click();
const bobBox = await bob.locator('svg.scene-canvas').boundingBox();
if (!bobBox) throw new Error('the canvas did not render for bob');
await bob.mouse.click(bobBox.x + 700, bobBox.y + 400);
await alice.waitForFunction(
  (count) => document.querySelectorAll('[data-object-id]').length === count,
  beforeCount + 1,
  { timeout: 8_000 },
);
await bob.waitForFunction(
  (count) => document.querySelectorAll('[data-object-id]').length === count,
  beforeCount + 1,
  { timeout: 8_000 },
);
check(
  'the created object crosses the failover',
  await bob.locator('[data-object-id]').count(),
  beforeCount + 1,
);

// Give the persistence queues a moment; snapshots also flush on shutdown.
await alice.waitForTimeout(400);

// ---------------------------------------------------------------------------
// Restart both gateways and restore from Postgres
// ---------------------------------------------------------------------------

await stopGateway(gatewayB);
gatewayB = null;
await alice.waitForSelector('.status-bar__connection--offline', { timeout: 20_000 });

gatewayA = startGateway(GATEWAY_A_PORT, 'gateway-a');
gatewayB = startGateway(GATEWAY_B_PORT, 'gateway-b');
await Promise.all([
  waitForGateway(GATEWAY_A_PORT, 'gateway-a'),
  waitForGateway(GATEWAY_B_PORT, 'gateway-b'),
]);

await alice.waitForSelector('.status-bar__connection--live', { timeout: 30_000 });
await bob.waitForSelector('.status-bar__connection--live', { timeout: 30_000 });
await bob.waitForFunction(
  (count) => document.querySelectorAll('[data-object-id]').length === count,
  beforeCount + 1,
  { timeout: 8_000 },
);

check(
  'Alice is live after the full restart',
  await alice.locator('.status-bar__connection').innerText(),
  'Live',
);
check(
  'Bob is live after the full restart',
  await bob.locator('.status-bar__connection').innerText(),
  'Live',
);
check('Alice is still the room owner', await alice.locator('.role-badge').textContent(), 'owner');
check(
  'the snapshot restores every object',
  await bob.locator('[data-object-id]').count(),
  beforeCount + 1,
);

const restored = await rectOf(bob);
check('the snapshot restores the last edit (x)', restored.x, '170');
check('the snapshot restores the last edit (y)', restored.y, '160');

await dragRect(bob, -20, 10);
const afterRestartEdit = await rectOf(alice);
check('edits still cross instances after the restart (x)', afterRestartEdit.x, '150');
check('edits still cross instances after the restart (y)', afterRestartEdit.y, '170');

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

await browser.close();
await stopGateway(gatewayA);
await stopGateway(gatewayB);
for (const proxy of proxies) await proxy.close();

check('no console errors', errors.length, 0);
if (errors.length > 0) console.error(errors.join('\n'));

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nall scale checks passed');
