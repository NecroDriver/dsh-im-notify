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

export function installSettingsRpc(ctx, handler, { log = () => {} } = {}) {
  if (typeof ctx?.connection?.fetch?.register !== 'function') {
    log('[dsh-im-notify] Host Connection Fetch registry unavailable — settings panel disabled', 'warn');
    return () => {};
  }
  const unregister = ctx.connection.fetch.register({
    path: `/api/${RPC_KEY}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      // DSH applies browser authentication and Host/Origin trust before this.
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
        const result = await handler(call.method, call.payload, request.signal);
        return reply(rpcId, result ?? { ok: true, value: null });
      } catch (error) {
        log(`[dsh-im-notify] settings rpc ${call.method} failed: ${error?.message ?? error}`, 'warn');
        return new Response('settings handler failed', { status: 500 });
      }
    },
  });
  return () => {
    try { unregister?.(); } catch { /* already gone */ }
  };
}

export const SETTINGS_RPC_KEY = RPC_KEY;
