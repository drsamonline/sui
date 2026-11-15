import test from 'node:test';
import assert from 'node:assert/strict';


/* ------------------------------------------------- ADRs and contributing */

test('every ADR states its status, its context and its decision', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(process.cwd(), 'docs', 'adr');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));

  assert.ok(files.length >= 12, `expected at least 12 ADRs, found ${files.length}`);
  for (const file of files) {
    const body = readFileSync(join(dir, file), 'utf8');
    assert.match(body, /^# ADR-\d{4} — .+/, `${file} needs a titled heading`);
    assert.match(body, /\*\*Status:\*\*\s*(accepted|superseded|proposed|deprecated)/i, `${file} needs a status line`);
    assert.match(body, /## Context/, `${file} needs a Context section`);
    assert.match(body, /## Decision/, `${file} needs a Decision section`);
    assert.match(body, /## Consequences/, `${file} needs a Consequences section`);
  }
});

test('the ADR numbering has no gaps', async () => {
  const { readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const numbers = readdirSync(join(process.cwd(), 'docs', 'adr'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => Number(f.slice(0, 4)))
    .sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, i) => i + 1), 'ADRs are numbered 1..n with no gaps');
});

test('CONTRIBUTING states the invariant rule and names the four harnesses', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const body = readFileSync(join(process.cwd(), 'CONTRIBUTING.md'), 'utf8');
  for (const harness of ['npm test', 'npm run audit', 'npm run eval:self', 'npm run soak']) {
    assert.ok(body.includes(harness), `CONTRIBUTING must name ${harness}`);
  }
  assert.match(body, /enforcedBy/);
  assert.match(body, /provenBy/);
  assert.match(body, /Do not add a runtime dependency/);
});
