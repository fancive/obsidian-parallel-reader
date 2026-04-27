#!/usr/bin/env node
/**
 * Bump plugin version in manifest.json and versions.json atomically.
 * Usage: node scripts/bump-version.mjs <version>
 * Example: node scripts/bump-version.mjs 1.0.8
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2];
const force = process.argv.includes('--force');

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node scripts/bump-version.mjs <version> [--force]');
  console.error('Example: node scripts/bump-version.mjs 1.0.8');
  process.exit(1);
}

const manifestPath = path.join(root, 'manifest.json');
const versionsPath = path.join(root, 'versions.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));

if (versions[version] !== undefined && !force) {
  console.error(`Version ${version} already exists in versions.json. Use --force to override.`);
  process.exit(1);
}

const oldVersion = manifest.version;
manifest.version = version;
versions[version] = manifest.minAppVersion;

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
fs.writeFileSync(versionsPath, JSON.stringify(versions, null, '\t') + '\n');

// Stage files so npm version hook includes them in the auto-commit.
try {
  execFileSync('git', ['add', manifestPath, versionsPath], { cwd: root });
} catch (_) {
  // Not in a git repo or git not available — skip staging.
}

console.log(`Bumped version: ${oldVersion} → ${version}`);
console.log(`Updated: manifest.json, versions.json`);
