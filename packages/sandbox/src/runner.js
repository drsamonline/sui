/**
 * The child process entry point.
 *
 * It reads the snippet, evaluates it in a `vm` context with code generation off,
 * and exits. The context is **not** the security boundary — the process and its
 * permission flags are — but it stops the accidents: no `require`, no `process`,
 * no `import`, no `eval` of strings, no WASM.
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const [, , file, vmTimeoutMs = '4000', maxOutputBytes = '65536'] = process.argv;
const limit = Number(vmTimeoutMs);
const outputLimit = Number(maxOutputBytes);

const code = readFileSync(file, 'utf8');

// A rejected promise must fail the run: a snippet whose async half failed has
// not succeeded, and exiting 0 would report a silent lie.
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`UnhandledRejection: ${reason?.message ?? String(reason)}\n`);
  process.exit(1);
});

/** Output is captured, not printed live, so a flood cannot outrun the cap. */
let out = '';
const write = (prefix, args) => {
  if (out.length >= outputLimit) return;
  const line = args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
  out += `${prefix}${line}\n`;
};

const sandbox = {
  console: {
    log: (...a) => write('', a),
    info: (...a) => write('', a),
    warn: (...a) => write('', a),
    error: (...a) => write('', a),
    debug: () => {},
  },
  // no setTimeout/setInterval: an async loop is what a vm timeout cannot stop
  JSON,
  Math,
  Date,
  String,
  Number,
  Boolean,
  Array,
  Object,
  Map,
  Set,
  Promise,
  Error,
  TypeError,
  RangeError,
  RegExp,
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
};
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox, {
  codeGeneration: { strings: false, wasm: false }, // no eval, no new Function, no WASM
  microtaskMode: 'afterEvaluate',
});

try {
  const script = new vm.Script(code, {
    filename: 'snippet.mjs',
    // dynamic import is the way around a missing `require`; refuse it explicitly
    // rather than letting it reject silently inside the context
    importModuleDynamically: () => {
      throw new Error('Dynamic import is not available in the sandbox.');
    },
  });
  script.runInContext(context, { timeout: limit, breakOnSigint: true });
  // let a top-level promise settle, without letting it run forever
  if (typeof sandbox.__result?.then === 'function') {
    await Promise.race([sandbox.__result, new Promise((r) => setTimeout(r, limit))]);
  }
  if (out) process.stdout.write(out.slice(0, outputLimit));
  process.exit(0);
} catch (err) {
  if (out) process.stdout.write(out.slice(0, outputLimit));
  const name = err?.name ?? 'Error';
  const message = err?.message ?? String(err);
  process.stderr.write(`${name}: ${message}\n`);
  // 124 is what `timeout(1)` uses for "it ran too long"; keep the convention
  process.exit(name === 'Error' && /Script execution timed out/.test(message) ? 124 : 1);
}
