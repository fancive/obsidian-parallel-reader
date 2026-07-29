/**
 * Contract tests for the two release/CI helper scripts that guard shipping:
 *
 *   - `scripts/assert-coverage-shape.mjs` — the absolute-count floor that makes a
 *     broken coverage harness fail the build instead of printing another fabricated
 *     100%. Its boundary is the whole point, so it is pinned here.
 *   - `scripts/bump-version.mjs --tag` — creates the release commit and tag that
 *     `.github/workflows/release.yml` consumes.
 *
 * Both scripts derive their repo root from their OWN location
 * (`dirname(dirname(import.meta.url))`), so each test copies the real script into a
 * throwaway root and runs it there. That keeps the assertions on the shipped bytes
 * while never touching this repo's coverage report, git index, tags, or history.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');

function makeTempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Copy a repo script into `root` at the same relative path, so its derived root is `root`. */
function stageScript(root, relativePath) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, relativePath), target);
  return target;
}

function runNode(scriptPath, args, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: 'utf8' });
}

/* ============================================================
 * scripts/assert-coverage-shape.mjs — branch/function count floors
 * ============================================================ */

function fileMetrics(total) {
  return { total, covered: total, skipped: 0, pct: 100 };
}

function runCoverageShape({ branches, functions }) {
  const root = makeTempRoot('coverage-shape-');
  try {
    const script = stageScript(root, path.join('scripts', 'assert-coverage-shape.mjs'));
    fs.mkdirSync(path.join(root, 'coverage'));
    fs.writeFileSync(
      path.join(root, 'coverage', 'coverage-summary.json'),
      JSON.stringify({
        total: {
          lines: fileMetrics(5000),
          statements: fileMetrics(5000),
          functions: fileMetrics(functions),
          branches: fileMetrics(branches),
        },
        'src/example.ts': {
          lines: fileMetrics(100),
          statements: fileMetrics(100),
          functions: fileMetrics(10),
          branches: fileMetrics(10),
        },
      }),
    );
    const result = runNode(script, [], root);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCoverageShape_BranchBoundary() {
  // The gate exists to enforce "more than 1000 real branches were measured".
  const atBoundary = runCoverageShape({ branches: 1000, functions: 316 });
  assert.strictEqual(
    atBoundary.status,
    1,
    'a report with exactly 1000 branches must FAIL the shape gate — the documented boundary is > 1000',
  );
  assert.match(atBoundary.stderr, /branches/, 'the failure must name the branch floor it tripped');

  const justOver = runCoverageShape({ branches: 1001, functions: 316 });
  assert.strictEqual(justOver.status, 0, 'a report with 1001 branches must PASS — one above the boundary is enough');
}

function testCoverageShape_CatchesHarnessRegression() {
  // The pre-migration bundled harness reported 32 branches / 12 functions while
  // claiming 100%. That must never pass again.
  const brokenHarness = runCoverageShape({ branches: 32, functions: 12 });
  assert.strictEqual(brokenHarness.status, 1, 'the pre-migration branch/function counts must fail the shape gate');
}

function testCoverageShape_FunctionFloorIsEnforcedIndependently() {
  const lowFunctions = runCoverageShape({ branches: 1200, functions: 100 });
  assert.strictEqual(lowFunctions.status, 1, 'plenty of branches must not excuse a collapsed function count');
  assert.match(lowFunctions.stderr, /functions/, 'the failure must name the function floor it tripped');

  // A shape in the range the direct-import harness actually produces (~1200+ branches,
  // ~300+ functions) must pass. Deliberately not pinned to the exact current reading:
  // that number moves with every test added, and a test asserting it would rot on the
  // next commit rather than guard anything.
  const healthy = runCoverageShape({ branches: 1200, functions: 300 });
  assert.strictEqual(healthy.status, 0, 'a healthy real-harness shape must pass both floors');
}

/* ============================================================
 * scripts/bump-version.mjs --tag — release commit + tag preflights
 * ============================================================ */

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

/**
 * Throwaway git repo holding just the files the bump script touches, plus a copy of
 * the script itself.
 *
 * The new CHANGELOG section is written AFTER the initial commit, i.e. left uncommitted
 * in the working tree — that is exactly how a release is prepared, and exactly the state
 * in which the old script tagged a commit that did not contain the section.
 */
function makeBumpRepo({ changelogVersion } = {}) {
  const root = makeTempRoot('bump-version-');
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    `${JSON.stringify({ id: 'parallel-reader', version: '1.0.0', minAppVersion: '1.8.7' }, null, '\t')}\n`,
  );
  fs.writeFileSync(path.join(root, 'versions.json'), `${JSON.stringify({ '1.0.0': '1.8.7' }, null, '\t')}\n`);
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'original\n');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial']);
  if (changelogVersion) {
    fs.writeFileSync(
      path.join(root, 'CHANGELOG.md'),
      `# Changelog\n\n## [${changelogVersion}] - 2026-01-01\n\n- something\n`,
    );
  }
  const script = stageScript(root, path.join('scripts', 'bump-version.mjs'));
  return { root, script, head: git(root, ['rev-parse', 'HEAD']).trim() };
}

function readVersion(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
}

function testBumpVersion_TagRefusesWhenTagAlreadyExists() {
  const { root, script, head } = makeBumpRepo({ changelogVersion: '1.0.1' });
  try {
    git(root, ['tag', '1.0.1']);

    const result = runNode(script, ['1.0.1', '--tag'], root);

    assert.strictEqual(result.status, 1, 'an already-existing tag must be detected BEFORE anything is committed');
    assert.match(result.stderr, /1\.0\.1/, 'the error must name the conflicting tag');
    assert.strictEqual(git(root, ['rev-parse', 'HEAD']).trim(), head, 'no commit may be created when the tag exists');
    assert.strictEqual(readVersion(root), '1.0.0', 'manifest.json must not be rewritten when the preflight fails');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testBumpVersion_TagRefusesWithoutChangelogSection() {
  const { root, script, head } = makeBumpRepo({ changelogVersion: null });
  try {
    const result = runNode(script, ['1.0.1', '--tag'], root);

    assert.strictEqual(
      result.status,
      1,
      'tagging a release whose CHANGELOG section is missing must fail — release.yml reads that section and would fail its changelog guard',
    );
    assert.strictEqual(git(root, ['rev-parse', 'HEAD']).trim(), head, 'no commit may be created');
    assert.strictEqual(git(root, ['tag', '-l']).trim(), '', 'no tag may be created');
    assert.strictEqual(readVersion(root), '1.0.0', 'manifest.json must not be rewritten when the preflight fails');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testBumpVersion_TagRefusesWithUnrelatedStagedChanges() {
  const { root, script, head } = makeBumpRepo({ changelogVersion: '1.0.1' });
  try {
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'staged edit\n');
    git(root, ['add', 'unrelated.txt']);

    const result = runNode(script, ['1.0.1', '--tag'], root);

    assert.strictEqual(result.status, 1, 'a dirty index must be refused rather than absorbed into the release commit');
    assert.match(result.stderr, /unrelated\.txt/, 'the error must name the offending staged file');
    assert.strictEqual(git(root, ['rev-parse', 'HEAD']).trim(), head, 'no commit may be created');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testBumpVersion_TagCommitsExactlyTheReleaseFiles() {
  const { root, script } = makeBumpRepo({ changelogVersion: '1.0.1' });
  try {
    // An unrelated, UNSTAGED working-tree edit must survive untouched.
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'local work in progress\n');

    const result = runNode(script, ['1.0.1', '--tag'], root);

    assert.strictEqual(result.status, 0, `--tag should succeed; stderr was: ${result.stderr}`);
    assert.strictEqual(readVersion(root), '1.0.1', 'manifest.json is bumped');

    const committed = git(root, ['show', '--pretty=format:', '--name-only', 'HEAD']).trim().split('\n').sort();
    assert.deepStrictEqual(
      committed,
      ['CHANGELOG.md', 'manifest.json', 'versions.json'],
      'the release commit must contain exactly the release files — CHANGELOG.md included (release.yml reads it), unrelated.txt excluded',
    );
    assert.strictEqual(git(root, ['tag', '-l']).trim(), '1.0.1', 'the version tag is created');
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'unrelated.txt'), 'utf8'),
      'local work in progress\n',
      'unrelated working-tree edits must be left alone',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testBumpVersion_WithoutTagStillJustStages() {
  const { root, script, head } = makeBumpRepo({ changelogVersion: null });
  try {
    const result = runNode(script, ['1.0.1'], root);

    assert.strictEqual(result.status, 0, 'the default (no --tag) path is unchanged and does not need a CHANGELOG');
    assert.strictEqual(readVersion(root), '1.0.1', 'manifest.json is bumped');
    assert.strictEqual(git(root, ['rev-parse', 'HEAD']).trim(), head, 'no commit is created without --tag');
    assert.match(
      git(root, ['diff', '--cached', '--name-only']),
      /manifest\.json/,
      'manifest.json is staged for the npm version hook',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

testCoverageShape_BranchBoundary();
testCoverageShape_CatchesHarnessRegression();
testCoverageShape_FunctionFloorIsEnforcedIndependently();
testBumpVersion_TagRefusesWhenTagAlreadyExists();
testBumpVersion_TagRefusesWithoutChangelogSection();
testBumpVersion_TagRefusesWithUnrelatedStagedChanges();
testBumpVersion_TagCommitsExactlyTheReleaseFiles();
testBumpVersion_WithoutTagStillJustStages();
console.log('release-tooling tests passed');
