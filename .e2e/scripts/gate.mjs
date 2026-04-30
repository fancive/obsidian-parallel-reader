import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const VALID_RISK_TAGS = new Set([
  'boundary_io',
  'failure_path',
  'concurrency',
  'wiring',
  'regression',
  'security',
  'data_integrity',
  'resource_lifecycle',
  'contract',
]);

function parseArgs(argv) {
  const args = {
    json: false,
    project: '.',
    required: false,
    skipRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--required') args.required = true;
    else if (arg === '--skip-run') args.skipRun = true;
    else if (arg === '--project') {
      const value = argv[++i];
      if (!value) throw new Error('--project requires a value');
      args.project = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === '[]') return [];
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadConfig(configPath) {
  const root = {};
  let currentList = null;
  let currentObject = null;

  for (const rawLine of readFileSync(configPath, 'utf8').split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, '');
    if (!withoutComment.trim()) continue;

    const indent = withoutComment.match(/^\s*/)[0].length;
    const line = withoutComment.trim();
    if (indent === 0) {
      currentList = null;
      currentObject = null;
      const match = line.match(/^([^:]+):(.*)$/);
      if (!match) throw new Error(`unsupported config line: ${rawLine}`);
      const key = match[1].trim();
      const value = match[2].trim();
      if (!value) {
        if (key === 'required_risk_tags' || key === 'preconditions') {
          root[key] = [];
          currentList = root[key];
        } else {
          root[key] = {};
          currentObject = root[key];
        }
      } else {
        root[key] = parseScalar(value);
      }
    } else if (currentList && line.startsWith('- ')) {
      currentList.push(parseScalar(line.slice(2)));
    } else if (currentObject) {
      const match = line.match(/^([^:]+):(.*)$/);
      if (!match) throw new Error(`unsupported nested config line: ${rawLine}`);
      currentObject[match[1].trim()] = parseScalar(match[2].trim());
    } else {
      throw new Error(`unsupported config indentation: ${rawLine}`);
    }
  }

  const schemaVersion = String(root.schema_version || '');
  if (!schemaVersion) throw new Error('config.schema_version is required');
  if (!schemaVersion.startsWith('2.')) throw new Error(`unsupported config schema_version ${schemaVersion}`);

  const required = root.required_risk_tags;
  if (!Array.isArray(required) || required.length === 0) {
    throw new Error('config.required_risk_tags must be a non-empty list');
  }
  const invalid = required.filter(
    (tag) => typeof tag !== 'string' || (!VALID_RISK_TAGS.has(tag) && !tag.startsWith('x-')),
  );
  if (invalid.length) throw new Error(`unknown required risk tag(s): ${invalid.join(', ')}`);

  if (!root.provenance || typeof root.provenance !== 'object') root.provenance = {};
  if (!Array.isArray(root.preconditions)) root.preconditions = [];

  return root;
}

function loadCtrf(artifactPath) {
  const ctrf = readJson(artifactPath);
  if (!ctrf || typeof ctrf !== 'object' || Array.isArray(ctrf)) throw new Error('artifact must be a JSON object');
  const results = ctrf.results;
  if (!results || typeof results !== 'object') throw new Error('artifact.results is required');
  if (!results.tool || typeof results.tool !== 'object') throw new Error('artifact.results.tool is required');
  if (!results.summary || typeof results.summary !== 'object') throw new Error('artifact.results.summary is required');
  if (!Array.isArray(results.tests)) throw new Error('artifact.results.tests must be a list');
  return ctrf;
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function* walkDicts(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    yield value;
    for (const child of Object.values(value)) yield* walkDicts(child);
  } else if (Array.isArray(value)) {
    for (const child of value) yield* walkDicts(child);
  }
}

function* iterContracts(ctrf) {
  for (const test of ctrf.results.tests) {
    const contract = test?.extra?.e2e_contract;
    if (contract && typeof contract === 'object' && !Array.isArray(contract)) {
      yield [test, contract];
    }
  }
}

function verifyEvidenceSha256(ctrf, evidenceDir) {
  const base = path.resolve(evidenceDir);
  const errors = [];
  for (const [test, contract] of iterContracts(ctrf)) {
    const testName = String(test.name || '<unknown>');
    for (const mapping of walkDicts(contract)) {
      for (const [key, expected] of Object.entries(mapping)) {
        if (!key.endsWith('_sha256') || typeof expected !== 'string') continue;
        const pathKey = `${key.slice(0, -7)}_path`;
        const relPath = mapping[pathKey];
        if (typeof relPath !== 'string' || !relPath) continue;
        const filePath = path.resolve(base, relPath);
        if (!filePath.startsWith(`${base}${path.sep}`) && filePath !== base) {
          errors.push(`${testName}: evidence path escapes base directory ${relPath}`);
          continue;
        }
        if (!existsSync(filePath)) {
          errors.push(`${testName}: missing evidence file ${relPath}`);
          continue;
        }
        if (sha256(filePath) !== expected) {
          errors.push(`${testName}: ${relPath} sha256 mismatch`);
        }
      }
    }
  }
  return errors;
}

function checkInternalConsistency(ctrf) {
  const errors = [];
  const summary = ctrf.results.summary;
  const tests = ctrf.results.tests;
  const statuses = ['passed', 'failed', 'skipped', 'pending', 'other'];

  for (const field of ['tests', ...statuses]) {
    if (!(field in summary)) errors.push(`summary.${field} is required`);
  }

  const countTotal = statuses.reduce((sum, status) => sum + Number(summary[status] || 0), 0);
  const declaredTotal = Number(summary.tests || tests.length);
  if (declaredTotal !== tests.length) {
    errors.push(`summary.tests=${declaredTotal} but artifact has ${tests.length} test entries`);
  }
  if (countTotal !== tests.length) {
    errors.push(`summary status counts total ${countTotal} but artifact has ${tests.length} test entries`);
  }
  if (Number(summary.failed || 0) > 0) {
    errors.push(`summary.failed=${summary.failed}; e2e gate requires all tests to pass`);
  }

  for (const [test, contract] of iterContracts(ctrf)) {
    if (test.status !== 'passed') continue;
    const command = contract.command_recorded;
    if (!command || typeof command !== 'object') continue;
    if (!Object.hasOwn(command, 'exit_code')) {
      errors.push(`${test.name || '<unknown>'}: command_recorded.exit_code missing`);
      continue;
    }
    const expected = Object.hasOwn(contract, 'expected_exit_code') ? contract.expected_exit_code : 0;
    if (command.exit_code !== expected) {
      errors.push(`${test.name || '<unknown>'}: exit_code ${command.exit_code} != expected ${expected}`);
    }
  }

  return errors;
}

function checkRiskCoverage(config, ctrf) {
  const required = new Set(config.required_risk_tags || []);
  const covered = new Set();
  for (const test of ctrf.results.tests) {
    if (test.status !== 'passed') continue;
    for (const tag of test.tags || []) {
      if (typeof tag === 'string' && tag.startsWith('risk:')) covered.add(tag.slice('risk:'.length));
    }
  }
  return [...required].filter((tag) => !covered.has(tag)).sort();
}

function runCheck(configPath, artifactPath, evidenceDir) {
  const result = {
    artifact_path: artifactPath,
    config_path: configPath,
    failures: [],
    missing: [],
    mode: 'ctrf',
    schema_version: '2.0',
    status: 'failed',
    steps: {},
  };

  let config;
  let ctrf;
  try {
    config = loadConfig(configPath);
    ctrf = loadCtrf(artifactPath);
    result.steps.parse = 'pass';
  } catch (error) {
    result.status = 'invalid';
    result.failures.push(error instanceof Error ? error.message : String(error));
    result.steps.parse = 'fail';
    return [result, 3];
  }

  if (config.provenance?.cosign_required) {
    result.failures.push('cosign provenance verification is not available in this repo-local gate');
    result.steps.provenance = 'fail';
    return [result, 1];
  }
  result.steps.provenance = 'skipped';

  const evidenceErrors = verifyEvidenceSha256(ctrf, evidenceDir);
  if (evidenceErrors.length) {
    result.status = 'invalid';
    result.failures.push(...evidenceErrors);
    result.steps.evidence_sha256 = 'fail';
    return [result, 4];
  }
  result.steps.evidence_sha256 = 'pass';

  const consistencyErrors = checkInternalConsistency(ctrf);
  if (consistencyErrors.length) {
    result.failures.push(...consistencyErrors);
    result.steps.internal_consistency = 'fail';
    return [result, 1];
  }
  result.steps.internal_consistency = 'pass';

  const missing = checkRiskCoverage(config, ctrf);
  result.missing = missing;
  if (missing.length) {
    result.failures.push(`missing required risk tags: ${missing.join(', ')}`);
    result.steps.risk_coverage = 'fail';
    return [result, 1];
  }
  result.steps.risk_coverage = 'pass';
  result.status = 'pass';
  return [result, 0];
}

function runPreconditions(config, projectRoot) {
  const records = [];
  for (const item of config.preconditions || []) {
    if (!item || typeof item !== 'object' || !item.check) continue;
    const completed = spawnSync(String(item.check), {
      cwd: projectRoot,
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    records.push({
      check: item.check,
      exit_code: completed.status ?? 1,
      name: item.name || 'precondition',
      remediation: item.remediation || '',
      status: completed.status === 0 ? 'pass' : 'fail',
      stderr: (completed.stderr || '').trim(),
      stdout: (completed.stdout || '').trim(),
    });
  }
  return records;
}

function runGate(args) {
  const projectRoot = path.resolve(args.project);
  const e2eDir = path.join(projectRoot, '.e2e');
  const configPath = path.join(e2eDir, 'config.yaml');
  const artifactPath = path.join(e2eDir, 'artifact.json');
  const result = {
    artifact_path: artifactPath,
    check_exit_code: null,
    config_path: configPath,
    exit_code: 1,
    missing: [],
    mode: 'ctrf',
    preconditions: [],
    run_exit_code: null,
    schema_version: '2.0',
    status: 'failed',
  };

  if (!existsSync(configPath)) {
    result.status = args.required ? 'missing_contract' : 'no_contract';
    result.exit_code = args.required ? 3 : 0;
    return [result, result.exit_code];
  }

  let config;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    result.status = 'invalid';
    result.failures = [error instanceof Error ? error.message : String(error)];
    result.exit_code = 3;
    return [result, 3];
  }

  const preconditions = runPreconditions(config, projectRoot);
  result.preconditions = preconditions;
  if (preconditions.some((item) => item.status !== 'pass')) {
    result.status = 'precondition_failed';
    result.exit_code = 2;
    return [result, 2];
  }

  let runExit = 0;
  if (!args.skipRun) {
    const runScript = path.join(e2eDir, 'run.sh');
    if (!existsSync(runScript)) {
      result.status = 'invalid';
      result.failures = ['.e2e/run.sh is missing'];
      result.exit_code = 3;
      return [result, 3];
    }
    const completed = spawnSync('bash', [runScript], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, E2E_CONTRACT_ACTIVE: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runExit = completed.status ?? 1;
    result.run_stdout = (completed.stdout || '').trim();
    result.run_stderr = (completed.stderr || '').trim();
  }
  result.run_exit_code = runExit;

  const [check, checkExit] = runCheck(configPath, artifactPath, e2eDir);
  result.check = check;
  result.check_exit_code = checkExit;
  result.missing = check.missing || [];
  result.exit_code = checkExit || (runExit !== 0 ? 1 : 0);
  result.status = result.exit_code === 0 ? 'pass' : 'fail';
  return [result, result.exit_code];
}

try {
  const args = parseArgs(process.argv.slice(2));
  const [result, exitCode] = runGate(args);
  process.stdout.write(JSON.stringify(result, null, args.json ? 2 : 0) + '\n');
  process.exit(exitCode);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(3);
}
