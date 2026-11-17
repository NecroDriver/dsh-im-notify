// probe-wss.mjs — does the Feishu WSS handshake work in bare node?
// Mirrors SDK WSClient.pullConnectConfig (es/index.js:102535): POST
// {domain}/callback/ws/endpoint with {AppID, AppSecret} → data.URL, then
// a global WebSocket connect against that URL.
// Usage: node scripts/probe-wss.mjs [--dsh-home <dir>]
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
let dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
{
  const i = args.indexOf('--dsh-home');
  if (i >= 0) dshHome = args[i + 1];
}
const t0 = Date.now();
const el = () => `${Date.now() - t0}ms`;
const cfg = JSON.parse(await readFile(join(dshHome, 'integrations', 'dsh-im-notify', 'config.json'), 'utf8'));
console.log(`[${el()}] config: appId=${cfg.appId?.slice(0, 8)}… domain=${cfg.domain ?? 'feishu'}`);
const base = (cfg.domain === 'lark') ? 'https://open.larksuite.com' : 'https://open.feishu.cn';

const epRes = await fetch(`${base}/callback/ws/endpoint`, {
  method: 'POST', headers: { 'content-type': 'application/json', locale: 'zh' },
  body: JSON.stringify({ AppID: cfg.appId, AppSecret: cfg.appSecret }),
});
const ep = await epRes.json();
console.log(`[${el()}] ws/endpoint: code=${ep.code} msg=${ep.msg} url=${ep.data?.URL ? ep.data.URL.slice(0, 60) + '…' : 'NONE'}`);
if (!ep.data?.URL) process.exit(1);

// global WebSocket (undici) in bare node
const ws = new WebSocket(ep.data.URL);
const timeout = setTimeout(() => { console.log(`[${el()}] TIMEOUT: no open/close/error within 15s`); process.exit(2); }, 15000);
ws.addEventListener('open', () => { console.log(`[${el()}] ✅ WSS OPEN — handshake succeeded in bare node`); clearTimeout(timeout); setTimeout(() => process.exit(0), 500); });
ws.addEventListener('error', (e) => { console.log(`[${el()}] ❌ WSS ERROR: ${e.message ?? e.error ?? e.type}`); clearTimeout(timeout); });
ws.addEventListener('close', (e) => { console.log(`[${el()}] WSS CLOSED: code=${e.code} reason=${e.reason}`); clearTimeout(timeout); });
