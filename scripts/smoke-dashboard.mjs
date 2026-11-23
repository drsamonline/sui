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
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dedupeEntries, loadSeed, poolKey } from '@drsamonline/catalog';

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
const scenario = process.argv.includes('--empty')
  ? 'empty'
  : process.argv.includes('--degraded')
    ? 'degraded'
    : process.argv.includes('--tenants')
      ? 'tenants'
      : 'healthy';

/**
 * In the tenants scenario the gateway needs a key, the way a shared deployment
 * does. Sending it from the page is the point: the dashboard's own fetches have to
 * carry it too, or every panel renders a 401.
 */
const SMOKE_KEY = scenario === 'tenants' ? 'smoke-tenant-key' : null;
/** The two scenarios whose whole point is that the gateway cannot answer. */
const failingScenario = scenario === 'empty' || scenario === 'degraded';
const authHeaders = SMOKE_KEY ? { authorization: `Bearer ${SMOKE_KEY}` } : {};

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
  apiKeys:
    scenario === 'tenants'
      ? [
          // one pinned tenant with a rate limit: the two refusals a console exists
          // to explain are 403 (pinned elsewhere) and 429 (over the rate)
          { name: 'team-a', key: SMOKE_KEY, dailyUsd: 2, rateLimit: { rpm: 60 }, forcedModel: 'chat-default' },
          { name: 'team-b', key: 'smoke-second-key', allowedCombos: ['chat-default'], rateLimit: { rpm: 10 } },
        ]
      : [],
  // one scenario turns page probing on, so the button is exercised where it exists
  dashboard: { allowProbe: scenario === 'tenants' },
  workers: { enabled: true, kickoffMs: 50, prober: { enabled: false }, cacheSweepMs: 0, driftIntervalMs: 0, alertIntervalMs: 0 },
};

const config = base;

// A durable probe history, so the provider detail has real samples to draw: the
// worker writes these to disk, and they are the only part that survives a restart.
const catalogueDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'catalog');
const catalogueEntries = dedupeEntries(loadSeed(join(catalogueDir, 'seed.json')));
const historyTarget = [...catalogueEntries].sort((a, b) => a.provider.localeCompare(b.provider))[0];
const historyFile = join(tmpdir(), `sui-smoke-history-${process.pid}.jsonl`);
writeFileSync(
  historyFile,
  [0, 1, 2, 3]
    .map((i) =>
      JSON.stringify({
        ts: Date.now() - (4 - i) * 60000,
        modelId: poolKey(historyTarget),
        ok: i !== 2,
        latencyMs: 280 + i * 45,
        state: i === 2 ? 'open' : 'closed',
      }),
    )
    .join('\n') + '\n',
);

const gateway = await createGateway({ configObject: config, ledgerFile: null, startWorkers: true, historyFile });
await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
const { port } = gateway.server.address();

// real turns so the ledger, history and savings panels have something to draw.
// In the degraded scenario these fail on purpose: a failing gateway must still
// render, and that is the case a dashboard usually breaks in.
if (scenario !== 'empty') {
  for (let i = 0; i < 3; i++) {
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sui-user': 'smoke', 'x-sui-tool': 'dashboard-test', ...authHeaders },
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

if (SMOKE_KEY) await page.setExtraHTTPHeaders({ authorization: `Bearer ${SMOKE_KEY}` });
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

// ---- the tenant console ---------------------------------------------------
// The API enforces a cap, a rate and a pinned model per key; the page showed the
// spend and neither of the two that decide whether a request is refused.
{
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('#tenants-body tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()),
  );
  if (!rows.length) problems.push('the tenant panel rendered no rows at all');

  if (scenario === 'tenants') {
    if (rows.length !== 2) problems.push(`the tenant panel showed ${rows.length} row(s), expected 2`);
    if (!rows.some((r) => /team-a/.test(r))) problems.push('the tenant panel did not list team-a');
    if (!rows.some((r) => /chat-default/.test(r))) problems.push('the tenant panel did not show the pinned model');
    if (!rows.some((r) => /60\/min/.test(r))) problems.push('the tenant panel did not show the rate limit');
    console.log(`  tenants panel            ${rows.length} key(s), pin and rate shown`);

    // The one write on the page. It is a form, not a stepper, and it has to say
    // what the change means: the API applies it in memory, and a cap that silently
    // reverts on restart is worse than no control.
    await page.click('button[data-cap="team-a"]');
    await page.click('#cap-team-a', { clickCount: 3 });
    await page.type('#cap-team-a', '3.5');
    await page.click('#rpm-team-a', { clickCount: 3 });
    await page.type('#rpm-team-a', '45');
    await page.click('form.tenant-form button[type="submit"]');
    await new Promise((r) => setTimeout(r, 700));
    const changed = await page.evaluate(() => ({
      table: document.querySelector('#tenants-body')?.innerText.replace(/\s+/g, ' ') ?? '',
      msg: document.querySelector('#tenants-msg')?.innerText ?? '',
    }));
    if (!/\$3\.5/.test(changed.table)) problems.push('the new cap did not reach the table');
    if (!/45\/min/.test(changed.table)) problems.push('the new rate did not reach the table');
    if (!/cap .*→/.test(changed.msg)) problems.push('the page did not say what the cap changed from and to');
    if (!/sui\.config\.json/.test(changed.msg)) problems.push('the page did not say the change is in memory only');
    console.log('  cap change               applied through the page, and explained');
  } else if (!/No API keys are configured/.test(rows.join(' '))) {
    problems.push('the tenant panel did not explain that no keys are configured');
  }
}

// ---- the catalogue, on the page ------------------------------------------
// `sui catalog` was the only way to see what this gateway could route to. The
// page has to say how many identities are waiting for a probe, and open one.
{
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('#providers-body tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()),
  );
  if (rows.length < 10) problems.push(`the providers card listed ${rows.length} entries; the catalogue has more`);
  const note = await page.evaluate(() => document.querySelector('#providers-note')?.innerText ?? '');
  if (!/awaiting a probe/.test(note)) problems.push('the providers card did not say how many entries await a probe');

  await page.click(`button[data-provider="${historyTarget.provider}"]`);
  await new Promise((r) => setTimeout(r, 200));
  const detail = await page.evaluate(() => document.querySelector('#providers-body tr.provider-detail')?.innerText.replace(/\s+/g, ' ') ?? '');
  if (!detail) problems.push('clicking Details opened nothing');
  else if (!/identity with an endpoint|route|nothing to probe/i.test(detail)) problems.push('the provider detail did not say whether it is a route');

  if (!/sample\(s\) over the last|No durable probe history/.test(detail)) problems.push('the provider detail said nothing about durable history');
  else if (!/4 sample\(s\)/.test(detail)) problems.push('the seeded probe history did not reach the provider detail');
  else console.log('  provider history         drawn from the history file');

  // the window is a control, and changing it must redraw the same provider
  const select = await page.$('select[data-history-hours]');
  if (!select) problems.push('the history block offered no window control');
  else {
    await page.select('select[data-history-hours]', '1');
    await new Promise((r) => setTimeout(r, 400));
    const after = await page.evaluate(() => ({
      detail: document.querySelector('#providers-body tr.provider-detail')?.innerText.replace(/\s+/g, ' ') ?? '',
      hours: document.querySelector('select[data-history-hours]')?.value ?? '',
    }));
    if (after.hours !== '1') problems.push('the window control did not stay on the chosen window');
    if (!/last 1h/.test(after.detail)) problems.push('the detail did not redraw for the chosen window');
    else console.log('  history window           redraws the same provider');
  }

  // Probing from the page is a network action, so it is off unless asked for, and
  // the page has to say which of the two it is.
  const probeButton = await page.evaluate(() => Boolean(document.querySelector('button[data-probe]')));
  if (scenario === 'tenants') {
    if (!probeButton) problems.push('probing was allowed but the page offered no probe button');
    if (!/reports; it does not promote|does not promote/i.test(detail)) problems.push('the probe control did not say it will not promote');
  } else if (probeButton) {
    problems.push('the page offered a probe button with dashboard.allowProbe off');
  } else if (!/allowProbe|terminal/i.test(detail)) {
    problems.push('the provider detail did not say why it cannot probe');
  }
  console.log(`  providers card           ${rows.length} entries, detail opens`);
}

// ---- the Send button has to do something ---------------------------------
// It did not: send() threw ReferenceError on its first line (threadEl was never
// defined), so a click did nothing at all and looked like a dead page. Nothing in
// this script clicked it, which is why it shipped.
{
  const before = await page.evaluate(() => document.querySelector('#thread')?.innerText.length ?? 0);

  await page.click('#send');
  await new Promise((r) => setTimeout(r, 300));
  const emptyClick = await page.evaluate(() => document.querySelector('#thread')?.innerText ?? '');
  if (!/Type a message first/.test(emptyClick)) problems.push('clicking Send with an empty box said nothing');

  await page.type('#prompt', 'hello from the smoke test');
  await page.click('#send');
  await new Promise((r) => setTimeout(r, 1200));
  const after = await page.evaluate(() => ({
    text: document.querySelector('#thread')?.innerText ?? '',
    length: document.querySelector('#thread')?.innerText.length ?? 0,
  }));
  if (after.length <= before) problems.push('clicking Send with a prompt produced no answer in the thread');
  if (!/hello from the smoke test/i.test(after.text)) problems.push('the answer did not echo the prompt');

  // In the two failing scenarios the 5xx is tolerated below — but only because the
  // page says what broke. Without this, "expected failure" would mean "the page may
  // show nothing at all", which is the opposite of what these scenarios test.
  const saysWhatBroke = /no model could answer|could not answer|no api key|failed|error/i.test(after.text);
  if (failingScenario && !saysWhatBroke) problems.push('a failing route produced no explanation in the thread');
  if (!failingScenario && saysWhatBroke) problems.push('a working route reported a failure in the thread');
  console.log(`  send button              ${after.length > before ? 'answered' : 'DEAD'}`);
}

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
//
// The two failing scenarios are the exception, and they have to be: there the
// gateway is configured to fail — no key in `empty`, an unreachable provider in
// `degraded` — the page clicks Send, and a 5xx is the behaviour under test. The
// page must *say* what broke, not avoid it. Counting that 5xx as a page problem
// made the scenarios that matter impossible to pass, and this job had been red
// for that reason alone.
//
// Narrow on purpose: only a 5xx from the chat endpoint, and only the exact console
// line Chromium emits for it (that message carries no URL, so a wider pattern
// would also excuse a broken /api route).
const expectedFailure = (problem) =>
  failingScenario &&
  (/^HTTP 5\d\d: .*\/v1\/chat\/completions/.test(problem) ||
    /^console: Failed to load resource: the server responded with a status of 5\d\d/.test(problem));

const fatal = problems.filter((p) => !/net::ERR_ABORTED/i.test(p) && !expectedFailure(p));
if (fatal.length) {
  console.log(`  ${fatal.length} problem(s):`);
  for (const problem of [...new Set(fatal)].slice(0, 20)) console.log(`   - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('  No console errors, no page errors, no failed requests.');
}
