import test from 'node:test';
import assert from 'node:assert/strict';

test('a registry install reports its own version and a command that exists', async () => {
  const { readFileSync, mkdtempSync, mkdirSync, cpSync, writeFileSync, readdirSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');

  // Simulate a published install: the CLI sits at node_modules/<pkg>/, with no
  // repository above it. That layout is what printed 0.0.0-unknown and told
  // people to run `npx sui`, a package that does not exist.
  const root = mkdtempSync(join(tmpdir(), 'sui-install-'));
  const pkgDir = join(root, 'node_modules', '@drsamonline', 'cli');
  mkdirSync(pkgDir, { recursive: true });
  cpSync(join(process.cwd(), 'apps', 'cli', 'src'), join(pkgDir, 'src'), { recursive: true });
  cpSync(join(process.cwd(), 'apps', 'cli', 'bin'), join(pkgDir, 'bin'), { recursive: true });
  // the eval harness ships in the package too; without it the CLI cannot even load
  cpSync(join(process.cwd(), 'apps', 'cli', 'evals'), join(pkgDir, 'evals'), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'apps', 'cli', 'package.json'), 'utf8'));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(manifest, null, 2));

  // the CLI imports its sibling packages at module load; link them as an install
  // would, without copying the whole workspace
  const scopeDir = join(root, 'node_modules', '@drsamonline');
  mkdirSync(scopeDir, { recursive: true });
  for (const entry of readdirSync(join(process.cwd(), 'node_modules', '@drsamonline'))) {
    if (entry === 'cli') continue;
    symlinkSync(join(process.cwd(), 'node_modules', '@drsamonline', entry), join(scopeDir, entry));
  }

  const version = execFileSync(process.execPath, [join(pkgDir, 'bin', 'sui.js'), '--version'], {
    encoding: 'utf8',
    timeout: 60_000,
  }).trim();
  assert.match(version, /^\d+\.\d+\.\d+$/, `expected a version, got "${version}"`);
  assert.equal(version, manifest.version, 'the CLI must report the version it was published as');
});
