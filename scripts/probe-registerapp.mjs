// Probe 2: call Lark.registerApp directly with verbose callbacks.
const signal = AbortSignal.timeout(30_000);
const t0 = Date.now();
const Lark = await import('@larksuiteoapi/node-sdk');
console.log('[sdk] registerApp type:', typeof Lark.registerApp);
try {
  const result = await Lark.registerApp({
    source: 'dsh-im-notify',
    createOnly: true,
    appPreset: { name: 'DSH Notify', desc: 'Task completion notifications for DeepSeek Harness' },
    addons: {
      preset: false,
      scopes: { tenant: ['im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly', 'im:message:send_as_bot'] },
      events: { items: { tenant: ['im.message.receive_v1'] } },
    },
    signal,
    onQRCodeReady: (url) => console.log(`[sdk +${Date.now() - t0}ms] onQRCodeReady:`, String(url).slice(0, 90)),
    onStatusChange: (s) => console.log(`[sdk +${Date.now() - t0}ms] onStatusChange:`, s),
  });
  console.log(`[sdk +${Date.now() - t0}ms] resolved:`, { client_id: result?.client_id, hasSecret: Boolean(result?.client_secret) });
} catch (error) {
  console.log(`[sdk +${Date.now() - t0}ms] rejected:`, error?.message ?? error, error?.failure ?? '');
}
