/**
 * @sui/sandbox — B5.6, running model-authored code without trusting it.
 *
 * The honest starting point: **`node:vm` is not a security boundary.** It stops
 * accidents, not adversaries — a determined escape has been demonstrated many
 * times, and any design that rests on it is a design that will be broken.
 *
 * So the boundary here is a *process*, not a context:
 *
 *   1. a separate `node` child process, so a crash or a hang is containable;
 *   2. Node's permission model — no filesystem outside the work directory, no
 *      child processes, no worker threads, no native addons;
 *   3. a **network namespace** via `unshare -n` where the platform allows it, so
 *      the code has no interfaces to reach;
 *   4. a stripped environment, so a stray `process.env` reads nothing useful;
 *   5. hard limits: wall clock, heap, output size, and a `vm` timeout inside as
 *      defence in depth.
 *
 * What this is **not**: a kernel-level jail. `unshare` needs either root or a
 * user namespace, and where it is unavailable the sandbox says so rather than
 * pretending. `sandboxCapabilities()` reports exactly what is enforced on this
 * machine, and `requireNoNetwork` turns "cannot isolate" into "will not run".
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNNER = join(HERE, 'runner.js');

/** Defaults are deliberately small: this is for a snippet, not a build. */
export const DEFAULT_LIMITS = {
  wallMs: 5000,
  heapMb: 128,
  maxOutputBytes: 64 * 1024,
  vmTimeoutMs: 4000,
};

/** Environment variables a sandboxed run is allowed to see. */
const PASSTHROUGH_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ'];

/**
 * What is actually enforced on this machine. Reported, never assumed.
 *
 * @param {{execPath?: string, probe?: (cmd: string, args: string[]) => Promise<boolean>}} [opts]
 */
export async function sandboxCapabilities(opts = {}) {
  const node = opts.execPath ?? process.execPath;
  const probe = opts.probe ?? defaultProbe;

  const [permissionModel, unshare, userNamespace] = await Promise.all([
    probe(node, ['--experimental-permission', '-e', '0']),
    probe('unshare', ['-n', '-r', 'true']),
    probe('unshare', ['-Ur', 'true']),
  ]);

  return {
    node,
    permissionModel,
    networkNamespace: unshare,
    userNamespace,
    // the network jail needs one of the two unshare forms
    networkIsolated: unshare || userNamespace,
    // a run is only "fully isolated" when both are available
    fullyIsolated: permissionModel && (unshare || userNamespace),
  };
}

/** @returns {Promise<boolean>} */
function defaultProbe(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 2000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * Run a snippet of JavaScript in a contained process.
 *
 * @param {{code: string, limits?: Partial<typeof DEFAULT_LIMITS>, capabilities?: any, requireNoNetwork?: boolean, env?: NodeJS.ProcessEnv}} input
 */
export async function runCode(input) {
  const limits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) };
  const capabilities = input.capabilities ?? (await sandboxCapabilities());

  if (input.requireNoNetwork && !capabilities.networkIsolated) {
    return {
      ok: false,
      refused: true,
      reason:
        'This machine cannot create a network namespace (no unshare, or no user namespaces). requireNoNetwork is set, so the code was not run — a sandbox that cannot prove its boundary is not a sandbox.',
      capabilities,
    };
  }

  const workdir = mkdtempSync(join(tmpdir(), 'sui-sandbox-'));
  const file = join(workdir, 'snippet.mjs');
  writeFileSync(file, String(input.code ?? ''), 'utf8');

  const nodeArgs = [
    '--max-old-space-size=' + limits.heapMb,
    '--no-warnings',
    ...(capabilities.permissionModel
      ? [
          '--experimental-permission',
          // the work directory, plus the runner itself: the permission model
          // applies to loading our own script, which is a confusing failure to
          // debug if you meet it as a user
          `--allow-fs-read=${workdir}`,
          `--allow-fs-read=${HERE}`,
          `--allow-fs-write=${workdir}`,
        ]
      : []),
    RUNNER,
    file,
    String(limits.vmTimeoutMs),
    String(limits.maxOutputBytes),
  ];

  // the network jail wraps the whole node process, so nothing inside can open a socket
  const command = capabilities.networkIsolated ? 'unshare' : capabilities.node;
  const args = capabilities.networkIsolated ? [...(capabilities.networkNamespace ? ['-n', '-r'] : ['-Ur']), capabilities.node, ...nodeArgs] : nodeArgs;

  const env = {};
  for (const key of PASSTHROUGH_ENV) if (process.env[key]) env[key] = process.env[key];
  // a stripped environment is the cheapest exfiltration defence there is
  env.HOME = workdir;
  env.TMPDIR = workdir;

  const started = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, { cwd: workdir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;

    const killTimer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, limits.wallMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < limits.maxOutputBytes) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < limits.maxOutputBytes) stderr += chunk;
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}${err.message}`, killed });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(killTimer);
      resolve({ exitCode: code, signal, stdout, stderr, killed });
    });
  });

  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not worth failing a run over */
  }

  const truncated = result.stdout.length >= limits.maxOutputBytes;
  return {
    ok: result.exitCode === 0 && !result.killed,
    exitCode: result.exitCode,
    killed: result.killed,
    timedOut: result.killed,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated,
    ms: Date.now() - started,
    limits,
    capabilities: {
      permissionModel: capabilities.permissionModel,
      networkIsolated: capabilities.networkIsolated,
      fullyIsolated: capabilities.fullyIsolated,
    },
  };
}

export { ATTACKS, runAttackSuite } from './attacks.js';
