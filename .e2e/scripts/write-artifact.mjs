import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const resultsDir = '.e2e/results';
const catalogPath = 'tests/catalog.json';

const RISK_TAGS_BY_CATEGORY = Object.freeze({
  unit: ['regression'],
  component: ['data_integrity', 'wiring', 'resource_lifecycle', 'regression'],
  contract: ['contract', 'wiring', 'regression'],
});

const PRODUCT_SHELL_RISK_TAGS = ['boundary_io', 'wiring', 'resource_lifecycle', 'regression'];
const LIVE_RISK_TAGS = ['boundary_io', 'contract', 'regression'];
const BUILD_RISK_TAGS = ['boundary_io', 'wiring', 'regression'];

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function rel(path) {
  return path.replace(/^\.e2e\//, '');
}

function evidence(logPath, resultPath = '') {
  const value = {};
  if (logPath && existsSync(logPath)) {
    value.log_path = rel(logPath);
    value.log_sha256 = sha256(logPath);
  }
  if (resultPath && existsSync(resultPath)) {
    value.result_path = rel(resultPath);
    value.result_sha256 = sha256(resultPath);
  }
  return value;
}

function makeTest({ name, status, durationMs, tags, command, exitCode, logPath, resultPath, sourceFiles, extra = {} }) {
  return {
    name,
    status,
    duration: Math.max(0, durationMs || 0),
    tags: status === 'passed' ? tags.map((tag) => `risk:${tag}`) : [],
    extra: {
      e2e_contract: {
        command_recorded: {
          command,
          exit_code: Number(exitCode),
        },
        expected_exit_code: 0,
        evidence: evidence(logPath, resultPath),
        source_files: sourceFiles,
        ...extra,
      },
    },
  };
}

function makeSkippedTest(name, reason) {
  return {
    name,
    status: 'skipped',
    duration: 0,
    tags: [],
    extra: {
      e2e_contract: {
        skip_reason: reason,
      },
    },
  };
}

function buildAndTypecheckTest() {
  const logPath = process.env.BUILD_LOG || `${resultsDir}/build.log`;
  const exitCode = Number(process.env.BUILD_EXIT || 1);
  const durationMs = Number(process.env.BUILD_DURATION_MS || 0);
  return makeTest({
    name: 'build and typecheck',
    status: exitCode === 0 ? 'passed' : 'failed',
    durationMs,
    tags: BUILD_RISK_TAGS,
    command: 'npm run build && npm run typecheck',
    exitCode,
    logPath,
    sourceFiles: ['package.json', 'esbuild.config.mjs', 'tsconfig.json'],
    extra: { category: 'build' },
  });
}

function categoryTest(category, summary, defaultCategories) {
  const tags = RISK_TAGS_BY_CATEGORY[category];
  if (!tags) throw new Error(`Unmapped test category: ${category}`);
  const stats = summary?.byCategory?.[category] || { tests: 0, passed: 0, failed: 0, files: [] };
  const exitCode = stats.failed === 0 && stats.tests > 0 ? 0 : 1;
  const durationMs = (summary?.results || [])
    .filter((r) => r.category === category)
    .reduce((sum, r) => sum + (r.durationMs || 0), 0);
  const recordedCommand = `TEST_RESULTS_JSON=${process.env.TESTS_RESULT || `${resultsDir}/tests-default.json`} node scripts/run-tests.mjs (categories: ${defaultCategories.join(',')})`;
  return makeTest({
    name: `${category} category`,
    status: exitCode === 0 ? 'passed' : 'failed',
    durationMs,
    tags,
    command: recordedCommand,
    exitCode,
    logPath: process.env.TESTS_LOG || `${resultsDir}/tests-default.log`,
    resultPath: process.env.TESTS_RESULT || `${resultsDir}/tests-default.json`,
    sourceFiles: stats.files.map((f) => `tests/${f}`),
    extra: { category, stats: { tests: stats.tests, passed: stats.passed, failed: stats.failed } },
  });
}

function productShellTest() {
  const logPath = process.env.PRODUCT_SHELL_LOG || `${resultsDir}/product-shell.log`;
  const resultPath = `${resultsDir}/product-shell.json`;
  const exitCode = Number(process.env.PRODUCT_SHELL_EXIT || 1);
  const result = readJson(resultPath, {});
  return makeTest({
    name: 'headless product-shell e2e smoke',
    status: result.status === 'passed' && exitCode === 0 ? 'passed' : 'failed',
    durationMs: result.durationMs || 0,
    tags: PRODUCT_SHELL_RISK_TAGS,
    command: 'node .e2e/cases/product-shell/run.mjs',
    exitCode,
    logPath,
    resultPath,
    sourceFiles: ['main.js', 'manifest.json', 'styles.css', '.e2e/cases/product-shell/run.mjs'],
    extra: {
      category: 'e2e',
      checks: result.checks || {},
      viewRender: result.viewRender || null,
      commandsInvoked: result.commandsInvoked || null,
      commandsAttempted: result.commandsAttempted || null,
    },
  });
}

function liveTest() {
  if (process.env.TEST_LIVE !== '1') {
    return makeSkippedTest('live Vault install smoke', 'Set TEST_LIVE=1 to check a real local Vault installation.');
  }
  const logPath = process.env.LIVE_LOG || `${resultsDir}/live.log`;
  const resultPath = `${resultsDir}/live.json`;
  const exitCode = Number(process.env.LIVE_EXIT || 1);
  const result = readJson(resultPath, {});
  return makeTest({
    name: 'live Vault install smoke',
    status: result.status === 'passed' && exitCode === 0 ? 'passed' : 'failed',
    durationMs: result.durationMs || 0,
    tags: LIVE_RISK_TAGS,
    command: 'TEST_LIVE=1 node .e2e/cases/live/run.mjs',
    exitCode,
    logPath,
    resultPath,
    sourceFiles: ['.e2e/cases/live/run.mjs'],
    extra: {
      category: 'live',
      checks: result,
    },
  });
}

const catalog = readJson(catalogPath);
if (!catalog) throw new Error(`failed to read ${catalogPath}`);
const defaultCategories = catalog.defaultCategories || ['unit', 'component', 'contract'];

const testsSummary = readJson(`${resultsDir}/tests-default.json`, null);

const tests = [
  buildAndTypecheckTest(),
  ...defaultCategories.map((category) => categoryTest(category, testsSummary, defaultCategories)),
  productShellTest(),
  liveTest(),
];

const summary = {
  tests: tests.length,
  passed: tests.filter((test) => test.status === 'passed').length,
  failed: tests.filter((test) => test.status === 'failed').length,
  pending: 0,
  skipped: tests.filter((test) => test.status === 'skipped').length,
  other: tests.filter((test) => !['passed', 'failed', 'skipped'].includes(test.status)).length,
};

const artifact = {
  reportFormat: 'CTRF',
  specVersion: '0.0.0',
  results: {
    tool: {
      name: 'obsidian-parallel-reader-e2e',
      version: '3',
    },
    summary,
    tests,
  },
};

writeFileSync('.e2e/artifact.json', JSON.stringify(artifact, null, 2) + '\n');
