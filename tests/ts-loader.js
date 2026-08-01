'use strict';

/**
 * Module resolution hooks that let the test suite load `main.ts` and `src/*.ts`
 * DIRECTLY, using Node's built-in type stripping, instead of going through an
 * esbuild bundle.
 *
 * Why this exists: the previous harness bundled the whole source graph with
 * esbuild and then hand-patched the bundle's inline source map so c8 could remap
 * V8 coverage back onto `src/*.ts`. Statement ranges survived that remap, but
 * BRANCH ranges did not — they were discarded rather than reported as uncovered,
 * so 27 of 30 source files reported `branches.total === 0` and every percentage
 * threshold passed trivially. Loading the real `.ts` files means V8 measures the
 * actual source, so branch and function counts are real.
 *
 * Two jobs, one `resolve` hook:
 *   1. `obsidian` is not installed as a runtime module here — redirect the bare
 *      specifier to the test mock.
 *   2. Every relative import in this codebase is extensionless (`./settings`,
 *      `../main`). Node does not probe for `.ts` on its own in either CJS or ESM,
 *      so append the extension when the `.ts` file exists.
 *
 * Requirements this places on the sources (both enforced by failing loudly):
 *   - No constructor parameter properties, and no other non-erasable TypeScript
 *     syntax (enums, namespaces, decorators) — strip-only mode rejects them.
 *   - Type-only imports must use `import type` / inline `type`, otherwise the
 *     stripped import survives and fails at runtime with "does not provide an
 *     export named …".
 *
 * Side-effect-only module: `require('./ts-loader')` once, BEFORE anything that
 * loads a `.ts` module. Both tests/test-setup.js and tests/direct-test-setup.js
 * do exactly that.
 */

const { registerHooks } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

const OBSIDIAN_MOCK_URL = pathToFileURL(path.join(__dirname, 'obsidian-mock.mjs')).href;

// Polyfill Obsidian's `activeWindow` global for the Node test runtime.
if (typeof globalThis.activeWindow === 'undefined') {
  globalThis.activeWindow = globalThis;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'obsidian') {
      return { url: OBSIDIAN_MOCK_URL, format: 'module', shortCircuit: true };
    }

    let request = specifier;
    if (specifier.startsWith('.') && !path.extname(specifier)) {
      const parentDir = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : __dirname;
      if (fs.existsSync(path.resolve(parentDir, `${specifier}.ts`))) request = `${specifier}.ts`;
    }

    const resolved = nextResolve(request, context);
    // `module-typescript` (NOT plain `module` — that skips type stripping and dies
    // on the first `type` keyword) is declared explicitly so Node does not fall back
    // to syntax detection, which prints a MODULE_TYPELESS_PACKAGE_JSON warning on
    // every run because package.json has no `type` field. Every `.ts` file here is ESM.
    if (typeof resolved?.url === 'string' && resolved.url.endsWith('.ts')) {
      return { ...resolved, format: 'module-typescript' };
    }
    return resolved;
  },
});
