/**
 * @sui/kits — the vendored drsamonline kits, loaded safely.
 *
 * Each kit is a single-file, dependency-free IIFE that attaches itself to a
 * global (`CryptoKit`, `MLKit`, `Search`, `Tokens`, `Compress`, `Export`,
 * `Loom`). They were written for the browser, so they are evaluated in an
 * isolated `node:vm` context rather than imported: no global pollution, no
 * ESM/CJS mismatch, and a broken kit cannot take the gateway down with it.
 *
 * Licence: each kit carries its own LICENSE file in vendor/kits/. The owner of
 * those repositories has authorised their use in this MIT project; see
 * docs/legal/LICENSE_INVENTORY.md for the authorisation and the outstanding
 * upstream licence-file update.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const KITS_DIR = join(HERE, '..', '..', '..', 'vendor', 'kits');

/** file name -> the global the kit attaches to */
export const KIT_GLOBALS = {
  'crypto-kit': 'CryptoKit',
  'ml-kit': 'MLKit',
  'search-kit': 'Search',
  'tokens-kit': 'Tokens',
  'compress-kit': 'Compress',
  'export-kit': 'Export',
  'web-kit': 'Loom',
};

/** @type {Map<string, any>} */
const cache = new Map();

/**
 * Load a kit by short name (`crypto-kit`, `ml-kit`, …).
 * Throws with a plain message if the file is missing, so a trimmed checkout says
 * what is missing instead of failing later inside a feature.
 * @param {string} name
 * @returns {any}
 */
export function loadKit(name) {
  if (cache.has(name)) return cache.get(name);

  const globalName = KIT_GLOBALS[name];
  if (!globalName) {
    throw new Error(`Unknown kit "${name}". Known kits: ${Object.keys(KIT_GLOBALS).join(', ')}.`);
  }

  const file = join(KITS_DIR, `${name}.js`);
  if (!existsSync(file)) {
    throw new Error(`The ${name} file is missing from vendor/kits. Re-run \`npm run kits\` or restore vendor/kits/${name}.js.`);
  }

  const code = readFileSync(file, 'utf8');
  const sandbox = {
    console,
    Math,
    Date,
    JSON,
    Number,
    String,
    Object,
    Array,
    RegExp,
    Error,
    Map,
    Set,
    Promise,
    Uint8Array,
    ArrayBuffer,
    DataView,
    TextEncoder,
    TextDecoder,
    // compress-kit is built on Compression Streams; Node 18+ has them globally,
    // but the sandbox has to be told.
    CompressionStream: globalThis.CompressionStream,
    DecompressionStream: globalThis.DecompressionStream,
    ReadableStream: globalThis.ReadableStream,
    WritableStream: globalThis.WritableStream,
    Blob: globalThis.Blob,
    Response: globalThis.Response,
    Request: globalThis.Request,
    Headers: globalThis.Headers,
    FormData: globalThis.FormData,
    btoa: globalThis.btoa ?? ((s) => Buffer.from(s, 'binary').toString('base64')),
    atob: globalThis.atob ?? ((s) => Buffer.from(s, 'base64').toString('binary')),
    Buffer,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    structuredClone,
    URL,
    localStorage: undefined,
    document: undefined,
    navigator: undefined,
  };
  // The kits pick `globalThis` (or `this`) as their root; point both at the sandbox.
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  try {
    vm.runInContext(code, context, { filename: `${name}.js`, timeout: 5000 });
  } catch (err) {
    throw new Error(`The ${name} kit failed to load: ${/** @type {any} */ (err).message}`);
  }

  const kit = sandbox[globalName];
  if (!kit) {
    throw new Error(`The ${name} kit loaded but did not define ${globalName}. The vendored file may be truncated.`);
  }
  cache.set(name, kit);
  return kit;
}

/** Which kits are present, and at what version. Used by `sui doctor`. */
export function kitStatus() {
  return Object.keys(KIT_GLOBALS).map((name) => {
    try {
      const kit = loadKit(name);
      return { name, loaded: true, version: kit.version ?? null, error: null };
    } catch (err) {
      return { name, loaded: false, version: null, error: /** @type {any} */ (err).message };
    }
  });
}

/** The catalogue source data that ships with the fleet's app-endpoints repo. */
export function appEndpointsPath() {
  return join(KITS_DIR, 'app-endpoints.apis.json');
}
