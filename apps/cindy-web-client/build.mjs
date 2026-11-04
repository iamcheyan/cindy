import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'src', 'main.tsx')],
  bundle: true,
  outfile: path.join(dist, 'app.js'),
  format: 'esm',
  target: ['es2022'],
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  loader: {
    '.svg': 'dataurl',
  },
});

const html = await readFile(path.join(root, 'src', 'index.html'), 'utf8');
await copyFile(path.join(root, 'src', 'index.html'), path.join(dist, 'index.html'));
if (!html.includes('./app.js') || !html.includes('./app.css')) {
  throw new Error('index.html must reference ./app.js and ./app.css');
}
console.log(`web client built: ${dist}`);
