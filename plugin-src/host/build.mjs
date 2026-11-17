// dsh-im-notify build — esbuild bundle of the host plugin entry.
// Mirrors the dsh-im pipeline: single ESM bundle into lib/, no sourcemap,
// everything inlined except the cordis runtime (which this plugin never
// imports directly, but keep it external for safety).
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

await mkdir(join(root, 'lib'), { recursive: true });

await build({
  entryPoints: [join(root, 'plugin-src', 'host', 'index.mjs')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(root, 'lib', 'index.js'),
  // Keep deps external, exactly like every stock DSH plugin (dshmarket etc.):
  // inlining the CommonJS lark SDK into an ESM bundle breaks CJS globals
  // (require, __dirname) at load time. External deps resolve from the
  // installed package's node_modules at runtime.
  external: ['@deepseek-ai/cordis', '@larksuiteoapi/node-sdk', 'qrcode'],
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});

console.log('[dsh-im-notify] built lib/index.js');
