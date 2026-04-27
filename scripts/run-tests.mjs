import { execFileSync } from 'child_process';
import { readdirSync } from 'fs';
import { join } from 'path';

const testsDir = join(import.meta.dirname, '..', 'tests');
const files = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

let failed = 0;
for (const file of files) {
  const filePath = join(testsDir, file);
  try {
    execFileSync('node', [filePath], { stdio: 'inherit' });
  } catch {
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} test file(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} test files passed.`);
