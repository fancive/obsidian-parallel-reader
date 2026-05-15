'use strict';

// esbuild emits inline source maps whose `sources` are relative to the bundle
// file (deep under .test-bundles/) with a `sourceRoot`. v8-to-istanbul / the
// source-map library resolve those inconsistently and produce wrong paths like
// `/Users/.../github.com/src/batch.ts`, so c8 finds nothing to report.
//
// This rewrites the inline map in-place so every `source` is an absolute path
// to the real repo file and `sourceRoot` is cleared — making the remap exact.
// No-op when coverage is not active.

const fs = require('fs');
const path = require('path');

const MARKER = '//# sourceMappingURL=data:application/json;base64,';

function fixInlineSourceMap(outfile, repoRoot) {
  if (!process.env.NODE_V8_COVERAGE) return;
  const code = fs.readFileSync(outfile, 'utf8');
  const idx = code.lastIndexOf(MARKER);
  if (idx === -1) return;
  const b64 = code.slice(idx + MARKER.length).trim();
  const map = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  // esbuild keeps `sources` relative to the bundle file's directory regardless
  // of `sourceRoot`; resolving against sourceRoot double-counts and corrupts
  // the path. Always resolve against the bundle directory.
  const base = path.dirname(outfile);

  map.sources = map.sources.map((src) => {
    if (src.startsWith('stub:') || src.includes('obsidian-stub')) return src;
    const abs = path.resolve(base, src);
    // Strip any leftover climbing artifacts; keep the real repo path.
    const i = abs.indexOf(repoRoot);
    return i === -1 ? abs : abs.slice(i);
  });
  delete map.sourceRoot;

  const fixed = Buffer.from(JSON.stringify(map), 'utf8').toString('base64');
  fs.writeFileSync(outfile, code.slice(0, idx) + MARKER + fixed);
}

module.exports = { fixInlineSourceMap };
