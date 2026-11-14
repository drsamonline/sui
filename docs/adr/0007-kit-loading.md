# ADR-0007 — kits load in an isolated VM context, not by import

**Status:** accepted · 2026-11-14

## Context

The fleet's kits are single-file browser IIFEs: they take `(typeof globalThis !== "undefined" ? globalThis : this)` as their root and attach a global (`CryptoKit`, `MLKit`, `Search`, `Tokens`, `Compress`, `Export`, `Loom`). They export nothing in the ESM sense, and some of them expect `CompressionStream`, `Blob` and `Response`.

Importing them for side effects would work once and then pollute `globalThis`, which makes two kits with the same internal name a latent conflict and makes "which kit set this?" unanswerable.

## Decision

`packages/kits` reads the file and evaluates it in a `node:vm` context whose root *is* the sandbox:

- no host globals are touched (`test/kits.test.js` asserts `CryptoKit` never appears on `globalThis`);
- browser-only globals are injected deliberately (`crypto`, `TextEncoder`, `CompressionStream`, `Blob`, `Response`), so what a kit can reach is a written list, not "whatever Node happens to expose";
- a 5s evaluation timeout, and a load failure surfaces as a plain message naming the kit;
- kits are cached after first load, and `kitStatus()` reports name, version and load error for `sui doctor` and `sui kits`.

## Consequences

- Adding a kit is one entry in `KIT_GLOBALS` plus a file in `vendor/kits/`.
- A kit cannot break the gateway at import time; it fails when asked for, with a sentence.
- The kits stay unmodified, which keeps upstream syncs honest (a diff we can read).
