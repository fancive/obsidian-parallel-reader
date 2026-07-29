#!/usr/bin/env node
/**
 * Bump plugin version in manifest.json and versions.json atomically.
 * Usage: node scripts/bump-version.mjs <version> [--force] [--tag]
 * Example: node scripts/bump-version.mjs 1.0.8
 *
 * By default this only writes manifest.json/versions.json and stages them
 * with `git add` (existing behavior, relied on by anyone invoking this via
 * `npm version`/`npm run version`). Pass --tag to additionally commit the
 * staged files and create a lightweight git tag for the version in the same
 * step, so bumping and tagging are no longer two separate manual actions.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2];
const force = process.argv.includes('--force');
const shouldTag = process.argv.includes('--tag');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node scripts/bump-version.mjs <version> [--force] [--tag]');
  console.log('Example: node scripts/bump-version.mjs 1.0.8 --tag');
  console.log('  --force  overwrite an existing versions.json entry for <version>');
  console.log('  --tag    commit manifest.json/versions.json and create git tag <version>');
  process.exit(0);
}

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node scripts/bump-version.mjs <version> [--force] [--tag]');
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

if (shouldTag) {
  const changelogPath = path.join(root, 'CHANGELOG.md');
  const hasChangelogEntry =
    fs.existsSync(changelogPath) && fs.readFileSync(changelogPath, 'utf8').includes(`## [${version}]`);
  if (!hasChangelogEntry) {
    console.warn(
      `Warning: CHANGELOG.md has no "## [${version}]" section yet. ` +
        'The release workflow reads that section for release notes and ' +
        'will fail its changelog guard until one is added.',
    );
  }

  try {
    execFileSync('git', ['commit', '-m', `chore: bump version to ${version}`], {
      cwd: root,
      stdio: 'inherit',
    });
  } catch (err) {
    console.error(`Failed to commit version bump: ${err.message}`);
    process.exit(1);
  }

  try {
    execFileSync('git', ['tag', version], { cwd: root, stdio: 'inherit' });
  } catch (err) {
    console.error(`Failed to create tag ${version}: ${err.message}`);
    console.error('The commit was created; create the tag manually with `git tag <version>` once resolved.');
    process.exit(1);
  }

  console.log(`Committed and tagged ${version}. Push with: git push && git push origin ${version}`);
}
