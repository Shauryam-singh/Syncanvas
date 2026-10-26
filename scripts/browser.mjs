/**
 * Browser resolution shared by the smoke scripts.
 *
 * GitHub runners ship Google Chrome, which playwright can drive directly, but
 * the bundled Chromium is not installed there. Locally the playwright browser
 * cache is used instead, so `npm run smoke` works without any environment
 * variable.
 *
 *   CHROMIUM_PATH  exact binary to drive
 *   SMOKE_CHANNEL  playwright channel ('chrome' uses the system Google Chrome)
 *   default        a Chromium in the playwright browser cache, if there is one
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

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

export function resolveExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  // A channel names a browser that playwright resolves itself. Passing an
  // `executablePath` as well would override the channel and fail, because the
  // bundled Chromium is not installed on a plain CI runner.
  if (process.env.SMOKE_CHANNEL) return undefined;
  const bundled = chromium.executablePath?.();
  if (bundled && existsSync(bundled)) return bundled;
  return cachedChromium();
}

/** Launches a Chromium that the smoke scripts can drive. */
export function launchBrowser() {
  return chromium.launch({
    executablePath: resolveExecutable(),
    channel: process.env.SMOKE_CHANNEL,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

/**
 * Console noise that is expected and must not fail a smoke test.
 *
 * The editor probes the HTTP API and dials the WebSocket on start-up. When the
 * gateway is not running — which is exactly the situation `npm run smoke`
 * covers — the browser logs the refused connection. The editor then falls back
 * to local mode, so this is a normal situation, not a bug.
 */
const EXPECTED_NETWORK_ERRORS = [
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_ABORTED',
];

export function isExpectedNoise(text) {
  return (
    text.includes('WebSocket connection to') ||
    EXPECTED_NETWORK_ERRORS.some((fragment) => text.includes(fragment))
  );
}

/** Collects the console errors of a page, ignoring the expected noise. */
export function collectErrors(page, label, errors) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.includes('404') || isExpectedNoise(text)) return;
    errors.push(`${label}: ${text}`);
  });
  page.on('pageerror', (error) => errors.push(`${label}: ${String(error)}`));
}
