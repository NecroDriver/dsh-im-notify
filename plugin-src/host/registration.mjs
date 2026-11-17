// dsh-im-notify — in-app QR registration (Feishu one-scan provisioning).
//
// Simplified port of dsh-im's RegistrationManager idea: one live attempt at a
// time, credentials never leave the host (only via saveCredentials callback),
// status() is a poll-friendly snapshot for the settings panel.
//
// Underlying flow = official SDK device-authorization grant:
//   Lark.registerApp({... signal, onQRCodeReady, onStatusChange })
//     → QR url → user scans + confirms → resolves {client_id, client_secret, user_info}

import * as Lark from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';

const QR_TTL_MS = 10 * 60 * 1000; // SDK default expires_in=600s

const ADDONS = {
  preset: false,
  scopes: {
    tenant: [
      'im:message.p2p_msg:readonly',
      'im:message.group_at_msg:readonly',
      'im:message:send_as_bot',
    ],
  },
  events: {
    items: {
      tenant: ['im.message.receive_v1'],
    },
  },
};

const APP_PRESET = {
  name: 'DSH Notify',
  description: 'DeepSeek Harness 任务完成通知：/watch 关注会话，完成后推送到飞书，引用推送即可向会话下达指令。',
};

async function encodeQr(url) {
  return QRCode.toDataURL(url, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
    type: 'image/png',
  });
}

export function maskAppId(appId) {
  if (typeof appId !== 'string' || appId.length < 8) return appId ?? null;
  return `${appId.slice(0, 6)}…${appId.slice(-4)}`;
}

export function createRegistrationManager({
  getConfig,
  saveCredentials,
  log = () => {},
  registerApp: registerAppOverride,
}) {
  const callRegisterApp = typeof registerAppOverride === 'function'
    ? registerAppOverride
    : (options) => Lark.registerApp(options);
  let attempt = 0;
  let current = null; // { id, controller, state, qrCodeUrl, startedAt, expiresAt, pollIntervalMs, error, domainSwitched }
  const qrCache = new Map();

  async function cachedQr(url) {
    if (!url) return undefined;
    let encoded = qrCache.get(url);
    if (!encoded) {
      encoded = encodeQr(url).catch((error) => {
        if (qrCache.get(url) === encoded) qrCache.delete(url);
        throw error;
      });
      qrCache.set(url, encoded);
      if (qrCache.size >= 16) qrCache.delete(qrCache.keys().next().value);
    }
    return encoded;
  }

  function snapshot() {
    if (!current) return { state: 'idle', attemptId: null };
    const { id, state, qrCodeUrl, expiresAt, pollIntervalMs, error } = current;
    return {
      state,
      attemptId: String(id),
      ...(qrCodeUrl ? { qrCodeUrl } : {}),
      expiresAt,
      pollIntervalMs: pollIntervalMs ?? 1800,
      remainingSeconds: expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 1000)) : undefined,
      ...(error ? { error } : {}),
    };
  }

  // options.appId → repair/re-authorize an existing app (SDK clientID flow);
  // omitted → createOnly brand-new app.
  async function begin(options = {}) {
    log(`[registration] begin called${options?.appId ? ` (repair appId=${options.appId})` : ' (create new)'}`);
    // supersede any previous attempt
    cancel(String(attempt));
    attempt += 1;
    const id = attempt;
    const controller = new AbortController();
    const config = getConfig() ?? {};
    const entry = {
      id,
      controller,
      state: 'starting',
      qrCodeUrl: null,
      startedAt: Date.now(),
      expiresAt: Date.now() + QR_TTL_MS,
      pollIntervalMs: 5000,
      error: null,
      domainSwitched: false,
    };
    current = entry;

    const finish = (state, error = null) => {
      if (current !== entry) return;
      entry.state = state;
      if (error) entry.error = { code: state, message: String(error?.message ?? error) };
    };

    const expiry = setTimeout(() => {
      if (current === entry && !['succeeded', 'error', 'cancelled'].includes(entry.state)) {
        controller.abort(new DOMException('QR expired', 'AbortError'));
        finish('expired');
      }
    }, QR_TTL_MS);
    const clearExpiry = () => clearTimeout(expiry);

    // Fire-and-forget: the panel polls status() instead of awaiting this.
    void (async () => {
      try {
        log('[registration] calling Lark.registerApp…');
        const result = await callRegisterApp({
          ...(config.domain === 'lark' ? { domain: 'accounts.larksuite.com' } : {}),
          source: 'dsh-im-notify',
          // repair mode passes the existing appId (SDK sends it as clientID);
          // create mode asks the landing page to create a fresh app.
          ...(options?.appId ? { appId: String(options.appId) } : { createOnly: true }),
          appPreset: APP_PRESET,
          addons: ADDONS,
          signal: controller.signal,
          onQRCodeReady: (qr) => {
            // SDK 1.45+ passes { url, expireIn }; accept the legacy bare-string form too.
            const url = typeof qr === 'string' ? qr : qr?.url;
            log(`[registration] onQRCodeReady payload=${typeof qr}${qr && typeof qr === 'object' ? ` keys={${Object.keys(qr).join(',')}}` : ''} url.length=${url ? String(url).length : 'n/a'}`);
            if (current !== entry || typeof url !== 'string' || url === '') return;
            entry.qrCodeUrl = url;
            const expireIn = typeof qr?.expireIn === 'number' && qr.expireIn > 0 ? qr.expireIn : null;
            if (expireIn) entry.expiresAt = Date.now() + expireIn * 1000;
            if (entry.state === 'starting') entry.state = 'qr_ready';
          },
          onStatusChange: (change) => {
            const status = typeof change === 'string' ? change : change?.status;
            log(`[registration] onStatusChange status=${status}`);
            if (current !== entry) return;
            if (status === 'domain_switched') entry.domainSwitched = true;
            if (status === 'polling' && entry.state === 'starting' && entry.qrCodeUrl) entry.state = 'qr_ready';
          },
        });
        if (current !== entry) return; // superseded mid-flight
        entry.state = 'saving';
        await saveCredentials({
          appId: result?.client_id,
          appSecret: result?.client_secret,
          openId: result?.user_info?.open_id,
          domain: entry.domainSwitched || config.domain === 'lark' ? 'lark' : (config.domain ?? 'feishu'),
        });
        entry.state = 'succeeded';
        entry.qrCodeUrl = null; // stop shipping the QR once used
        log('[dsh-im-notify] QR registration succeeded — credentials saved, Host restart required');
      } catch (error) {
        if (controller.signal.aborted) {
          if (current === entry && entry.state !== 'expired') finish('cancelled');
        } else {
          const code = error?.failure?.code ?? error?.code;
          finish('error', code === 'access_denied'
            ? new Error('用户在飞书侧拒绝了授权')
            : code === 'expired_token' ? new Error('二维码已过期，请重新发起') : error);
          log(`[dsh-im-notify] QR registration failed: ${error?.message ?? error}`, 'warn');
        }
      } finally {
        clearExpiry();
      }
    })();

    // Wait briefly for the QR so `begin` usually returns a drawable panel state.
    const deadline = Date.now() + 20_000;
    while (current === entry && !entry.qrCodeUrl && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const snap = snapshot();
    const dataUrl = snap.qrCodeUrl ? await cachedQr(snap.qrCodeUrl) : undefined;
    log(`[registration] begin returning state=${snap.state} qrUrl=${snap.qrCodeUrl ? 'yes' : 'no'} dataUrl=${dataUrl ? dataUrl.length + 'ch' : 'none'} waitedMs=${Date.now() - entry.startedAt}`);
    return {
      ...snap,
      ...(dataUrl ? { qrCodeDataUrl: dataUrl } : {}),
    };
  }

  async function poll(attemptId) {
    if (!current || String(current.id) !== String(attemptId)) {
      log(`[registration] poll STALE attemptId=${attemptId} current=${current ? current.id : 'null'}`);
      return { ok: false, error: { code: 'stale-attempt', message: '该扫码会话已结束，请重新发起。' } };
    }
    const snap = snapshot();
    return {
      ok: true,
      ...snap,
      ...(snap.state === 'succeeded' ? { appIdMasked: maskAppId(getConfig()?.appId) } : {}),
      ...(snap.qrCodeUrl ? { qrCodeDataUrl: await cachedQr(snap.qrCodeUrl) } : {}),
    };
  }

  function cancel(attemptId) {
    if (!current) return false;
    if (attemptId != null && String(current.id) !== String(attemptId)) return false;
    if (!['succeeded', 'error', 'cancelled', 'expired'].includes(current.state)) {
      current.state = 'cancelled';
      current.controller.abort(new DOMException('cancelled', 'AbortError'));
    }
    current = null;
    return true;
  }

  return {
    begin,
    poll,
    cancel,
    snapshot,
    get activeAttemptId() { return current ? String(current.id) : null; },
  };
}
