import esbuild from 'esbuild';
import { builtinModules } from 'module';

const production = process.argv[2] === 'production';
const watch = process.argv[2] === 'watch';

const external = [
  'obsidian',
  'electron',
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
];

const context = await esbuild.context({
  entryPoints: ['main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2020',
  external,
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  minify: production,
  outfile: 'main.js',
  banner: {
    js: "'use strict';",
  },
});

if (watch) {
  await context.watch();
  console.log('Watching for changes...');
} else {
  await context.rebuild();
  await context.dispose();
}
