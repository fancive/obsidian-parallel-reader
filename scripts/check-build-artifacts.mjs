import { execFileSync } from 'node:child_process';

function diffMainJs() {
  return execFileSync('git', ['diff', '--', 'main.js'], { encoding: 'utf8' });
}

const before = diffMainJs();

execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });

const after = diffMainJs();

if (after !== before) {
  console.error('\nmain.js is not in sync with the TypeScript source.');
  console.error('Run `npm run build` and include the updated main.js in the same change.');
  process.exit(1);
}

console.log('main.js is in sync with the TypeScript source.');
