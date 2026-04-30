import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const resultPath = path.resolve(repoRoot, process.env.LIVE_E2E_RESULT || '.e2e/results/live.json');
const startedAt = Date.now();

function writeResult(result) {
  mkdirSync(path.dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function defaultVaultPath() {
  return path.join(os.homedir(), 'Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault');
}

function main() {
  if (process.env.TEST_LIVE !== '1') {
    writeResult({
      name: 'live Vault install smoke',
      category: 'live',
      status: 'skipped',
      durationMs: Date.now() - startedAt,
      reason: 'Set TEST_LIVE=1 to check a real local Vault installation.',
    });
    return;
  }

  const vaultRoot = process.env.OBSIDIAN_VAULT_PATH || defaultVaultPath();
  const pluginDir = path.join(vaultRoot, '.obsidian/plugins/parallel-reader');
  const files = ['main.js', 'manifest.json', 'styles.css'];
  const missing = files.filter((file) => !existsSync(path.join(pluginDir, file)));
  if (missing.length) {
    writeResult({
      name: 'live Vault install smoke',
      category: 'live',
      status: 'failed',
      durationMs: Date.now() - startedAt,
      vaultRoot,
      missing,
    });
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
  const sourceManifest = JSON.parse(readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));
  const hashChecks = files.map((file) => ({
    file,
    sourceSha256: sha256(path.join(repoRoot, file)),
    installedSha256: sha256(path.join(pluginDir, file)),
  }));
  const mismatched = hashChecks.filter((check) => check.sourceSha256 !== check.installedSha256);

  writeResult({
    name: 'live Vault install smoke',
    category: 'live',
    status: mismatched.length ? 'failed' : 'passed',
    durationMs: Date.now() - startedAt,
    vaultRoot,
    manifest: {
      installedId: manifest.id,
      installedVersion: manifest.version,
      sourceVersion: sourceManifest.version,
    },
    hashChecks,
  });

  if (mismatched.length) process.exit(1);
}

main();
