// dsh-im-notify — settings-panel smoke test (no DSH, no network).
// Drives the bundled host entry apply() through the unconfigured (idle) path
// with a stub ctx, then exercises the /api/dsh-im-notify fetch handler:
// envelope validation, status, watch add/remove/clear, unknown method.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// NOTE: imports the ESM sources, not lib/index.js — the esbuild bundle's CJS
// shim for the lark SDK only works under the DSH loader (same as dsh-im's).
import { apply } from '../plugin-src/host/index.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const home = await mkdtemp(join(tmpdir(), 'dsh-notify-smoke-'));

let fetchDef = null;
const effects = [];
const ctx = {
  log: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => { effects.push(fn); return () => { const i = effects.indexOf(fn); if (i >= 0) effects.splice(i, 1); }; },
  on: () => () => {},
  connection: {
    fetch: {
      register(def) { fetchDef = def; return () => { fetchDef = null; }; },
    },
  },
  typertGateway: { invoke: async () => { throw new Error('no gateway in smoke'); }, stream: async () => { throw new Error('no gateway in smoke'); } },
};

const dispose = await apply(ctx, { dshHome: home });
check('apply(idle) registers effect disposer (no return value)', dispose === undefined && effects.length === 1);
check('fetch handler registered', fetchDef?.path === '/api/dsh-im-notify' && fetchDef.methods.includes('POST'));

const RPC_KEY = 'dsh-im-notify';
let rpcSeq = 0;
async function rpc(method, payload, { envelope = 'good', origin = 'http://127.0.0.1:4583' } = {}) {
  const body = envelope === 'good'
    ? { type: 'client-request', rpcId: `r${++rpcSeq}`, method: RPC_KEY, payload: { method, payload } }
    : envelope;
  const request = new Request('http://127.0.0.1:3080/api/dsh-im-notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:3080', origin },
    body: JSON.stringify(body),
  });
  const response = await fetchDef.fetch(request);
  return response;
}

// --- envelope / transport validation ---
let res = await rpc('status', {});
check('status: 200 + server-response envelope', res.status === 200, `http ${res.status}`);
let message = await res.json();
check('status: server-response shape', message.type === 'server-response' && typeof message.rpcId === 'string' && message.result?.ok === true);

let value = message.result.value;
check('status: unconfigured idle snapshot',
  value.configured === false && value.watchCount === 0 && value.botReady === false && Array.isArray(value.watches),
  `configured=${value.configured} watches=${value.watchCount}`);

res = await rpc('status', {}, { envelope: { type: 'nonsense' } });
check('bad envelope → ok:false bad-request', res.status === 200 && (await res.json()).result?.ok === false);

res = await rpc('status', {}, { origin: 'http://evil.example.com' });
check('non-loopback origin → 403', res.status === 403);

res = await fetchDef.fetch(new Request('http://127.0.0.1:3080/api/dsh-im-notify', {
  method: 'POST',
  headers: { 'content-type': 'text/plain', host: '127.0.0.1:3080' },
  body: 'x',
}));
check('wrong content-type → 415', res.status === 415);

res = await rpc('no.such.method', {});
message = await res.json();
check('unknown method → ok:false bad-request', message.result?.ok === false && message.result?.error?.code === 'bad-request');

// --- watch lifecycle through the handler ---
// (StateStore is live in idle mode: watches persist even without Feishu)
value = (await (await rpc('watch.clear', {})).json()).result.value;
check('watch.clear ok on empty', value.watchCount === 0);

// seed a watch through StateStore via a poll-free route: registration.poll stale-attempt
res = await rpc('registration.poll', { attemptId: '999' });
message = await res.json();
check('registration.poll stale attempt → ok:false stale-attempt', message.result?.ok === false && message.result?.error?.code === 'stale-attempt');

res = await rpc('registration.cancel', { attemptId: '999' });
message = await res.json();
check('registration.cancel unknown attempt → ok', message.result?.ok === true);

// dispose path must not throw even from idle (via the ctx.effect disposer)
let disposed = true;
try { for (const fn of [...effects]) fn(); } catch { disposed = false; }
check('dispose(idle) clean', disposed);

// --- registration state machine (mocked SDK, no network) ---
const { createRegistrationManager, maskAppId } = await import('../plugin-src/host/registration.mjs');
check('maskAppId', maskAppId('cli_a1b2c3d4e5f6g7h8') === 'cli_a1…g7h8', maskAppId('cli_a1b2c3d4e5f6g7h8'));

const savedCredentials = [];
let releaseScan = null;
const scanPromise = new Promise((resolve) => { releaseScan = resolve; });
const manager = createRegistrationManager({
  getConfig: () => (savedCredentials.length === 1
    ? { appId: savedCredentials[0].appId }
    : {}),
  saveCredentials: async (c) => { savedCredentials.push(c); },
  registerApp: async (options) => {
    options.onQRCodeReady({ url: 'https://accounts.feishu.cn/oauth/v1/device/authorize?user_code=SMOKE', expireIn: 600 });
    options.onStatusChange({ status: 'polling' });
    await scanPromise;
    return { client_id: 'cli_a1b2c3d4e5f6g7h8', client_secret: 'SECRET', user_info: { open_id: 'ou_smoke' } };
  },
});

const begun = await manager.begin();
check('begin: qr_ready with data URL',
  begun.state === 'qr_ready' && begun.qrCodeUrl?.includes('user_code=SMOKE')
  && begun.qrCodeDataUrl?.startsWith('data:image/png;base64,'),
  `state=${begun.state}`);
// Contract the settings client relies on: begin's value (→ RPC envelope value) carries
// a non-empty attemptId. Regression for the "poll STALE attemptId=undefined" incident.
check('begin: value carries non-empty attemptId (client contract)',
  typeof begun.attemptId === 'string' && begun.attemptId.length > 0, `attemptId=${JSON.stringify(begun.attemptId)}`);

let polled = await manager.poll(begun.attemptId);
check('poll: qr_ready phase', polled.ok === true && polled.state === 'qr_ready');

releaseScan();
await new Promise((resolve) => setTimeout(resolve, 100));
polled = await manager.poll(begun.attemptId);
check('poll: succeeded after scan', polled.ok === true && polled.state === 'succeeded' && polled.appIdMasked === 'cli_a1…g7h8',
  `state=${polled.state}`);

check('saveCredentials received app id + openId',
  savedCredentials.length === 1 && savedCredentials[0].appId === 'cli_a1b2c3d4e5f6g7h8' && savedCredentials[0].openId === 'ou_smoke');

manager.cancel(begun.attemptId);
const stale = await manager.poll(begun.attemptId);
check('poll after cancel: stale-attempt', stale.ok === false && stale.error?.code === 'stale-attempt');

// --- repair-mode contract: begin({appId}) → SDK gets appId, no createOnly ---
const registerAppCalls = [];
const repairManager = createRegistrationManager({
  getConfig: () => ({ appId: 'cli_existing' }),
  saveCredentials: async () => {},
  registerApp: async (options) => {
    registerAppCalls.push(options);
    options.onQRCodeReady({ url: 'https://accounts.feishu.cn/oauth/v1/device/authorize?user_code=REPAIR', expireIn: 600 });
    return { client_id: 'cli_existing', client_secret: 'SECRET2', user_info: { open_id: 'ou_repair' } };
  },
});
const repairBegun = await repairManager.begin({ appId: 'cli_existing' });
check('begin({appId}) repair mode: SDK receives appId, createOnly absent',
  registerAppCalls[0]?.appId === 'cli_existing' && registerAppCalls[0]?.createOnly === undefined,
  `appId=${registerAppCalls[0]?.appId} createOnly=${registerAppCalls[0]?.createOnly}`);
check('begin({appId}) still returns qr_ready + attemptId',
  repairBegun.state === 'qr_ready' && typeof repairBegun.attemptId === 'string');
repairManager.cancel(repairBegun.attemptId);

// --- StateStore regression: save() must persist credentials to config.json ---
// Incident 2026-11-17: QR scan succeeded, log said "credentials saved", but
// config.json never hit disk (save() only wrote state.json) → lost on restart.
const { StateStore } = await import('../plugin-src/host/state.mjs');
const { PLUGIN_VERSION } = await import('../plugin-src/host/index.mjs');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
check('PLUGIN_VERSION matches package.json version', PLUGIN_VERSION === pkg.version,
  `PLUGIN_VERSION=${PLUGIN_VERSION} pkg=${pkg.version}`);

// --- webServer exact-route leg (cold-start path, dshmarket-proven mount) ---
// Simulates a host where the webServer service is ready and connection.fetch
// is absent: the RPC must still be reachable through the node-style handler.
{
  const { installSettingsRpc } = await import('../plugin-src/host/settings-rpc.mjs');
  const registered = [];
  const wsCtx = {
    webServer: { register(route) { registered.push(route); return () => {}; } },
    effect: (fn) => { fn(); return () => {}; },
  };
  const ctxWs = {
    inject: (deps, cb) => { if (deps.includes('webServer')) cb(wsCtx); return () => {}; },
  };
  const stop = installSettingsRpc(ctxWs, async (method) => ({ ok: true, value: { pong: method } }), { log: () => {} });
  check('webServer leg: exact route registered at /api/dsh-im-notify',
    registered.length === 1 && registered[0].kind === 'exact' && registered[0].path === '/api/dsh-im-notify');

  const makeReq = (headers, body) => ({
    method: 'POST',
    headers,
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  });
  const makeRes = () => {
    const out = { status: 0, body: '' };
    return {
      out,
      writeHead(status, hdrs) { out.status = status; out.headers = hdrs; },
      end(payload) { out.body = String(payload ?? ''); },
    };
  };
  const envelope = JSON.stringify({ type: 'client-request', rpcId: 'wsr1', method: 'dsh-im-notify', payload: { method: 'ping', payload: {} } });
  const res1 = makeRes();
  await registered[0].handler(makeReq({ host: '127.0.0.1:8948', 'content-type': 'application/json' }, envelope), res1);
  const parsed = JSON.parse(res1.out.body);
  check('webServer leg: 200 + server-response envelope + handler value',
    res1.out.status === 200 && parsed.type === 'server-response' && parsed.rpcId === 'wsr1' && parsed.result?.value?.pong === 'ping',
    `status=${res1.out.status}`);

  const res2 = makeRes();
  await registered[0].handler(makeReq({ host: 'evil.example.com', 'content-type': 'application/json' }, envelope), res2);
  check('webServer leg: non-loopback host → 403', res2.out.status === 403);
  stop();
}
const storeHome = await mkdtemp(join(tmpdir(), 'dsh-notify-state-'));
const store = new StateStore(storeHome, () => {});
await store.load({});
store.config = { ...store.config, appId: 'cli_smoke123', appSecret: 'sec_smoke' };
store.save();
await new Promise((resolve) => setTimeout(resolve, 600));
let cfgOnDisk = null;
try { cfgOnDisk = JSON.parse(await readFile(join(storeHome, 'config.json'), 'utf8')); } catch { /* missing = fail below */ }
check('StateStore.save persists config.json credentials',
  cfgOnDisk?.appId === 'cli_smoke123' && cfgOnDisk?.appSecret === 'sec_smoke',
  `appId=${cfgOnDisk?.appId ?? 'missing'}`);

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
