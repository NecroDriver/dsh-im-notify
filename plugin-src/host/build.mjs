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
  external: ['@deepseek-ai/cordis'],
  // The lark SDK is CommonJS; inlined into an ESM bundle esbuild would emit a
  // throwing __require shim ("Dynamic require of util is not supported") that
  // fires at load time (the SDK requires node builtins at top level). The
  // official fix: provide a real require via createRequire.
  banner: {
    js: "import { createRequire as __dshNotifyCreateRequire } from 'node:module';\nconst require = __dshNotifyCreateRequire(import.meta.url);",
  },
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});

console.log('[dsh-im-notify] built lib/index.js');
