/**
 * The attack suite (B5.6).
 *
 * Every case is a thing a model-written snippet might do that a sandbox must
 * contain. They are **test fixtures, not exploits**: each one is the simplest
 * form of a class, with no working payload, no target and no obfuscation, because
 * the point is to prove the boundary holds rather than to hand anyone a tool.
 *
 * Each case says what containment looks like: `blocked` (an error, no output),
 * `timeout` (stopped by a clock), or `truncated` (output capped).
 */

export const ATTACKS = [
  {
    name: 'read a file outside the work directory',
    why: 'the classic first step out of any sandbox',
    expect: 'blocked',
    code: `const fs = require('node:fs'); console.log(fs.readFileSync('/etc/passwd', 'utf8'));`,
  },
  {
    name: 'import a built-in module dynamically',
    why: 'a dynamic import is the way around a missing `require`',
    // Honest expectation: the context has no module loader, so the import never
    // resolves and nothing is read. The rejection is swallowed inside the
    // context, which means the run reports success — so what is asserted here is
    // that nothing leaked, not that the process failed.
    expect: 'no-leak',
    code: `import('node:fs').then((fs) => console.log(fs.readFileSync('/etc/passwd', 'utf8')));`,
  },
  {
    name: 'spawn a child process',
    why: 'a child inherits the parent\'s reach, not the sandbox\'s',
    expect: 'blocked',
    code: `const cp = require('node:child_process'); console.log(cp.execSync('id').toString());`,
  },
  {
    name: 'eval a string',
    why: 'string code generation turns data into instructions',
    expect: 'blocked',
    code: `console.log(eval('1 + 1'));`,
  },
  {
    name: 'compile a function from a string',
    why: 'the other half of string code generation',
    expect: 'blocked',
    code: `const f = new Function('return 42'); console.log(f());`,
  },
  {
    name: 'compile WASM',
    why: 'WASM is a second instruction set with its own escape surface',
    expect: 'blocked',
    code: `const m = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])); console.log('compiled');`,
  },
  {
    name: 'loop forever',
    why: 'an infinite loop is the cheapest denial of service',
    expect: 'timeout',
    code: `while (true) {}`,
  },
  {
    name: 'recuse until the stack dies',
    why: 'a crash must be the child\'s, not the host\'s',
    expect: 'blocked',
    code: `function f() { return f(); } f();`,
  },
  {
    name: 'allocate until the heap dies',
    why: 'a memory bomb takes the host down with it if the heap is shared',
    expect: 'blocked',
    code: `const a = []; while (true) a.push(new Array(1e6).fill('x'));`,
  },
  {
    name: 'flood the output',
    why: 'a log flood is a denial of service on the reader',
    expect: 'truncated',
    code: `for (let i = 0; i < 200000; i++) console.log('spam spam spam spam spam spam');`,
  },
  {
    name: 'exit the process',
    why: 'a snippet must not decide when the host stops',
    expect: 'blocked',
    code: `process.exit(0);`,
  },
  {
    name: 'read the environment',
    why: 'secrets live in the environment more often than in files',
    expect: 'blocked',
    code: `console.log(JSON.stringify(process.env));`,
  },
  {
    name: 'schedule a callback',
    why: 'an async loop is what a synchronous timeout cannot stop',
    expect: 'blocked',
    code: `setInterval(() => console.log('tick'), 10);`,
  },
  {
    name: 'open a socket',
    why: 'the network is the exfiltration path',
    expect: 'blocked',
    code: `fetch('http://1.1.1.1/').then((r) => console.log('reached', r.status));`,
  },
];

/**
 * Run every case and report whether the boundary held.
 *
 * @param {{runCode: Function, capabilities?: any, limits?: any}} deps
 */
export async function runAttackSuite(deps) {
  const results = [];
  for (const attack of ATTACKS) {
    const started = Date.now();
    const result = await deps.runCode({
      code: attack.code,
      capabilities: deps.capabilities,
      limits: { wallMs: 3000, vmTimeoutMs: 1500, heapMb: 96, maxOutputBytes: 8 * 1024, ...(deps.limits ?? {}) },
    });

    const contained = (() => {
      if (attack.expect === 'timeout') return result.timedOut || result.killed || /timed out/i.test(result.stderr);
      if (attack.expect === 'no-leak') {
        // the only thing that matters: did anything come back?
        return !/root:|\/bin\/|uid=|passwd/.test(result.stdout);
      }
      if (attack.expect === 'truncated') return result.truncated || result.stdout.length >= 8 * 1024;
      // blocked: nothing useful escaped, and the run did not report success.
      // A silent failure counts — what matters is that nothing leaked.
      const leaked = /root:|\/bin\/|uid=|reached 200|compiled|^42$/m.test(result.stdout);
      return !leaked && (result.ok === false || result.exitCode !== 0 || result.stderr.trim().length > 0);
    })();

    results.push({
      name: attack.name,
      why: attack.why,
      expect: attack.expect,
      contained,
      exitCode: result.exitCode,
      timedOut: Boolean(result.timedOut),
      truncated: Boolean(result.truncated),
      stderr: result.stderr.split('\n')[0].slice(0, 120),
      stdout: result.stdout.slice(0, 120),
      ms: Date.now() - started,
    });
  }

  const failed = results.filter((r) => !r.contained);
  return { total: results.length, contained: results.length - failed.length, failed: failed.length, results };
}
