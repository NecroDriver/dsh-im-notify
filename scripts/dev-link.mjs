// dev-link — wire this checkout into a DSH profile for live development.
// Creates a junction  <profile>/node_modules/dsh-im-notify → this directory
// and appends the bundle name to dsh.profile.bundles if missing.
// Usage: node scripts/dev-link.mjs [--profile <dir>]
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const profileFlag = args.indexOf('--profile');
const profileDir = profileFlag >= 0 && args[profileFlag + 1]
  ? resolve(args[profileFlag + 1])
  : (process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop'));

const target = join(profileDir, 'node_modules', 'dsh-im-notify');
console.log(`[dev-link] profile: ${profileDir}`);
console.log(`[dev-link] project: ${projectDir}`);

if (!existsSync(join(projectDir, 'lib', 'index.js'))) {
  console.error('[dev-link] lib/index.js missing — run `npm run build` first.');
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
if (existsSync(target)) {
  if (!lstatSync(target).isSymbolicLink()) {
    console.error(`[dev-link] ${target} exists and is not a link — remove it first if you want to replace it.`);
    process.exit(1);
  }
  console.log('[dev-link] junction already present, keeping it.');
} else {
  symlinkSync(projectDir, target, 'junction');
  console.log(`[dev-link] junction created: ${target} → ${projectDir}`);
}

const pkgFile = join(profileDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
if (!pkg.dsh.profile.bundles.includes('dsh-im-notify')) {
  const backup = `${pkgFile}.bak-${Date.now()}`;
  writeFileSync(backup, JSON.stringify(pkg, null, 2), 'utf8');
  pkg.dsh.profile.bundles.push('dsh-im-notify');
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2), 'utf8');
  console.log(`[dev-link] added bundle entry (backup: ${backup})`);
} else {
  console.log('[dev-link] bundle entry already present.');
}
console.log('[dev-link] done — restart the DSH Host (or toggle the plugin) to load dsh-im-notify.');
