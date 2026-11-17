// dsh-im-notify client build — mirrors the dsh-im pipeline:
// esbuild bundle → CJS/browser → self-registering window.__ModuleLoader__ script.
// The DSH web shell executes lib/client.js and loads it by package id.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDirectory, '../..');
const outputPath = resolve(packageRoot, 'lib/client.js');
const loaderId = process.env.DSH_NOTIFY_CLIENT_ID ?? 'dsh-im-notify';

const result = await build({
  entryPoints: [resolve(sourceDirectory, 'index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  external: ['react', 'react-dom'],
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
});
const bundled = result.outputFiles?.[0]?.text;
if (!bundled) throw new Error('esbuild did not produce a client bundle');

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`;
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, wrapped, 'utf8');
console.log(`[dsh-im-notify] built lib/client.js (loader id: ${loaderId})`);
