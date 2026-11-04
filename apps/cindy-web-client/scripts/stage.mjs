import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(root, '..');
const dist = path.join(packageRoot, 'dist');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args[outIndex + 1] : null;
if (!out) {
  console.error('usage: node scripts/stage.mjs --out <directory>');
  process.exitCode = 2;
} else {
  const target = path.resolve(out);
  await mkdir(target, { recursive: true });
  const files = ['index.html', 'app.js', 'app.css'];
  const digests = {};
  for (const file of files) {
    const source = path.join(dist, file);
    await copyFile(source, path.join(target, file));
    digests[file] = createHash('sha256').update(await readFile(source)).digest('hex');
  }
  await writeFile(
    path.join(target, 'web-client-manifest.json'),
    JSON.stringify(
      {
        contractVersion: 1,
        files: digests,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
    { encoding: 'utf8', mode: 0o644 },
  );
  console.log(JSON.stringify({ ok: true, target, contractVersion: 1, files: digests }, null, 2));
}
