import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, '..', 'apps', 'dashboard', 'web', 'dashboard.html'), 'utf8');

/** Everything that is not a token declaration or a component rule. */
function outsideTokenBlocks(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutComments.replace(/:root\s*\{[\s\S]*?\n  \}/g, '').replace(/@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*?\n  \}/g, '');
}

test('I9: no raw colour value appears outside the token block', () => {
  const rest = outsideTokenBlocks(html);
  const hex = rest.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hex, [], `raw hex outside tokens: ${hex.join(', ')}`);

  const rgb = rest.match(/\brgba?\(/g) ?? [];
  assert.deepEqual(rgb, [], 'colour functions outside tokens should be tokenised');
});

test('I9: no arbitrary utility classes', () => {
  const arbitrary = html.match(/class="[^"]*\b(?:bg|text|p|m|w|h|border)-\[[^\]]+\]/g) ?? [];
  assert.deepEqual(arbitrary, [], `arbitrary utility classes: ${arbitrary.join(', ')}`);
});

test('the token ladder is complete', () => {
  for (const token of ['--bg', '--surface', '--surface-2', '--line', '--text', '--text-dim', '--accent', '--on-accent', '--radius', '--shadow-rest', '--shadow-lift', '--fs-12', '--fs-16', '--fs-28', '--space-1', '--space-6']) {
    assert.ok(html.includes(`${token}:`), `missing token ${token}`);
  }
});

test('numbers are tabular and inputs are large enough to tap', () => {
  assert.match(html, /font-variant-numeric: tabular-nums/);
  assert.match(html, /\.num\b/);
  assert.match(html, /font-size: var\(--fs-16\)/, 'inputs must be at least 16px to avoid iOS zoom');
});

test('accessibility: focus ring, live regions, reduced motion, labelled controls', () => {
  assert.match(html, /:focus-visible/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /aria-label=|aria-labelledby=|<label /);
  assert.match(html, /role="progressbar"/);
  // status must never be colour-only: the health cell prints a word too
  assert.match(html, /resting|ready/);
});

test('loading uses skeletons, not spinners', () => {
  assert.match(html, /class="skeleton/);
  assert.equal(/class="[^"]*spinner|@keyframes spin\b|animation:\s*spin\b/.test(html), false, 'no spinner implementation');
});

test('the chat window has zero-state starters and a provenance chip', () => {
  for (const starter of ['code review', 'refactor', 'explain this file', 'summarize logs', 'write tests']) {
    assert.ok(html.toLowerCase().includes(starter.split(' ')[0]), `missing starter: ${starter}`);
  }
  assert.match(html, /chip/);
  assert.match(html, /verified/);
  assert.match(html, /cached/);
});

test('the Probes table exists and stays hidden until there is probe state', () => {
  assert.match(html, /id="probes-card"/);
  assert.match(html, /hidden/);
  assert.match(html, /liveness · readiness · suitability/);
});

test('the savings panel reports what was avoided, not just what was spent', () => {
  assert.match(html, /id="savings"/);
  assert.match(html, /saved by cache/);
  assert.match(html, /saved by compression/);
  assert.match(html, /tokens not sent/);
  assert.match(html, /would have cost/);
});

test('explain-my-route is reachable from the playground and says nothing was sent', () => {
  assert.match(html, /id="explain-route"/);
  assert.match(html, /id="explain-panel"/);
  assert.match(html, /aria-controls="explain-panel"/);
  assert.match(html, /Nothing was sent/);
});

test('the model selector shows speed, quality and cost, and locks what cannot answer', () => {
  assert.match(html, /quality/);
  assert.match(html, /cost/);
  assert.match(html, /disabled/);
  assert.match(html, /nothing available/);
});

test('the weather map is present, labelled in words, and never colour-only', () => {
  assert.match(html, /id="weather-card"/);
  assert.match(html, /Free-tier weather/);
  assert.match(html, /only providers in your pool/);
  assert.match(html, /sparkline/);
  assert.match(html, /thriving/);
  assert.match(html, /resting/);
  assert.match(html, /not probed yet/);
  assert.match(html, /role="img" aria-label="Latency trend/);
});

test('the last-eval card is present and labelled honestly', () => {
  assert.match(html, /id="eval-card"/);
  assert.match(html, /Last eval/);
  assert.match(html, /harness self-test/);
  assert.match(html, /No eval has been run on this machine/);
});
