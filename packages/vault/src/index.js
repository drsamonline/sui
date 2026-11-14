/**
 * @sui/vault — the paid-credential vault (B6.7).
 *
 * The air-gap has two halves. The gate (I4) decides *whether* paid credentials
 * are read at all. This is the other half: *where* they live, sealed with
 * AES-256-GCM through the vendored crypto-kit, so a copied vault file is not a
 * set of keys.
 *
 * Honest limits, stated here rather than in a footnote:
 *   - The passphrase is generated on first run and kept in a 0600 file beside the
 *     vault. That protects against a leaked or committed vault file. It does not
 *     protect against someone who already has your user account.
 *   - Bring your own passphrase with SUI_VAULT_PASSPHRASE and the keyfile is
 *     never written.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadKit } from '@sui/kits';

const FORMAT = 1;

/**
 * @typedef {{
 *   path: string, keyPath: string, passphrase: string|null,
 *   exists: () => boolean,
 *   init: (opts?: {force?: boolean}) => Promise<{created: boolean, keyPath: string|null}>,
 *   read: () => Promise<Record<string, string>>,
 *   write: (keys: Record<string, string>) => Promise<void>,
 *   set: (provider: string, key: string) => Promise<void>,
 *   remove: (provider: string) => Promise<boolean>,
 *   list: () => Promise<string[]>,
 *   source: 'env' | 'keyfile' | 'none'
 * }} Vault
 */

/**
 * @param {{path: string, keyPath?: string, env?: NodeJS.ProcessEnv}} opts
 * @returns {Vault}
 */
export function createVault(opts) {
  const path = opts.path;
  const keyPath = opts.keyPath ?? join(dirname(path), 'vault.key');
  const env = opts.env ?? process.env;

  const passphrase = env.SUI_VAULT_PASSPHRASE?.trim() ? env.SUI_VAULT_PASSPHRASE.trim() : null;
  const source = passphrase ? 'env' : existsSync(keyPath) ? 'keyfile' : 'none';

  function currentPassphrase() {
    if (passphrase) return passphrase;
    if (existsSync(keyPath)) return readFileSync(keyPath, 'utf8').trim();
    return null;
  }

  return {
    path,
    keyPath,
    passphrase,
    source,
    exists: () => existsSync(path),

    async init(initOpts = {}) {
      if (existsSync(path) && !initOpts.force) {
        return { created: false, keyPath: passphrase ? null : keyPath };
      }
      let writtenKey = null;
      let phrase = currentPassphrase();
      if (!phrase) {
        phrase = randomBytes(32).toString('base64');
        mkdirSync(dirname(keyPath), { recursive: true });
        writeFileSync(keyPath, phrase + '\n', { mode: 0o600 });
        try {
          chmodSync(keyPath, 0o600);
        } catch {
          /* a filesystem without POSIX modes: the file is still outside the repo */
        }
        writtenKey = keyPath;
      }
      await writeWith(phrase, {});
      return { created: true, keyPath: writtenKey };
    },

    async read() {
      if (!existsSync(path)) return {};
      const phrase = currentPassphrase();
      if (!phrase) {
        throw new Error(
          `The vault at ${path} exists but there is no passphrase. Set SUI_VAULT_PASSPHRASE, or restore ${keyPath}.`,
        );
      }
      const CryptoKit = loadKit('crypto-kit');
      const sealed = JSON.parse(readFileSync(path, 'utf8'));
      if (sealed.format !== FORMAT || !sealed.sealed) {
        throw new Error(`The vault at ${path} is not in a format this version understands.`);
      }
      let plaintext;
      try {
        plaintext = await CryptoKit.openString(sealed.sealed, phrase);
      } catch {
        throw new Error('The vault could not be opened: the passphrase does not match. Nothing was changed.');
      }
      const parsed = JSON.parse(plaintext);
      return parsed && typeof parsed === 'object' ? parsed : {};
    },

    async write(keys) {
      const phrase = currentPassphrase();
      if (!phrase) throw new Error('No vault passphrase available. Run `sui vault init` first.');
      await writeWith(phrase, keys);
    },

    async set(provider, key) {
      const keys = await this.read();
      keys[provider] = key;
      await this.write(keys);
    },

    async remove(provider) {
      const keys = await this.read();
      if (!(provider in keys)) return false;
      delete keys[provider];
      await this.write(keys);
      return true;
    },

    async list() {
      return Object.keys(await this.read()).sort();
    },
  };

  async function writeWith(phrase, keys) {
    const CryptoKit = loadKit('crypto-kit');
    const sealed = await CryptoKit.sealString(JSON.stringify(keys), phrase);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ format: FORMAT, sealed, updatedAt: new Date().toISOString() }, null, 2) + '\n', {
      mode: 0o600,
    });
    renameSync(tmp, path);
  }
}

/**
 * Read the vault for a gateway startup. Returns provider -> key, or an empty map
 * with a reason when the vault cannot be opened. Never throws: a locked vault
 * must not stop the gateway from serving free routes.
 *
 * @param {{path: string, keyPath?: string, env?: NodeJS.ProcessEnv}} opts
 * @returns {Promise<{keys: Record<string, string>, reason: string|null}>}
 */
export async function openVaultForStartup(opts) {
  const vault = createVault(opts);
  if (!vault.exists()) return { keys: {}, reason: 'no vault file (paid keys are not configured)' };
  try {
    const keys = await vault.read();
    const count = Object.keys(keys).length;
    return { keys, reason: count ? `${count} provider key(s) opened` : 'vault is empty' };
  } catch (err) {
    return { keys: {}, reason: /** @type {any} */ (err).message };
  }
}
