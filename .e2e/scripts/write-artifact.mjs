import fs from 'fs';

const riskMap = JSON.parse(fs.readFileSync('.e2e/cases/npm-test-risk-map.json', 'utf8'));
const runExit = Number(process.env.RUN_EXIT || 1);
const startMs = Number(process.env.START_MS || Date.now());
const endMs = Number(process.env.END_MS || startMs);
const durationMs = Math.max(0, endMs - startMs);
const logPath = String(process.env.LOG || '.e2e/results/npm-test.log').replace(/^\.e2e\//, '');
const logSha = String(process.env.LOG_SHA || '');

const command = {
  command: 'npm test',
  exit_code: runExit,
};

const tests =
  runExit === 0
    ? riskMap.tests.map((test) => ({
        name: test.name,
        status: 'passed',
        duration: durationMs / riskMap.tests.length,
        tags: test.risk_tags.map((tag) => `risk:${tag}`),
        extra: {
          e2e_contract: {
            command_recorded: command,
            expected_exit_code: 0,
            evidence: {
              log_path: logPath,
              log_sha256: logSha,
            },
            source_files: test.source_files,
          },
        },
      }))
    : [
        {
          name: 'npm test',
          status: 'failed',
          duration: durationMs,
          tags: [],
          extra: {
            e2e_contract: {
              command_recorded: command,
              expected_exit_code: 0,
              evidence: {
                log_path: logPath,
                log_sha256: logSha,
              },
            },
          },
        },
      ];

const summary = {
  tests: tests.length,
  passed: tests.filter((test) => test.status === 'passed').length,
  failed: tests.filter((test) => test.status === 'failed').length,
  pending: 0,
  skipped: 0,
  other: 0,
};

const artifact = {
  reportFormat: 'CTRF',
  specVersion: '0.0.0',
  results: {
    tool: {
      name: 'npm',
      version: 'test',
    },
    summary,
    tests,
  },
};

fs.writeFileSync('.e2e/artifact.json', JSON.stringify(artifact, null, 2) + '\n');
