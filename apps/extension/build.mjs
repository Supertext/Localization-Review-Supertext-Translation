// Builds the extension into dist/ (load it unpacked from there); with --zip also
// dist/supertext-localization-review-<version>.zip for the Chrome Web Store and releases.
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: { background: 'src/background.ts', content: 'src/content.ts', panel: 'src/panel.ts' },
  absWorkingDir: here,
  outdir: dist,
  bundle: true,
  // The content script is injected as a classic script; the others are modules.
  format: 'iife',
  target: 'chrome140',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});
await cp(path.join(here, 'static'), dist, { recursive: true });

const pkg = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`manifest.json says ${manifest.version}, package.json ${pkg.version}`);
if (process.argv.includes('--e2e')) {
  // Tests only: grant local test servers up front, so no permission prompt has to be clicked.
  if (process.argv.includes('--zip')) throw new Error('--e2e builds are never released');
  manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
  await writeFile(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

if (process.argv.includes('--zip')) {
  const zip = path.join(here, 'release', `supertext-localization-review-${pkg.version}.zip`);
  await mkdir(path.dirname(zip), { recursive: true });
  await rm(zip, { force: true });
  execFileSync('zip', ['-qrX', zip, '.'], { cwd: dist });
  console.log(path.relative(here, zip));
}
console.log('built dist/');
