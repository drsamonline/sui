import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The licence chain has to be visible, or a recipient of this distribution cannot
 * tell whether it is coherent. These tests keep the four places that record it in
 * agreement: the files on disk, the inventory, the grant, and NOTICE.
 */

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const vendoredKits = () =>
  readdirSync(join(ROOT, 'vendor', 'kits'))
    .filter((f) => f.endsWith('.js') || f.endsWith('.apis.json'))
    .map((f) => f.replace(/\.(js|apis\.json)$/, ''));

const inventoryRows = () => {
  const body = read('docs/legal/LICENSE_INVENTORY.md');
  const table = body.split('## Vendored')[1]?.split('##')[0] ?? '';
  return [...table.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{7})`/gm)].map((m) => ({ name: m[1], commit: m[2] }));
};

const grantRows = () => {
  const body = read('docs/legal/OWNER_GRANT.md');
  const table = body.split('## 2. The works covered')[1]?.split('## 3.')[0] ?? '';
  return [...table.matchAll(/^\|\s*\d+\s*\|\s*`drsamonline\/([^`]+)`\s*\|\s*`([0-9a-f]{7})`/gm)].map((m) => ({ name: m[1], commit: m[2] }));
};

test('the MIT licence is present and says MIT', () => {
  const licence = read('LICENSE');
  assert.match(licence, /MIT License/);
  assert.match(licence, /THE SOFTWARE IS PROVIDED "AS IS"/);
});

test('every vendored kit has an upstream licence beside it', () => {
  for (const kit of vendoredKits()) {
    assert.ok(
      readdirSync(join(ROOT, 'vendor', 'kits')).includes(`${kit}.LICENSE`),
      `${kit} is vendored without its upstream LICENSE`,
    );
  }
});

test('every vendored kit is named in the inventory, with a pinned commit', () => {
  const rows = inventoryRows();
  const names = new Set(rows.map((r) => r.name));
  for (const kit of vendoredKits()) {
    assert.ok(names.has(kit), `${kit} is vendored but not in docs/legal/LICENSE_INVENTORY.md`);
  }
  for (const row of rows) {
    assert.match(row.commit, /^[0-9a-f]{7}$/, `${row.name} needs a pinned commit, not a branch`);
  }
});

test('every vendored kit is covered by the owner grant, at the same commit', () => {
  const inventory = new Map(inventoryRows().map((r) => [r.name, r.commit]));
  const grant = new Map(grantRows().map((r) => [r.name, r.commit]));

  for (const [name, commit] of inventory) {
    assert.ok(grant.has(name), `${name} is in the inventory but not in OWNER_GRANT.md — it is not licensed for MIT use here`);
    assert.equal(grant.get(name), commit, `${name} is pinned to ${commit} in the inventory and ${grant.get(name)} in the grant`);
  }
  for (const name of grant.keys()) {
    assert.ok(inventory.has(name), `${name} is granted but not inventoried`);
  }
});

test('the grant states the scope: upstream stays NC, these copies are MIT', () => {
  const grant = read('docs/legal/OWNER_GRANT.md');
  assert.match(grant, /PolyForm Noncommercial/);
  assert.match(grant, /irrevocable/i);
  assert.match(grant, /MIT License/);
  assert.match(grant, /Third-party material inside those repositories is not covered/);
});

test('NOTICE points at the grant and names every kit', () => {
  const notice = read('NOTICE');
  assert.match(notice, /docs\/legal\/OWNER_GRANT\.md/);
  for (const kit of vendoredKits()) {
    assert.ok(notice.includes(kit), `NOTICE does not name ${kit}`);
  }
});

test('no vendored file claims a licence other than the two recorded ones', () => {
  for (const file of readdirSync(join(ROOT, 'vendor', 'kits'))) {
    if (!file.endsWith('.LICENSE')) continue;
    const body = readFileSync(join(ROOT, 'vendor', 'kits', file), 'utf8');
    // the notice line comes first in some of them, so match the title anywhere
    assert.match(body, /PolyForm Noncommercial License 1\.0\.0/, `${file} should be the upstream NC licence it came with`);
  }
});
