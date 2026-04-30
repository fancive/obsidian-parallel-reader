import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const repoRoot = join(import.meta.dirname, '..');
const testsDir = join(repoRoot, 'tests');
const catalogPath = join(testsDir, 'catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const allTestFiles = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

function usage() {
  console.error(`Usage: node scripts/run-tests.mjs [--category <name> ...] [--all] [--list] [--json-output <path>]

Categories: ${Object.keys(catalog.categories).join(', ')}
Default: ${catalog.defaultCategories.join(', ')}`);
}

function parseArgs(argv) {
  const categories = [];
  let all = false;
  let list = false;
  let jsonOutput = process.env.TEST_RESULTS_JSON || '';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') {
      all = true;
    } else if (arg === '--list') {
      list = true;
    } else if (arg === '--category') {
      const value = argv[++i];
      if (!value) throw new Error('--category requires a value');
      categories.push(value);
    } else if (arg === '--json-output') {
      const value = argv[++i];
      if (!value) throw new Error('--json-output requires a path');
      jsonOutput = value;
    } else if (catalog.categories[arg]) {
      categories.push(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    categories: all ? Object.keys(catalog.categories) : categories.length ? categories : catalog.defaultCategories,
    list,
    jsonOutput,
  };
}

function validateCatalog() {
  const classified = new Map();
  for (const [category, config] of Object.entries(catalog.categories)) {
    if (!Array.isArray(config.files)) throw new Error(`catalog category ${category} must define files[]`);
    for (const file of config.files) {
      if (!file.endsWith('.test.js')) throw new Error(`catalog entry is not a test file: ${category}/${file}`);
      if (classified.has(file)) throw new Error(`test file classified twice: ${file}`);
      classified.set(file, category);
    }
  }

  const missing = allTestFiles.filter((file) => !classified.has(file));
  const extra = [...classified.keys()].filter((file) => !allTestFiles.includes(file));
  if (missing.length || extra.length) {
    throw new Error(
      [
        missing.length ? `unclassified test files: ${missing.join(', ')}` : '',
        extra.length ? `catalog references missing files: ${extra.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; '),
    );
  }
}

function filesForCategories(categories) {
  const files = [];
  for (const category of categories) {
    const config = catalog.categories[category];
    if (!config) throw new Error(`Unknown test category: ${category}`);
    for (const file of config.files) files.push({ category, file });
  }
  return files;
}

function runTest(category, file) {
  const filePath = join(testsDir, file);
  const startedAt = Date.now();
  let exitCode = 0;
  try {
    execFileSync('node', [filePath], { stdio: 'inherit' });
  } catch (error) {
    exitCode = typeof error.status === 'number' ? error.status : 1;
  }
  const durationMs = Date.now() - startedAt;
  return {
    category,
    file,
    status: exitCode === 0 ? 'passed' : 'failed',
    exitCode,
    durationMs,
  };
}

function summarize(results, categories) {
  const byCategory = {};
  for (const category of categories) {
    const categoryResults = results.filter((result) => result.category === category);
    byCategory[category] = {
      tests: categoryResults.length,
      passed: categoryResults.filter((result) => result.status === 'passed').length,
      failed: categoryResults.filter((result) => result.status === 'failed').length,
      files: categoryResults.map((result) => result.file),
    };
  }
  return {
    catalogVersion: catalog.version,
    categories,
    total: results.length,
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    byCategory,
    results,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  validateCatalog();

  const selected = filesForCategories(options.categories);
  if (options.list) {
    for (const { category, file } of selected) console.log(`${category}\t${file}`);
    return;
  }

  const missingFiles = selected.filter(({ file }) => !existsSync(join(testsDir, file))).map(({ file }) => file);
  if (missingFiles.length) throw new Error(`Selected test files do not exist: ${missingFiles.join(', ')}`);

  const results = selected.map(({ category, file }) => runTest(category, file));
  const summary = summarize(results, options.categories);

  if (options.jsonOutput) {
    writeFileSync(join(repoRoot, options.jsonOutput), JSON.stringify(summary, null, 2) + '\n');
  }

  if (summary.failed > 0) {
    console.error(`\n${summary.failed} test file(s) failed.`);
    process.exit(1);
  }

  console.log(`\nAll ${summary.total} test files passed across ${options.categories.join(', ')}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
}
