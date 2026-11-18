// dsh-im-notify gateway — the verified Host command surface.
//
// All shapes below are copied from dsh-im 5.10.0 sources (MIT):
//   - peer:       plugin-src/host/harness-peer.mjs
//                   ctx.connection.createPeer({ principal:{kind:'owner'}, interactions:'none' })
//   - request:    plugin-src/host/modern-harness-api.mjs remoteRequest()
//                   { namespace, method, args, signal?, peer? }
//   - prompt:     src/channels/shared/harness-client.mjs:2154
//                   { sessionId, mode:'queue'|'steer', content:[{type:'text',text}], clientTimeZone? }
//   - snapshot:   modern-harness-api.mjs #sessionSnapshot()
//                   streamFirst('session','follow',{request:{address:{kind:'session',sessionId},maxMessages}})
//                   → { type:'snapshot', cursor, header:{id,cwd,origin,title?}, records:[{event}], hasMore? }
//   - workspace:  modern-harness-api.mjs #workspaceList()
//                   streamFirst('workspace','follow',{}) → { type:'baseline', value:{items:[{workspaceId,path?,sessionIds?}]} }

import { randomUUID } from 'node:crypto';

export function timeZoneName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? undefined;
  } catch {
    return undefined;
  }
}

export function createGateway(ctx, log) {
  const gateway = ctx?.typertGateway;
  if (!gateway || typeof gateway.invoke !== 'function' || typeof gateway.stream !== 'function') {
    throw new TypeError('dsh-im-notify requires ctx.typertGateway (inject list: typertGateway)');
  }
  const connection = ctx?.connection;
  let peer;
  if (typeof connection?.createPeer === 'function') {
    peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
  } else {
    log('[dsh-im-notify] ctx.connection.createPeer unavailable; invoking without an explicit peer', 'warn');
  }

  async function invoke(namespace, method, args, signal) {
    return gateway.invoke({
      namespace,
      method,
      args,
      ...(signal === undefined ? {} : { signal }),
      ...(peer === undefined ? {} : { peer }),
    });
  }

  // Read the first frame of a gateway stream, then abort — same pattern as
  // dsh-im #streamFirst (we only ever need the baseline/snapshot frame).
  async function streamFirst(namespace, method, args, signal) {
    const controller = new AbortController();
    const streamSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    let iterator;
    try {
      const source = await gateway.stream({
        namespace,
        method,
        args,
        signal: streamSignal,
        ...(peer === undefined ? {} : { peer }),
      });
      iterator = source[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done) throw new Error(`${namespace}.${method} stream ended before its baseline`);
      return first.value;
    } finally {
      controller.abort(new DOMException('Baseline received', 'AbortError'));
      await Promise.resolve(iterator?.return?.()).catch(() => undefined);
    }
  }

  return {
    async sessionSnapshot(sessionId, maxMessages = 20, signal) {
      const frame = await streamFirst('session', 'follow', {
        request: { address: { kind: 'session', sessionId }, maxMessages },
      }, signal);
      if (frame?.type !== 'snapshot' || !Number.isSafeInteger(frame.cursor)) {
        throw new Error('session.follow returned no snapshot');
      }
      return frame;
    },

    async workspaceBaseline(signal) {
      const frame = await streamFirst('workspace', 'follow', {}, signal);
      if (frame?.type !== 'baseline' || !frame.value || typeof frame.value !== 'object') {
        throw new Error('workspace.follow returned no baseline');
      }
      return frame.value;
    },

    /**
     * Submit user text into an existing session. `mode`:
     *   'queue' — idle session: resume its Agent with the persisted config
     *   'steer' — running session: inject as a steering instruction
     */
    async prompt(sessionId, text, { mode = 'queue', signal } = {}) {
      const timeZone = timeZoneName();
      return invoke('session', 'prompt', {
        request: {
          requestId: randomUUID(),
          sessionId,
          mode,
          content: [{ type: 'text', text }],
          ...(timeZone ? { clientTimeZone: timeZone } : {}),
        },
      }, signal);
    },

    /**
     * Create a session in a workspace. Shape from dsh-im createSession()
     * (src/channels/shared/harness-client.mjs): session.create {workspaceId}
     * → {sessionId}. agentPreset is deliberately omitted so the Host resolves
     * its current default preset.
     */
    async createSession(workspaceId, signal) {
      const created = await invoke('session', 'create', { workspaceId }, signal);
      if (typeof created?.sessionId !== 'string' || !created.sessionId) {
        throw new Error('session.create returned no sessionId');
      }
      return created.sessionId;
    },

    /** session.rename {sessionId, title} (dsh-im renameSession). */
    async renameSession(sessionId, title, signal) {
      return invoke('session', 'rename', { sessionId, title }, signal);
    },
  };
}
