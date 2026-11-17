// dsh-im-notify — client settings panel (settings.section slot).
//
// Two views driven by host RPC over ctx.connection.rpc.call('/api', 'dsh-im-notify'):
//   unconfigured → QR onboarding (registration.begin → poll → succeeded)
//   configured   → status overview + watch list management
//
// React comes from the DSH web shell (esbuild external, CJS require).

import * as React from 'react';

export const name = 'dsh-im-notify-settings';
export const inject = ['slots', 'connection'];

const h = React.createElement;

function installStyles() {
  const STYLE_ID = 'dsh-im-notify-styles';
  if (document.getElementById(STYLE_ID)) return () => {};
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    '.din-wrap{display:flex;flex-direction:column;gap:16px;max-width:560px;font-size:14px;line-height:1.6;}',
    '.din-card{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:10px;padding:16px 18px;}',
    '.din-cardTitle{font-weight:600;margin:0 0 8px;}',
    '.din-muted{opacity:.7;}',
    '.din-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
    '.din-row+.din-row{margin-top:10px;}',
    '.din-spacer{flex:1;}',
    '.din-btn{cursor:pointer;border:1px solid color-mix(in srgb,currentColor 25%,transparent);background:transparent;color:inherit;border-radius:7px;padding:6px 14px;font-size:13px;}',
    '.din-btn:hover:not(:disabled){border-color:currentColor;}',
    '.din-btn:disabled{opacity:.45;cursor:default;}',
    '.din-btnPrimary{border-color:transparent;background:#3370ff;color:#fff;}',
    '.din-btnPrimary:hover:not(:disabled){background:#2861dd;color:#fff;}',
    '.din-btnDanger:hover:not(:disabled){border-color:#e5484d;color:#e5484d;}',
    '.din-qrBox{display:flex;flex-direction:column;align-items:center;gap:12px;padding:8px 0;}',
    '.din-qrImg{width:240px;height:240px;border-radius:8px;background:#fff;padding:10px;box-sizing:border-box;}',
    '.din-qrImgExpired{filter:grayscale(1) blur(2px);opacity:.4;}',
    '.din-qrOverlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:600;}',
    '.din-qrFrame{position:relative;}',
    '.din-link{color:inherit;text-decoration:underline;text-underline-offset:3px;opacity:.85;}',
    '.din-list{display:flex;flex-direction:column;gap:8px;margin-top:8px;}',
    '.din-item{display:flex;align-items:center;gap:10px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:8px;padding:8px 12px;}',
    '.din-itemMain{display:flex;flex-direction:column;min-width:0;flex:1;}',
    '.din-itemTitle{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.din-badge{font-size:11px;border:1px solid color-mix(in srgb,currentColor 30%,transparent);border-radius:99px;padding:1px 8px;opacity:.8;}',
    '.din-badgeRun{border-color:#46a758;color:#46a758;opacity:1;}',
    '.din-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#46a758;margin-right:6px;}',
    '.din-dotOff{background:#f5a524;}',
    '.din-ok{color:#46a758;font-weight:600;}',
    '.din-err{color:#e5484d;}',
    '.din-code{font-family:ui-monospace,monospace;font-size:12px;opacity:.85;}',
  ].join('');
  document.head.appendChild(style);
  return () => style.remove();
}

function fmtDate(value) {
  if (!value) return '-';
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
}

// ---------- unconfigured: QR onboarding ----------

function SetupView({ call, onConfigured, repairAppId = null, flowTitle = '扫码接入飞书', onExit = null }) {
  const [flow, setFlow] = React.useState(null);
  // flow: null | {phase:'starting'} | {phase:'qr', attemptId, qrCodeDataUrl?, verificationUrl?, remainingSeconds}
  //      | {phase:'succeeded', appIdMasked} | {phase:'error', message}
  const [busy, setBusy] = React.useState(false);

  const begin = React.useCallback(async () => {
    setBusy(true);
    try {
      const result = await call('registration.begin', repairAppId ? { appId: repairAppId } : {});
      if (result?.ok) {
        const value = result.value ?? {};
        setFlow({ phase: 'qr', ...value, remainingSeconds: value.remainingSeconds ?? 600 });
      } else {
        setFlow({ phase: 'error', message: result?.error?.message ?? '无法发起扫码接入。' });
      }
    } catch (error) {
      setFlow({ phase: 'error', message: error?.message ?? String(error) });
    } finally {
      setBusy(false);
    }
  }, [call, repairAppId]);

  // poll loop while a QR attempt is live
  React.useEffect(() => {
    if (flow?.phase !== 'qr') return undefined;
    const { attemptId } = flow;
    let failures = 0;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const result = await call('registration.poll', { attemptId });
        failures = 0;
        if (stopped) return;
        if (result?.ok !== true) {
          setFlow({ phase: 'error', message: result?.error?.message ?? '扫码会话已失效。' });
          return;
        }
        const value = result.value ?? {};
        if (value.state === 'succeeded') {
          setFlow({ phase: 'succeeded', appIdMasked: value.appIdMasked });
          onConfigured?.();
          return;
        }
        if (value.state === 'expired' || value.state === 'cancelled') {
          setFlow({ phase: 'error', message: value.state === 'expired' ? '二维码已过期，可重新发起。' : '扫码已取消。' });
          return;
        }
        if (value.state === 'error') {
          setFlow({ phase: 'error', message: value.error?.message ?? '注册过程出错。' });
          return;
        }
        setFlow((current) => (current?.phase === 'qr' && current.attemptId === attemptId
          ? { ...current, qrCodeDataUrl: value.qrCodeDataUrl ?? current.qrCodeDataUrl,
              verificationUrl: value.verificationUrl ?? current.verificationUrl,
              remainingSeconds: value.remainingSeconds ?? current.remainingSeconds }
          : current));
      } catch {
        failures += 1;
        if (failures >= 2 && !stopped) {
          setFlow({ phase: 'error', message: '与 Host 的连接中断，请重试。' });
        }
      }
    }, Math.max(1200, Math.min(5000, flow.pollIntervalMs ?? 2000)));
    return () => {
      stopped = true;
      clearInterval(timer);
      call('registration.cancel', { attemptId }).catch(() => {});
    };
  }, [flow?.phase, flow?.attemptId, call]); // eslint-disable-line react-hooks/exhaustive-deps

  if (flow?.phase === 'succeeded') {
    return h('div', { className: 'din-wrap' },
      h('div', { className: 'din-card' },
        h('p', { className: 'din-cardTitle' }, h('span', { className: 'din-ok' }, '✅ 接入完成')),
        h('p', null, '飞书自建应用已创建并保存凭据',
          flow.appIdMasked ? h('span', null, '（', h('span', { className: 'din-code' }, flow.appIdMasked), '）') : null, '。'),
        h('p', { className: 'din-muted' }, repairAppId
          ? '插件将使用更新后的凭据；若长连接未自动恢复，请重启 DeepSeek Harness。'
          : '重启 DeepSeek Harness 后插件即可开始工作；之后在飞书里对机器人发 ', repairAppId ? null : h('span', { className: 'din-code' }, '/help'), repairAppId ? null : ' 查看用法。'),
        onExit
          ? h('div', { className: 'din-row' }, h('span', { className: 'din-spacer' }),
              h('button', { type: 'button', className: 'din-btn', onClick: onExit }, '返回'))
          : null));
  }

  if (flow?.phase === 'qr') {
    const expired = (flow.remainingSeconds ?? 0) <= 0;
    return h('div', { className: 'din-wrap' },
      h('div', { className: 'din-card' },
        h('p', { className: 'din-cardTitle' }, flowTitle),
        h('div', { className: 'din-qrBox' },
          h('div', { className: 'din-qrFrame' },
            flow.qrCodeDataUrl
              ? h('img', {
                  className: `din-qrImg${expired ? ' din-qrImgExpired' : ''}`,
                  src: flow.qrCodeDataUrl,
                  alt: '飞书应用授权二维码',
                })
              : h('div', { className: 'din-qrImg din-muted', role: 'status' }, '二维码生成中…'),
            expired ? h('div', { className: 'din-qrOverlay', role: 'status' }, '已过期') : null),
          h('div', { className: 'din-muted' },
            '用飞书扫码并在确认页点击允许', expired ? null : `（剩余 ${Math.floor((flow.remainingSeconds ?? 0) / 60)}:${String((flow.remainingSeconds ?? 0) % 60).padStart(2, '0')}）`),
          flow.verificationUrl
            ? h('a', { className: 'din-link', href: flow.verificationUrl, target: '_blank', rel: 'noopener noreferrer' }, '无法扫码？打开授权链接')
            : null),
        h('div', { className: 'din-row' },
          onExit
            ? h('button', {
                type: 'button', className: 'din-btn', disabled: busy,
                onClick: () => { call('registration.cancel', { attemptId: flow.attemptId }).catch(() => {}); onExit(); },
              }, '← 返回')
            : h('span', { className: 'din-spacer' }),
          h('button', {
            type: 'button', className: 'din-btn', disabled: busy,
            onClick: () => { call('registration.cancel', { attemptId: flow.attemptId }).catch(() => {}); setFlow(null); },
          }, '取消'))));
  }

  return h('div', { className: 'din-wrap' },
    flow?.phase === 'error'
      ? h('div', { className: 'din-card' }, h('p', { className: 'din-err' }, `⚠️ ${flow.message}`))
      : null,
    h('div', { className: 'din-card' },
      h('p', { className: 'din-cardTitle' }, repairAppId ? flowTitle : '尚未接入'),
      h('p', { className: 'din-muted' },
        repairAppId
          ? '重新走一遍扫码授权（补权限 / 更新凭据），完成后自动保存到本机。'
          : '扫码即可创建飞书自建应用并自动配置权限（读取消息 + 发送通知）。任务完成时推送卡片到飞书，引用推送可直接向对应会话下达指令。'),
      h('div', { className: 'din-row' },
        onExit
          ? h('button', { type: 'button', className: 'din-btn', disabled: busy, onClick: onExit }, '← 返回')
          : null,
        h('button', {
          type: 'button', className: 'din-btn din-btnPrimary', disabled: busy,
          onClick: begin,
        }, busy ? '正在发起…' : repairAppId ? '重新扫码授权' : '扫码接入飞书'))));
}

// ---------- configured: overview + watch management ----------

function ConfiguredView({ call, status, setStatus, onCredentialsFlow }) {
  const [busyKey, setBusyKey] = React.useState(null);

  const run = async (key, method, payload) => {
    setBusyKey(key);
    try {
      const result = await call(method, payload);
      if (result?.ok) setStatus(result.value);
    } finally {
      setBusyKey(null);
    }
  };

  const conn = status.connection ?? {};
  const connState = conn.state ?? (status.botReady ? 'online' : 'offline');
  const connLabel = connState === 'online' ? '长连接正常'
    : connState === 'connecting' ? '连接中…'
    : connState === 'retrying' ? `重试中（第 ${conn.attempts ?? '?'} 次）…`
    : connState === 'failed' ? '连接失败'
    : '未连接（重启 Host 后生效）';

  return h('div', { className: 'din-wrap' },
    h('div', { className: 'din-card' },
      h('p', { className: 'din-cardTitle' }, '飞书通知'),
      h('div', { className: 'din-row' },
        h('span', null,
          h('span', { className: connState === 'online' ? 'din-dot' : 'din-dot din-dotOff' }),
          connLabel),
        h('span', { className: 'din-badge' }, `应用 ${status.appIdMasked ?? '-'}`),
        status.domain === 'lark' ? h('span', { className: 'din-badge' }, 'Lark 国际版') : null),
      connState === 'failed' || connState === 'retrying'
        ? h('p', { className: 'din-err', style: { marginTop: 8 } },
            `⚠️ ${conn.error ?? '飞书长连接未建立'}`,
            h('div', { className: 'din-row', style: { marginTop: 6 } },
              h('button', {
                type: 'button', className: 'din-btn', disabled: busyKey === 'retry',
                onClick: () => run('retry', 'connection.retry', {}),
              }, '立即重试连接')))
        : null,
      h('div', { className: 'din-row din-muted' },
        h('span', null, `关注 ${status.watchCount} 个会话 · 回程映射 ${status.mappingCount} 条`))),
    h('div', { className: 'din-card' },
      h('div', { className: 'din-row' },
        h('p', { className: 'din-cardTitle', style: { margin: 0, flex: 1 } }, '关注的会话'),
        status.watchCount > 0
          ? h('button', {
              type: 'button', className: 'din-btn din-btnDanger', disabled: busyKey === 'clear',
              onClick: () => run('clear', 'watch.clear', {}),
            }, '清空')
          : null),
      status.watches.length === 0
        ? h('p', { className: 'din-muted' }, '还没有关注任何会话。在飞书里发 /sessions 查看列表，/watch 序号 关注。')
        : h('div', { className: 'din-list' }, status.watches.map((watch) => h('div', { key: `${watch.chatId}/${watch.sessionId}`, className: 'din-item' },
            h('div', { className: 'din-itemMain' },
              h('span', { className: 'din-itemTitle' }, watch.title ?? '（无标题会话）'),
              h('span', { className: 'din-muted din-code' },
                `${watch.sessionId.slice(0, 10)}… · 添加于 ${fmtDate(watch.addedAt)}`)),
            watch.running ? h('span', { className: 'din-badge din-badgeRun' }, '🏃 运行中') : null,
            h('button', {
              type: 'button', className: 'din-btn',
              disabled: busyKey === `rm:${watch.sessionId}`,
              onClick: () => run(`rm:${watch.sessionId}`, 'watch.remove', { chatId: watch.chatId, sessionId: watch.sessionId }),
            }, '移除')))),
      h('div', { className: 'din-row', style: { marginTop: 16 } },
        h('button', {
          type: 'button', className: 'din-btn',
          onClick: () => onCredentialsFlow?.('repair'),
        }, '重新授权'),
        h('button', {
          type: 'button', className: 'din-btn',
          onClick: () => onCredentialsFlow?.('replace'),
        }, '更换新应用'),
        h('span', { className: 'din-muted' }, '更换凭据无需命令行'))));
}

// ---------- panel root ----------

function NotifyPanel({ call }) {
  const [status, setStatus] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [flowMode, setFlowMode] = React.useState(null); // 'repair' | 'replace' | null

  React.useEffect(() => {
    let disposed = false;
    call('status', {}).then((result) => {
      if (disposed) return;
      if (result?.ok) setStatus(result.value);
      else setError(result?.error?.message ?? '读取状态失败。');
    }).catch((cause) => { if (!disposed) setError(cause?.message ?? String(cause)); });
    return () => { disposed = true; };
  }, [call]);

  if (error) {
    return h('div', { className: 'din-wrap' },
      h('div', { className: 'din-card' }, h('p', { className: 'din-err' }, `⚠️ ${error}`),
        h('p', { className: 'din-muted' }, '请确认 dsh-im-notify 插件已启用并随 Host 一起重启。')));
  }
  if (!status) {
    return h('div', { className: 'din-wrap' }, h('div', { className: 'din-card din-muted' }, '加载中…'));
  }
  if (status.configured && flowMode) {
    return h(CredentialsFlow, {
      call, status, mode: flowMode,
      onExit: () => setFlowMode(null),
      onConfigured: () => {
        setFlowMode(null);
        call('status', {}).then((r) => { if (r?.ok) setStatus(r.value); }).catch(() => {});
      },
    });
  }
  return status.configured
    ? h(ConfiguredView, {
        call, status, setStatus,
        onCredentialsFlow: (mode) => setFlowMode(mode), // 'repair' | 'replace'
      })
    : h(SetupView, {
        call,
        onConfigured: () => { call('status', {}).then((r) => { if (r?.ok) setStatus(r.value); }).catch(() => {}); },
      });
}
// wrapper for credential flows launched from the configured view
function CredentialsFlow({ call, status, mode, onExit, onConfigured }) {
  return h(SetupView, {
    call,
    repairAppId: mode === 'repair' ? status.appId : null,
    flowTitle: mode === 'repair' ? '重新授权当前应用' : '更换新应用',
    onExit,
    onConfigured,
  });
}

export function apply(ctx) {
  const call = (method, payload, signal) =>
    ctx.connection.rpc.call('/api', 'dsh-im-notify', { method, payload }, signal);

  ctx.effect(() => installStyles(), 'dsh-im-notify: settings styles');
  ctx.effect(() => ctx.slots.inject('settings.section', () => {
    const unregister = ctx.slots.register({
      name: 'settings.section',
      id: 'dsh-im-notify',
      order: 22,
      label: 'IM 通知',
    }, () => h(NotifyPanel, { call }));
    return () => unregister();
  }), 'dsh-im-notify: settings panel');
}
