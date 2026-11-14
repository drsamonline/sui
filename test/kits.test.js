import test from 'node:test';
import assert from 'node:assert/strict';
import { loadKit, kitStatus, KIT_GLOBALS } from '@sui/kits';

test('every vendored kit loads in an isolated context', () => {
  const status = kitStatus();
  assert.equal(status.length, Object.keys(KIT_GLOBALS).length);
  for (const kit of status) {
    assert.equal(kit.loaded, true, `${kit.name} failed: ${kit.error}`);
    assert.ok(kit.version, `${kit.name} did not report a version`);
  }
});

test('kits do not leak into the host global scope', () => {
  loadKit('crypto-kit');
  loadKit('ml-kit');
  assert.equal('CryptoKit' in globalThis, false);
  assert.equal('MLKit' in globalThis, false);
});

test('crypto-kit seals and opens a value, and rejects the wrong passphrase', async () => {
  const CryptoKit = loadKit('crypto-kit');
  assert.equal(CryptoKit.available(), true);

  const sealed = await CryptoKit.sealString('provider-key-abc', 'correct horse battery staple', { iterations: 1000 });
  assert.equal(typeof sealed, 'string');
  assert.equal(sealed.includes('provider-key-abc'), false, 'the sealed envelope must not contain the plaintext');

  const opened = await CryptoKit.openString(sealed, 'correct horse battery staple');
  assert.equal(opened, 'provider-key-abc');

  await assert.rejects(() => CryptoKit.openString(sealed, 'wrong passphrase'));
});

test('ml-kit ranks the matching document first', () => {
  const MLKit = loadKit('ml-kit');
  const index = MLKit.tfidf(['reverse a linked list in python', 'summarise nginx access logs']);
  const hits = MLKit.search(index, 'reverse linked list', 2);
  assert.equal(hits[0].i, 0);
  assert.ok(hits[0].score > 0.5);
});

test('tokens-kit computes WCAG contrast', () => {
  const Tokens = loadKit('tokens-kit');
  assert.equal(Tokens.contrast('#000000', '#ffffff'), 21);
  assert.ok(Tokens.contrast('#8e8e88', '#ffffff') >= 3);
  assert.ok(Tokens.contrast('#b9b9b2', '#ffffff') < 3, 'the old border token really was below AA');
});

test('compress-kit round-trips a string', async () => {
  const Compress = loadKit('compress-kit');
  const text = 'the same line, over and over. '.repeat(200);
  const bytes = await Compress.compressString(text);
  assert.ok(bytes.length < text.length / 4, 'repetitive text should compress hard');
  assert.equal(await Compress.decompressString(bytes), text);
});

test('search-kit ranks a query and returns the item', () => {
  const Search = loadKit('search-kit');
  const index = Search.index([{ t: 'weather forecast' }, { t: 'llm chat completion' }], { keys: ['t'] });
  const hits = index.query('chat completion');
  assert.equal(hits[0].item.t, 'llm chat completion');
});

test('an unknown kit says which kits exist', () => {
  assert.throws(() => loadKit('not-a-kit'), /Known kits:/);
});
