import test from 'node:test';
import assert from 'node:assert/strict';
/* ------------------------------------------- Indian languages (0.12.18) */

test('every language translates every key, or the key is not shipped', async () => {
  const { STRINGS } = await import('../packages/core/src/i18n.js');
  const keys = Object.keys(STRINGS.en);

  // A half-translated interface that mixes languages mid-sentence is worse than an
  // English one, so the rule is: a key is either fully translated or it does not
  // exist in that language.
  for (const [code, table] of Object.entries(STRINGS)) {
    if (code === 'en') continue;
    assert.deepEqual(
      Object.keys(table).sort(),
      [...keys].sort(),
      `${code} does not translate the same keys as English`,
    );
    for (const [key, value] of Object.entries(table)) {
      assert.ok(String(value).trim().length > 0, `${code}.${key} is empty`);
    }
  }
});

test('placeholders survive translation, so a message cannot lose its value', async () => {
  const { STRINGS } = await import('../packages/core/src/i18n.js');
  const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  for (const [code, table] of Object.entries(STRINGS)) {
    for (const [key, value] of Object.entries(table)) {
      assert.deepEqual(
        placeholders(value),
        placeholders(STRINGS.en[key]),
        `${code}.${key} changed its placeholders — the message would print "{port}" literally`,
      );
    }
  }
});

test('an unknown language falls back to English instead of throwing', async () => {
  const { t, normaliseLocale, direction } = await import('../packages/core/src/i18n.js');

  // a typo in a language code must not stop the gateway from starting
  assert.equal(normaliseLocale('xx-YY'), 'en');
  assert.equal(normaliseLocale('hi-IN'), 'hi');
  assert.equal(normaliseLocale('HI'), 'hi');
  assert.equal(t('glance.turns', {}, { locale: 'klingon' }), 'turns today');
  assert.equal(direction('hi'), 'ltr');
  assert.equal(direction('ur'), 'rtl');
});

test('SUI_LANG selects the language, and {placeholders} are filled', async () => {
  const { t } = await import('../packages/core/src/i18n.js');
  const before = process.env.SUI_LANG;

  process.env.SUI_LANG = 'hi';
  const hindi = t('err.port_in_use', { port: 8787, command: './sui', next: 8788 });
  assert.match(hindi, /8787/);
  assert.match(hindi, /8788/);
  assert.equal(/Port .* already in use/.test(hindi), false, 'the sentence is not English');

  if (before === undefined) delete process.env.SUI_LANG;
  else process.env.SUI_LANG = before;
});

test('the CLI answers --help in the selected language', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['apps/cli/bin/sui.js', '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, SUI_LANG: 'gu' },
    timeout: 60_000,
  });
  assert.match(out, /દરેક LLM માટે એક એન્ડપોઇન્ટ/, 'the tagline is Gujarati');
});

test('the boundary of what is translated is written down', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const path = join(process.cwd(), 'docs', 'LANGUAGES.md');
  assert.ok(existsSync(path), 'a translation claim needs a page saying what is translated');

  const doc = readFileSync(path, 'utf8');
  // the two surfaces that are deliberately English must be named, not left to be
  // discovered by someone who reads Hindi and finds a half-English page
  assert.match(doc, /numeric foot lines/i);
  assert.match(doc, /detail tables below the fold/i);
  assert.match(doc, /identifiers/);
  // and the claim must be bounded rather than a language count
  assert.match(doc, /A translation you cannot check is a guess/);
});
