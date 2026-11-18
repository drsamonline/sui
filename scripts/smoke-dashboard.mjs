#!/usr/bin/env node
/**
 * Load the dashboard in a real browser and fail on anything it complains about.
 *
 * A renderer that only takes a screenshot cannot tell you the page is broken: a
 * JavaScript error leaves a half-drawn layout that photographs fine. This loads
 * the page against a live gateway, records console errors, page errors and failed
 * requests, and exits non-zero if there are any.
 *
 * Run: node scripts/smoke-dashboard.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH ?? '/usr/local/bin/chromium';

const puppeteerPath =
  process.env.PUPPETEER_PATH ?? '/usr/lib/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
if (!existsSync(puppeteerPath)) {
  console.log('puppeteer-core is not installed here; skipping the browser smoke test.');
  process.exit(0);
}
const puppeteer = (await import(puppeteerPath)).default;

// A gateway with a live config, workers on, and one reachable mock provider, so
// every panel has data to draw rather than an empty state.
const { createGateway } = await import('@drsamonline/gateway');

/**
 * Three states, because a dashboard usually breaks in the two that are not the
 * happy path:
 *
 *   healthy   a mock provider that answers
 *   empty     the real fresh-install state: a provider declared, no API key set,
 *             so nothing can answer. A gateway with *no* providers at all is
 *             refused by config validation with a message naming the fix, which
 *             is the correct behaviour and not something to render.
 *   degraded  a provider that is configured and unreachable
 */
const scenario = process.argv.includes('--empty') ? 'empty' : process.argv.includes('--degraded') ? 'degraded' : 'healthy';

const base = {
  server: { host: '127.0.0.1', port: 0, cache: { enabled: true, ttlMs: 60000, maxEntries: 50 } },
  providers:
    scenario === 'empty'
      ? { groq: { type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY_NOT_SET' } }
      : scenario === 'degraded'
        ? { broken: { type: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: null, timeoutMs: 400 } }
        : { mock: { type: 'mock', mock: { delayMs: 1 } } },
  models:
    scenario === 'empty'
      ? { 'groq-70b': { provider: 'groq', model: 'llama-3.3-70b-versatile', costPer1kIn: 0, costPer1kOut: 0, quality: 4, label: 'Llama 70B' } }
      : scenario === 'degraded'
        ? { 'broken-1': { provider: 'broken', model: 'broken-1', costPer1kIn: 1, costPer1kOut: 1, quality: 3, label: 'Broken one' } }
        : { 'mock-1': { provider: 'mock', model: 'mock-1', costPer1kIn: 0, costPer1kOut: 0, quality: 3, label: 'Mock one' } },
  combos:
    scenario === 'empty'
      ? { 'chat-default': { label: 'Everyday chat', strategy: 'fallback', targets: ['groq-70b'] } }
      : scenario === 'degraded'
        ? { 'chat-default': { label: 'Everyday chat', strategy: 'fallback', targets: ['broken-1'] } }
        : { 'chat-default': { label: 'Everyday chat', strategy: 'fallback', targets: ['mock-1'] } },
  budgets: { dailyUsd: 5, warnAtPct: 80 },
  guardrails: { logPrompts: false },
  paidTiers: { enabled: false },
  apiKeys: [],
  workers: { enabled: true, kickoffMs: 50, prober: { enabled: false }, cacheSweepMs: 0, driftIntervalMs: 0, alertIntervalMs: 0 },
};

const config = base;
const gateway = await createGateway({ configObject: config, ledgerFile: null, startWorkers: true });
await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
const { port } = gateway.server.address();

// real turns so the ledger, history and savings panels have something to draw.
// In the degraded scenario these fail on purpose: a failing gateway must still
// render, and that is the case a dashboard usually breaks in.
if (scenario !== 'empty') {
  for (let i = 0; i < 3; i++) {
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sui-user': 'smoke', 'x-sui-tool': 'dashboard-test' },
      body: JSON.stringify({ model: 'chat-default', messages: [{ role: 'user', content: `hello ${i}` }] }),
    }).catch(() => {});
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1200 });

const problems = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
});
page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
page.on('requestfailed', (req) => problems.push(`request failed: ${req.url()}`));
page.on('response', (res) => {
  if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
});

await page.goto(`http://127.0.0.1:${port}/dashboard`, { waitUntil: 'networkidle0', timeout: 30_000 });

// wait for the first status paint rather than a fixed sleep
await page.waitForFunction(() => document.querySelector('#budget-bar, .budget, [data-budget]') !== null, { timeout: 15_000 }).catch(() => {});

// the panels a user judges the page by
const probe = await page.evaluate(() => ({
  combos: document.querySelectorAll('#combo option').length,
  thread: document.querySelectorAll('#thread .bubble, #thread > *').length,
  hasCompress: Boolean(document.querySelector('#compress-card')),
  hasWeather: Boolean(document.querySelector('#weather-card')),
  hasTopology: Boolean(document.querySelector('#topology svg, svg')),
  bodyText: document.body.innerText.slice(0, 200),
}));

await browser.close();
await gateway.close();

console.log('');
console.log(`Dashboard smoke test — ${scenario}`);
console.log('');
console.log(`  combos in the selector   ${probe.combos}`);
console.log(`  compress card present    ${probe.hasCompress}`);
console.log(`  weather card present     ${probe.hasWeather}`);
console.log(`  topology rendered        ${probe.hasTopology}`);
console.log('');

// A console 404 carries no URL, so the response listener is what names it. Keep
// the filter narrow: an aborted request is a page navigating away, nothing else
// gets a free pass.
const fatal = problems.filter((p) => !/net::ERR_ABORTED/i.test(p));
if (fatal.length) {
  console.log(`  ${fatal.length} problem(s):`);
  for (const problem of [...new Set(fatal)].slice(0, 20)) console.log(`   - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('  No console errors, no page errors, no failed requests.');
}
