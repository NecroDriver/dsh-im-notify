// dsh-im-notify — settings-panel RPC carrier on the public /api fetch bus.
//
// Wire shape mirrors dsh-im's management-rpc.mjs (client+host share it there):
//   client: ctx.connection.rpc.call('/api', 'dsh-im-notify', { method, payload }, signal)
//   host:   ctx.connection.fetch.register({ path: '/api/dsh-im-notify', ... })
// envelope: { type:'client-request', rpcId, method:'dsh-im-notify', payload:{method,payload} }
// response: Response.json({ type:'server-response', rpcId, result:{ok,value|error} })
//
// Default policy = loopback only (same as dsh-im): Host/Origin must be
// localhost, mirroring the DSH management surface this rides on.

const RPC_KEY = 'dsh-im-notify';

function isLoopbackAuthority(authority) {
  if (!authority) return false;
  try {
    const url = new URL(`http://${authority}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    const hostname = url.hostname.replace(/\.$/, '');
    return hostname === 'localhost' || hostname === '[::1]'
      || /^127\.\d+\.\d+\.\d+$/.test(hostname);
  } catch {
    return false;
  }
}

function isLoopbackRequest(request) {
  if (!isLoopbackAuthority(request.headers.get('host'))) return false;
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && isLoopbackAuthority(url.host);
  } catch {
    return false;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reply(rpcId, result) {
  const value = result?.ok === false
    ? { ...result, error: { details: {}, ...result.error } }
    : result;
  return Response.json({ type: 'server-response', rpcId, result: value });
}

// ---- leg 1: bare webServer `exact` route ---------------------------------
// Production-proven by dshmarket (lib/index.js + lib/routes.js): `exact`
// registrations win over the host's `/api` fence and the webServer service is
// ready before `connection` is (`HostConnectionService` awaits BrowserAuth —
// dshmarket #729), which is exactly why a connection.fetch-only mount can go
// 404 after a cold start. Node-style (request, response) handler.
function nodeReply(response, status, body, contentType = 'application/json') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(status, { 'content-type': `${contentType}; charset=utf-8`, 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

function isLoopbackNodeRequest(request) {
  if (!isLoopbackAuthority(request.headers?.host)) return false;
  const origin = request.headers?.origin;
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && isLoopbackAuthority(url.host);
  } catch {
    return false;
  }
}

async function handleNodeRequest(request, response, handler, log) {
  try {
    if (!isLoopbackNodeRequest(request)) return nodeReply(response, 403, 'forbidden', 'text/plain');
    if (request.method !== 'POST') return nodeReply(response, 405, 'method not allowed', 'text/plain');
    const contentType = String(request.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') return nodeReply(response, 415, 'content type must be application/json', 'text/plain');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let message;
    try {
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return nodeReply(response, 400, 'body is not JSON', 'text/plain');
    }
    const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
    const call = message?.payload;
    if (!isRecord(message) || message.type !== 'client-request'
      || message.method !== RPC_KEY || !isRecord(call) || typeof call.method !== 'string'
      || !Object.hasOwn(call, 'payload')) {
      return nodeReply(response, 200, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'bad-request', message: 'Invalid settings request.' } } });
    }
    try {
      log(`[settings-rpc] ${call.method} invoked`);
      const result = await handler(call.method, call.payload);
      log(`[settings-rpc] ${call.method} → ${result?.ok ? 'ok' : `error:${result?.error?.code}`}`);
      return nodeReply(response, 200, { type: 'server-response', rpcId, result: result ?? { ok: true, value: null } });
    } catch (error) {
      log(`[dsh-im-notify] settings rpc ${call.method} failed: ${error?.message ?? error}`, 'warn');
      return nodeReply(response, 500, 'settings handler failed', 'text/plain');
    }
  } catch (error) {
    try { nodeReply(response, 500, 'internal error', 'text/plain'); } catch { /* response gone */ }
    log(`[dsh-im-notify] settings route error: ${error?.message ?? error}`, 'warn');
  }
}

function installWebServerRoute(ctx, handler, { log = () => {} } = {}) {
  if (typeof ctx?.inject !== 'function') return () => {};
  let unregister = null;
  let cancelInject = null;
  try {
    cancelInject = ctx.inject(['webServer'], (wsCtx) => {
      wsCtx.effect(() => {
        if (typeof wsCtx?.webServer?.register !== 'function') return () => {};
        log('[dsh-im-notify] settings route mounted on webServer (exact)');
        unregister = wsCtx.webServer.register({
          kind: 'exact',
          path: `/api/${RPC_KEY}`,
          handler: (request, response) => handleNodeRequest(request, response, handler, log),
        });
        return () => { try { unregister?.(); } catch { /* already gone */ } unregister = null; };
      }, 'dsh-im-notify: settings webServer route');
    });
  } catch (error) {
    log(`[dsh-im-notify] webServer route mount failed: ${error?.message ?? error}`, 'warn');
  }
  return () => {
    try { cancelInject?.(); } catch { /* already gone */ }
    try { unregister?.(); } catch { /* already gone */ }
  };
}

// ---- leg 2: connection.fetch bus (hot-reload path, kept as fallback) -------
export function installSettingsRpc(ctx, handler, { log = () => {} } = {}) {
  const stopRoute = installWebServerRoute(ctx, handler, { log });
  if (typeof ctx?.connection?.fetch?.register !== 'function') {
    log('[dsh-im-notify] Host Connection Fetch registry unavailable — webServer route only', 'warn');
    return stopRoute;
  }
  const unregister = ctx.connection.fetch.register({
    path: `/api/${RPC_KEY}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (!isLoopbackRequest(request)) return new Response('forbidden', { status: 403 });
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 });
      }
      let message;
      try {
        message = await request.json();
      } catch {
        return new Response('body is not JSON', { status: 400 });
      }
      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
      const call = message?.payload;
      if (!isRecord(message) || message.type !== 'client-request'
        || message.method !== RPC_KEY || !isRecord(call) || typeof call.method !== 'string'
        || !Object.hasOwn(call, 'payload')) {
        return reply(rpcId, { ok: false, error: { code: 'bad-request', message: 'Invalid settings request.' } });
      }
      try {
        log(`[settings-rpc] ${call.method} invoked`);
        const result = await handler(call.method, call.payload, request.signal);
        log(`[settings-rpc] ${call.method} → ${result?.ok ? 'ok' : `error:${result?.error?.code}`}`);
        return reply(rpcId, result ?? { ok: true, value: null });
      } catch (error) {
        log(`[dsh-im-notify] settings rpc ${call.method} failed: ${error?.message ?? error}`, 'warn');
        return new Response('settings handler failed', { status: 500 });
      }
    },
  });
  return () => {
    try { unregister?.(); } catch { /* already gone */ }
    stopRoute();
  };
}

export const SETTINGS_RPC_KEY = RPC_KEY;
