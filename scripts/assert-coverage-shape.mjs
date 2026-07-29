/**
 * Guards the *shape* of the coverage report, not its percentages.
 *
 * A percentage gate alone cannot detect the failure mode this repo actually hit:
 * when the harness measured an esbuild bundle and remapped it back onto src/*.ts,
 * branch and function ranges were silently DISCARDED rather than reported as
 * uncovered. The report then claimed `Branches 100% (32/32)` and `Statements 100%`
 * while 27 of 30 files carried `branches.total === 0` — a perfect score over
 * almost nothing. Every percentage threshold passed, so nothing failed.
 *
 * These floors are absolute counts, so if a future change quietly reverts the
 * direct-.ts-import harness (tests/ts-loader.js) the totals collapse and CI fails
 * instead of printing another fabricated pass.
 *
 * Run after `npm run coverage`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const summaryPath = join(repoRoot, 'coverage', 'coverage-summary.json');

// Measured on the direct-import harness at the time of writing: 1180 branches and
// 316 functions across 30 files. The floors sit below that so ordinary code churn
// cannot trip them, and far above the pre-migration readings (32 branches, 12
// functions) so a harness regression cannot slip through.
//
// The branch floor is 1001, not a round 1000, because the documented contract is
// `total.branches.total > 1000`: a report with exactly 1000 branches must FAIL.
// (`MIN_BRANCHES = 900` used to let 900–1000 through — pinned by
// tests/release-tooling.test.js so the boundary cannot drift again.)
const MIN_BRANCHES = 1001;
const MIN_FUNCTIONS = 250;

let summary;
try {
  summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
} catch (error) {
  console.error(`Cannot read ${summaryPath}: ${error.message}`);
  console.error('Run `npm run coverage` first (it writes the json-summary reporter output).');
  process.exit(1);
}

const total = summary.total;
const failures = [];

if (total.branches.total < MIN_BRANCHES) {
  failures.push(
    `total.branches.total is ${total.branches.total}, below the floor of ${MIN_BRANCHES}. ` +
      'The harness has stopped measuring real branches — see tests/ts-loader.js.',
  );
}

if (total.functions.total < MIN_FUNCTIONS) {
  failures.push(
    `total.functions.total is ${total.functions.total}, below the floor of ${MIN_FUNCTIONS}. ` +
      'The harness has stopped measuring real functions — see tests/ts-loader.js.',
  );
}

console.log(
  `Coverage shape: ${total.branches.total} branches, ${total.functions.total} functions, ` +
    `${total.statements.total} statements across ${Object.keys(summary).length - 1} files.`,
);

if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
