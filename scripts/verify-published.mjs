#!/usr/bin/env node
/**
 * Verify what npm actually serves.
 *
 * Every other check in this repository tests the working tree. A user installs a
 * tarball, and the two are not the same thing: an undeclared dependency resolves
 * inside the workspace and fails from the registry, a version can be read from a
 * path that does not exist outside the repo, and a help line can name a command
 * that only works in a checkout. All three shipped before this script existed.
 *
 * It installs the published package into an empty directory and uses it the way
 * the README says to:
 *
 *   node scripts/verify-published.mjs            # the version in package.json
 *   node scripts/verify-published.mjs --latest   # whatever npm calls latest
 *
 * Exit code 0 means a stranger can install and run it.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const wantLatest = args.includes('--latest');

const pkgName = '@drsamonline/cli';
const version = wantLatest
  ? execFileSync('npm', ['view', pkgName, 'version'], { encoding: 'utf8', stdio: 'pipe' }).trim()
  : rootPkg.version;

const checks = [];
// async, because one check starts a server and fetches a page: a synchronous helper
// would store the returned Promise — always truthy — and pass a check that failed
const check = async (name, fn) => {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail });
  } catch (err) {
    checks.push({ name, ok: false, detail: String(err?.message ?? err).split('\n')[0] });
  }
};

const dir = mkdtempSync(join(tmpdir(), 'sui-published-'));
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'verify', private: true }));

console.log('');
console.log(`  verifying ${pkgName}@${version} from the registry`);

await check('installs into an empty directory', () => {
  const out = execFileSync('npm', ['install', `${pkgName}@${version}`, '--no-audit', '--no-fund'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 280_000,
  });
  const added = /added (\d+) packages?/.exec(out)?.[1] ?? '?';
  return `${added} packages`;
});

const bin = join(dir, 'node_modules', '.bin', 'sui');
const run = (argv, extraEnv = {}) =>
  execFileSync(bin, argv, {
    cwd: dir,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 120_000,
    env: { ...process.env, ...extraEnv },
  });

await check('reports the version it was published as', () => {
  const out = run(['--version']).trim();
  if (out !== version) throw new Error(`--version printed "${out}", expected "${version}"`);
  return out;
});

await check('names a command that exists', () => {
  const out = run(['--help']);
  // `npx sui` is a bin name, not a package: it cannot work from an install
  if (/\bnpx sui\b/.test(out)) throw new Error('help still says "npx sui"');
  if (!out.includes(`npx ${pkgName}`)) throw new Error(`help does not name npx ${pkgName}`);
  return 'help names the real command';
});

await check('first run completes a real round-trip', () => {
  const home = join(dir, '.sui-home');
  const out = run(['init', '--demo', '--no-serve'], { SUI_HOME: home });
  if (!/Endpoint ready/.test(out)) throw new Error('no "Endpoint ready" line');
  if (!/answered by/.test(out)) throw new Error('no round-trip line');
  return 'demo provider answered';
});

await check('speaks the configured language', () => {
  const out = run(['--help'], { SUI_LANG: 'hi' });
  if (!/एंडपॉइंट|LLM/.test(out)) throw new Error('Hindi tagline missing');
  return 'hi';
});

await check('the dashboard is the real page, not a placeholder', async () => {
  const { spawn } = await import('node:child_process');
  const home = join(dir, '.sui-home');
  const child = spawn(bin, ['start', '--port', '0'], {
    cwd: dir,
    env: { ...process.env, SUI_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the server did not announce a port in 20s')), 20_000);
    child.stdout.on('data', (chunk) => {
      const match = /127\.0\.0\.1:(\d+)/.exec(String(chunk));
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on('error', reject);
  });

  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const body = await res.text();
    if (!res.ok) throw new Error(`GET / answered ${res.status}`);
    // this exact string is what every npm user saw before the dashboard was bundled
    if (/Dashboard file missing/.test(body)) throw new Error('the dashboard file is not in the package');
    if (!/Routing dashboard/.test(body)) throw new Error('GET / did not return the dashboard');
    return `${Math.round(body.length / 1024)} kB page`;
  } finally {
    child.kill('SIGTERM');
  }
});

await check('the catalogue travels with the package', () => {
  // It did not: `sui catalog` reported "0 catalogue entries" from an install, so
  // probe had nothing to probe and the table every user saw was empty.
  const out = run(['catalog']);
  const count = /(\d+) catalogue entries/.exec(out)?.[1];
  if (!count || count === '0') throw new Error(`sui catalog reported ${count ?? 'no'} entries from an install`);
  return `${count} entries`;
});

await check('streams a response, the way a coding tool asks for one', async () => {
  const { spawn } = await import('node:child_process');
  const home = join(dir, '.sui-home');
  const child = spawn(bin, ['start', '--port', '0'], {
    cwd: dir,
    env: { ...process.env, SUI_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the server did not announce a port in 20s')), 20_000);
    child.stdout.on('data', (chunk) => {
      const match = /127\.0\.0\.1:(\d+)/.exec(String(chunk));
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on('error', reject);
  });

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'chat-default', stream: true, messages: [{ role: 'user', content: 'say hi' }] }),
    });
    if (!res.ok) throw new Error(`stream answered ${res.status}`);
    if (!/text\/event-stream/.test(res.headers.get('content-type') ?? '')) {
      throw new Error(`content-type was ${res.headers.get('content-type')}`);
    }

    const text = await res.text();
    if (!/^data: /m.test(text)) throw new Error('no data: frames');
    if (!/data: \[DONE\]/.test(text)) throw new Error('no [DONE] terminator');

    const frames = text.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]')).length;
    return `${frames} frames + [DONE]`;
  } finally {
    child.kill('SIGTERM');
  }
});

await check('every package has a tarball, not just a version in the metadata', async () => {
  // `npm view name@version version` answers from the metadata, and the metadata can
  // exist without a tarball: redteam@0.12.25 was listed and its .tgz was a 404, so
  // `npm install` failed on a release the publish job called a success.
  //
  // The URL is derivable, so this asks the registry directly and in parallel: 19
  // sequential `npm view` calls took longer than the sandbox allows.
  const names = [];
  for (const dirName of ['packages', 'apps']) {
    for (const entry of execFileSync('ls', [join(ROOT, dirName)], { encoding: 'utf8' }).trim().split('\n')) {
      try {
        const pkg = JSON.parse(readFileSync(join(ROOT, dirName, entry, 'package.json'), 'utf8'));
        if (!pkg.private) names.push(pkg.name);
      } catch {
        /* not a package */
      }
    }
  }

  const urlFor = (name) => {
    const bare = name.includes('/') ? name.split('/')[1] : name;
    const scope = name.includes('/') ? `${name.split('/')[0]}/` : '';
    return `https://registry.npmjs.org/${scope}${bare}/-/${bare}-${version}.tgz`;
  };

  // curl rather than fetch: fetch ignores the HTTPS_PROXY that a locked-down network
  // provides, and a check that reports "fetch failed" for every package is a check
  // that cannot tell a missing tarball from a blocked socket.
  const statusOf = (url) => {
    try {
      return execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-I', url], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 20_000,
      }).trim();
    } catch {
      return '000';
    }
  };

  // npm lists the version before the tarball is ready, and the gap can be minutes
  // for the last package published. A check that calls that a failure reports a
  // broken release every time; a check that waits reports the ones that never
  // arrive. Same reason the version check retries.
  const waitFor = (url, attempts = 10) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const code = statusOf(url);
      if (code === '200') return code;
      if (code === '404' && attempt < attempts - 1) {
        execFileSync('sleep', [String(15)]);
        continue;
      }
      return code;
    }
    return '000';
  };

  const results = names.map((name) => {
    const code = waitFor(urlFor(name));
    return code === '200' ? null : `${name} (${code})`;
  });

  const broken = results.filter(Boolean);
  if (broken.length) throw new Error(`listed but no tarball: ${broken.join(', ')}`);
  return `${names.length} tarballs`;
});

await check('every package is on the registry at this version', () => {
  const names = [];
  for (const dirName of ['packages', 'apps']) {
    for (const entry of execFileSync('ls', [join(ROOT, dirName)], { encoding: 'utf8' }).trim().split('\n')) {
      try {
        const pkg = JSON.parse(readFileSync(join(ROOT, dirName, entry, 'package.json'), 'utf8'));
        // a private package is not published on purpose: the dashboard's HTML
        // travels inside the gateway, so its own manifest is not a registry entry
        if (!pkg.private) names.push(pkg.name);
      } catch {
        /* not a package */
      }
    }
  }
  const missing = [];
  for (const name of names) {
    try {
      const live = execFileSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', stdio: 'pipe' }).trim();
      if (live !== version) missing.push(`${name}@${live}`);
    } catch {
      missing.push(`${name} (absent)`);
    }
  }
  if (missing.length) throw new Error(`not on the registry: ${missing.join(', ')}`);
  return `${names.length} packages`;
});

console.log('');
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
console.log('');

const failed = checks.filter((c) => !c.ok);
if (failed.length) {
  console.log(`  ${failed.length} check(s) failed: a stranger cannot install and run this.`);
  process.exit(1);
}
console.log('  A stranger can install this and run it.');
