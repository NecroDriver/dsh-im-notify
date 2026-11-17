// Probe: run createRegistrationManager.begin() against the real Lark SDK,
// logging state transitions so we can see whether QR arrives and how fast.
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
const { createRegistrationManager } = await import('../plugin-src/host/registration.mjs');

const saved = [];
const mgr = createRegistrationManager({
  getConfig: () => ({}),
  saveCredentials: async (creds) => { saved.push(creds); console.log('[probe] credentials saved:', { ...creds, appSecret: creds.appSecret ? '***' : null }); },
  log: (msg, level) => console.log(`[probe log ${level ?? 'info'}] ${msg}`),
});

const t0 = Date.now();
const result = await mgr.begin();
console.log(`[probe] begin() returned after ${Date.now() - t0}ms:`, {
  state: result.state,
  attemptId: result.attemptId,
  hasQrDataUrl: Boolean(result.qrCodeDataUrl),
  qrCodeDataUrlLen: result.qrCodeDataUrl?.length ?? 0,
  remainingSeconds: result.remainingSeconds,
});

if (!result.qrCodeDataUrl) {
  console.log('[probe] no QR after begin — polling snapshot for 25s to watch state:');
  const stop = Date.now() + 25_000;
  while (Date.now() < stop) {
    await new Promise((r) => setTimeout(r, 2500));
    const snap = mgr.snapshot();
    console.log(`[probe +${((Date.now() - t0) / 1000).toFixed(0)}s]`, {
      state: snap.state,
      hasQrUrl: Boolean(snap.qrCodeUrl),
      error: snap.error?.message ?? null,
    });
    if (snap.state === 'succeeded' || snap.state === 'error') break;
  }
}
console.log('[probe] saved credentials count:', saved.length);
