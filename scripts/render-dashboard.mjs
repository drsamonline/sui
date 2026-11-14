#!/usr/bin/env node
/**
 * Dev tool: render the dashboard with realistic traffic so a change can be seen.
 * Not shipped, not part of the test suite. Needs a Chrome and puppeteer-core:
 *
 *   PUPPETEER_PATH=/usr/lib/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js \
 *   CHROME_PATH=/usr/local/bin/chromium node scripts/render-dashboard.mjs
 */

import { createGateway } from '@sui/gateway';

const config = {
  server: { host: '127.0.0.1', port: 0, cache: { enabled: true, ttlMs: 60000, maxEntries: 100 } },
  providers: {
    'demo-a': { type: 'mock', mock: { delayMs: 8 }, tier: 'free', tos: 'allowed' },
    'demo-b': { type: 'mock', mock: { delayMs: 20 }, tier: 'free', tos: 'allowed' },
    'demo-c': { type: 'mock', mock: { delayMs: 35 }, tier: 'free', tos: 'review' },
  },
  models: {
    'fast-free': { provider: 'demo-a', model: 'fast-free', label: 'Fast and free', costPer1kIn: 0, costPer1kOut: 0, quality: 2, tier: 'free' },
    balanced: { provider: 'demo-b', model: 'balanced', label: 'Balanced everyday', costPer1kIn: 0.0003, costPer1kOut: 0.0025, quality: 4 },
    careful: { provider: 'demo-c', model: 'careful', label: 'Careful writer', costPer1kIn: 0.0008, costPer1kOut: 0.004, quality: 5 },
  },
  combos: {
    'chat-default': { label: 'Everyday chat', strategy: 'fallback', targets: ['balanced', 'fast-free', 'careful'] },
    cheap: { label: 'Cheapest that still works', strategy: 'cheapest', minQuality: 2, targets: ['fast-free', 'balanced', 'careful'] },
    coding: { label: 'Coding help', strategy: 'fallback', targets: ['careful', 'balanced'] },
    split: { label: 'Split 70/30 between two providers', strategy: 'weighted', targets: [{ model: 'balanced', weight: 70 }, { model: 'careful', weight: 30 }] },
  },
  breaker: { failures: 2, cooldownMs: 60000 },
  budgets: { dailyUsd: 0.02, warnAtPct: 80, perProvider: {} },
  guardrails: { maxOutputTokens: 4096, maxInputChars: 400000, blockPatterns: [], logPrompts: false, redactPiiInLogs: true },
  paid_tiers: { enabled: false },
  apiKeys: [],
};

const gw = await createGateway({ configObject: config, ledgerFile: null, env: { ...process.env } });
await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
const port = gw.server.address().port;

const prompts = [
  'Review this function for off-by-one bugs',
  'Refactor this module for readability',
  'Explain what this regex does',
  'Summarize these nginx logs',
  'Write tests for the breaker state machine',
  'Why is my p95 latency 3x the p50?',
  'Draft a migration note for the team',
  'Check this SQL for a missing index',
];
for (let i = 0; i < 24; i++) {
  const combo = ['chat-default', 'cheap', 'coding', 'split'][i % 4];
  await gw.router.chat({ combo, body: { messages: [{ role: 'user', content: prompts[i % prompts.length] }] } });
}
gw.breaker.recordFailure('careful', 'demo-c is rate-limiting requests right now.');
gw.breaker.recordFailure('careful', 'demo-c is rate-limiting requests right now.');

const puppeteerPath = process.env.PUPPETEER_PATH ?? 'puppeteer-core';
const { default: puppeteer } = await import(puppeteerPath);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/local/bin/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: 'docs/screenshots/dashboard-light.png', fullPage: true });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: 'docs/screenshots/dashboard-dark.png', fullPage: true });
await browser.close();
gw.server.closeAllConnections?.();
gw.server.close();
console.log('rendered docs/screenshots/dashboard-{light,dark}.png');
