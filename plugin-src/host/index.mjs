// dsh-im-notify — Feishu-only task-completion notifier for DeepSeek Harness.
//
// Pipeline (all Host primitives verified against dsh-im 5.10.0 sources):
//   ctx.on('session/event', …, { global:true })   ← every session, every event
//     filter turn/end for watched sessions → completion card → Feishu
//     card message_id → {sessionId} mapping → quote-reply routes back via
//     gateway('session','prompt') { mode:'queue'|'steer' }.
//
// Commands (chat): /help /watch /watchlist /unwatch /sessions /status
// State: <dshHome>/integrations/dsh-im-notify/{config,state}.json

import { basename, join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { StateStore, stateDirectory } from './state.mjs';
import { createGateway } from './gateway.mjs';
import { WatchEngine } from './watch-engine.mjs';
import { FeishuRuntime, buildCompletionCard, stripMentions } from './feishu.mjs';
import { RouteBack } from './route-back.mjs';
import { createRegistrationManager, maskAppId } from './registration.mjs';
import { installSettingsRpc } from './settings-rpc.mjs';

export const name = 'dsh-im-notify';

// 'connection' → createPeer (owner identity for gateway requests)
// 'typertGateway' → session.follow / session.prompt / workspace.follow
export const inject = ['connection', 'typertGateway'];

// Keep in sync with package.json version — logged to debug.log for deployment forensics.
// (smoke-settings.mjs asserts PLUGIN_VERSION === package.json version.)
export const PLUGIN_VERSION = '0.2.29';

const HELP = [
  'dsh-im-notify · 任务完成通知',
  '/watch <会话ID或序号> — 关注会话，完成后推送',
  '/watchall — 所有未关注会话完成后都推送到本聊天（/watchall off 关闭）',
  '/watchlist — 查看本聊天关注的会话',
  '/unwatch <会话ID或序号> — 取消关注',
  '/sessions — 列出最近会话（配合 /watch 序号）',
  '/status — 插件状态',
  '',
  '推送来之后：引用那条推送消息直接回复，内容会直达对应会话。',
].join('\n');

// Synchronous on purpose (production-proven by dshmarket lib/index.js:241):
// a Host plugin fiber whose apply() stays suspended for ~20s gets reclaimed
// ~25s after load (observed 2026-11-17 on v0.2.12 — two cold starts and one
// hot reload, all disposed at 25.0–25.2s, routes torn down → panel 404).
// apply() must return immediately; ALL async work (state load, first dial,
// retries) rides fire-and-forget chains off the effect factory instead.
export function apply(ctx, config = {}) {
  let debugFile = null;
  const log = (message, level = 'info') => {
    const target = ctx?.logger ?? console;
    try {
      (target[level] ?? target.log).call(target, message);
    } catch {
      console.log(message);
    }
    if (debugFile) {
      try { appendFileSync(debugFile, `${new Date().toISOString()} [${level}] ${message}\n`); } catch { /* best effort */ }
    }
  };

  const dir = stateDirectory(config);
  try { debugFile = join(dir, 'debug.log'); } catch { debugFile = null; }
  log(`[dsh-im-notify] host module loaded (version ${PLUGIN_VERSION})`);
  const state = new StateStore(dir, log);

  let gateway = null;
  let engine = null;
  let feishu = null;

  // ---- settings-panel RPC (alive even while unconfigured: QR onboarding) ----
  const registration = createRegistrationManager({
    getConfig: () => state.config,
    saveCredentials: async ({ appId, appSecret, openId, domain }) => {
      const owners = Array.isArray(state.config.ownerOpenIds) && state.config.ownerOpenIds.length > 0
        ? state.config.ownerOpenIds
        : (openId ? [openId] : []);
      state.config = { ...state.config, appId, appSecret, domain, ownerOpenIds: owners };
      await state.save();
      // Reconnect immediately with the fresh credentials (no Host restart needed).
      if (typeof attemptStart === 'function') {
        if (retryTimer) clearRetry();
        void attemptStart();
      }
    },
    log,
  });

  // Feishu connection state shared with the settings panel (idle: offline).
  const connection = { state: 'offline', error: null, attempts: 0 };
  let retryTimer = null;
  let attemptStart = null; // assigned in the configured branch below

  async function settingsStatus() {
    return {
      configured: state.configured,
      appIdMasked: state.configured ? maskAppId(state.config.appId) : null,
      domain: state.config.domain ?? 'feishu',
      watchCount: state.watches.length,
      watchAll: state.watchAll ? { enabled: true, chatId: state.watchAll.chatId, startedAt: state.watchAll.startedAt } : { enabled: false },
      mappingCount: Object.keys(state.mappings).length,
      botReady: feishu?.status?.ready === true,
      botStartedAt: feishu?.status?.startedAt ?? null,
      connection: { ...connection },
      appId: state.configured ? state.config.appId : null,
      registration: registration.snapshot(),
      watches: state.watches.map((watch) => ({
        sessionId: watch.sessionId,
        title: watch.title,
        chatId: watch.chatId,
        addedAt: watch.watchStartedAt,
        running: engine?.isRunning(watch.sessionId) === true,
      })),
    };
  }

  const stopSettingsRpc = installSettingsRpc(ctx, async (method, payload) => {
    switch (method) {
      case 'status':
        return { ok: true, value: await settingsStatus() };
      case 'registration.begin': {
        const value = await registration.begin(payload ?? {});
        return { ok: true, value };
      }
      case 'registration.poll': {
        const polled = await registration.poll(payload?.attemptId);
        if (polled?.ok === false) return polled; // {ok:false,error} passes through untouched
        const { ok: _ignored, ...value } = polled ?? {};
        return { ok: true, value };
      }
      case 'registration.cancel':
        registration.cancel(payload?.attemptId);
        return { ok: true, value: { cancelled: true } };
      case 'connection.retry':
        if (typeof attemptStart !== 'function') {
          return { ok: false, error: { code: 'bad-request', message: '尚未配置，没有可重试的连接。' } };
        }
        if (retryTimer) clearRetry();
        void attemptStart();
        return { ok: true, value: await settingsStatus() };
      case 'watch.remove':
        state.removeWatch(String(payload?.chatId ?? ''), String(payload?.sessionId ?? ''));
        return { ok: true, value: await settingsStatus() };
      case 'watch.clear':
        for (const watch of [...state.watches]) state.removeWatch(watch.chatId, watch.sessionId);
        return { ok: true, value: await settingsStatus() };
      default:
        return { ok: false, error: { code: 'bad-request', message: `Unknown method: ${method}` } };
    }
  }, { log });

  // Unified pipeline: even unconfigured we boot everything; attemptStart is a
  // no-op without credentials. That way the very first successful QR scan
  // (saveCredentials → attemptStart) brings the long connection up live,
  // with no Host restart.
  gateway = createGateway(ctx, log);
  const abort = new AbortController();
  const { signal } = abort;

  // completion push → card + mapping. Rebuilt on every (re)connect so fresh
  // credentials from re-authorization take effect without a Host restart.
  const createFeishu = () => new FeishuRuntime({
    config: state.config,
    log,
    // Inbound handling must NEVER leak a rejection to the Host process —
    // an unhandled rejection from the SDK event dispatcher is treated as a
    // FATAL load failure by dsh-desktop (host exits, crash dialog).
    onEvent: (inbound) => {
      Promise.resolve(handleInbound(inbound)).catch((error) => {
        log(`[dsh-im-notify] inbound handling error: ${error?.message ?? error}`, 'error');
      });
    },
    onReady: () => {
      void engine.compensate(signal).catch(() => undefined);
    },
  });
  feishu = createFeishu();

  engine = new WatchEngine({
    state,
    gateway,
    deliver: async ({ sessionId, title, summary, fallbackTitle, chatId, replyToMessageId, kind, startedAt, note }) => {
      // The engine harvests the final answer from the live event stream (race
      // free). The snapshot round-trip below is only a fallback for restart
      // compensation, where the stream was not observed.
      let cardTitle = title ?? fallbackTitle ?? null;
      let summaryText = summary ?? null;
      if (!summaryText || !cardTitle) {
        try {
          const snap = await gateway.sessionSnapshot(sessionId, 40, signal);
          if (!cardTitle) {
            cardTitle = (typeof snap.header?.title === 'string' && snap.header.title)
              || pickSessionLabel(snap.records)
              || null;
          }
          if (!summaryText) summaryText = pickLastAssistantSummary(snap.records, 0);
        } catch { /* keep what we have */ }
      }
      const card = buildCompletionCard({ title: cardTitle, summary: summaryText, sessionId, kind, startedAt, note });
      const messageId = await feishu.sendCompletionCard({ chatId, replyToMessageId, card });
      if (messageId) state.addMapping(messageId, sessionId, cardTitle);
    },
    log,
  });

  const routeBack = new RouteBack({ state, gateway, engine, getFeishu: () => feishu, log });

  // ---- session listing (verified surface only: workspace.follow + session.follow) ----
  const lastListings = new Map(); // chatId → { at, items: [{sessionId,title,workspace}] }

  // Spoken text only: content blocks carry {type:'text'} answers alongside
  // {type:'tool-call'}/{type:'reasoning'} siblings — the latter must be skipped.
  const extractSpokenText = (blocks) => {
    if (typeof blocks === 'string') return blocks;
    if (!Array.isArray(blocks)) return '';
    return blocks
      .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
      .trim();
  };

  // GUI list titles ("功能 | …") are client-side summaries; session headers are
  // often untitled. Fall back to the newest user message as the display label.
  // Live record shape: {type:'user/message', data:{turn,step,message:{role,content:[blocks]}}}.
  const pickSessionLabel = (records) => {
    if (!Array.isArray(records)) return null;
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i] ?? {};
      const event = record.event ?? record;
      const kind = event.type ?? record.type;
      const data = event.data ?? record.data ?? {};
      const message = data.message ?? {};
      const isUser = kind === 'user/message' || kind === 'user'
        || message.role === 'user' || data.role === 'user' || record.role === 'user';
      if (!isUser) continue;
      const text = extractSpokenText(message.content ?? data.content ?? data.text ?? record.content)
        .replace(/\s+/g, ' ').trim();
      if (text) return text.length > 36 ? `${text.slice(0, 36)}…` : text;
    }
    return null;
  };

  // Newest assistant spoken text in the snapshot = the turn's final answer.
  // Live record shape: {type:'assistant/message', data:{turn,step,message:{role,content:[blocks]}}};
  // intermediate steps only carry tool-call/reasoning blocks and are skipped by
  // extractSpokenText, so the newest match IS the final answer.
  // maxChars = 0 → no truncation (whitespace/markdown preserved for the card).
  const pickLastAssistantSummary = (records, maxChars = 0) => {
    if (!Array.isArray(records)) return null;
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i] ?? {};
      const event = record.event ?? record;
      const kind = event.type ?? record.type;
      const data = event.data ?? record.data ?? {};
      const message = data.message ?? {};
      const isAssistant = kind === 'assistant/message' || kind === 'assistant'
        || message.role === 'assistant' || data.role === 'assistant' || record.role === 'assistant';
      if (!isAssistant) continue;
      const text = extractSpokenText(message.content ?? data.content ?? data.text ?? record.content).trim();
      if (!text) continue;
      return maxChars > 0 && text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
    }
    return null;
  };

  async function listSessions(limit = 15) {
    const baseline = await gateway.workspaceBaseline(signal);
    const workspaces = Array.isArray(baseline?.items) ? baseline.items : [];
    const flat = [];
    for (const workspace of workspaces) {
      for (const sessionId of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []) {
        flat.push({ sessionId, workspace: basename(String(workspace?.path ?? workspace?.workspaceId ?? '')) });
      }
    }
    const tail = flat.slice(-limit).reverse();
    const items = [];
    for (const entry of tail) {
      let title = null;
      try {
        const snapshot = await gateway.sessionSnapshot(entry.sessionId, 6, signal);
        title = (typeof snapshot.header?.title === 'string' && snapshot.header.title)
          || pickSessionLabel(snapshot.records)
          || null;
        if (!items.length) {
          log(`session snapshot sample: header=${JSON.stringify(snapshot.header)?.slice(0, 200)} record0=${JSON.stringify(snapshot.records?.[0])?.slice(0, 300)}`);
        }
      } catch { /* keep null title */ }
      items.push({ ...entry, title });
    }
    return items;
  }

  const shortId = (sessionId) => String(sessionId).replace(/^session-/, '').slice(0, 8);

  async function resolveWatchTarget(chatId, arg) {
    const trimmed = arg.trim();
    if (/^\d+$/.test(trimmed)) {
      const listing = lastListings.get(chatId);
      const index = Number(trimmed) - 1;
      if (!listing || Date.now() - listing.at > 10 * 60 * 1000) {
        return { error: '序号已过期，请先执行 /sessions' };
      }
      if (index < 0 || index >= listing.items.length) return { error: '序号超出范围' };
      const item = listing.items[index];
      return { sessionId: item.sessionId, title: item.title };
    }
    if (trimmed.length < 4) return { error: '请提供至少 4 位会话 ID 前缀，或先 /sessions 再用序号' };
    const listing = await listSessions(30);
    const hits = listing.filter((item) => item.sessionId.startsWith(trimmed.toLowerCase()));
    if (hits.length === 0) return { error: '没有匹配的会话，试试 /sessions 查看列表' };
    if (hits.length > 1) return { error: `前缀匹配到 ${hits.length} 个会话，请提供更长前缀` };
    return { sessionId: hits[0].sessionId, title: hits[0].title };
  }

  // ---- inbound ----
  const hintCooldown = new Map(); // chatId → last hint time

  async function handleInbound(inbound) {
    if (!inbound.messageId || !inbound.chatId) return;

    // 1) quote-reply route-back first (works for owners and shared chats)
    try {
      if (await routeBack.maybeRoute(inbound)) return;
    } catch (error) {
      log(`[dsh-im-notify] route-back error: ${error?.message ?? error}`, 'warn');
    }

    const text = stripMentions(inbound.text);
    if (!text.startsWith('/')) {
      // Not a command and not a routed quote: occasional hint, never chatty.
      const last = hintCooldown.get(inbound.chatId) ?? 0;
      if (Date.now() - last > 6 * 60 * 60 * 1000 && text) {
        hintCooldown.set(inbound.chatId, Date.now());
        await feishu.replyText(inbound.messageId,
          '本机器人只做任务完成通知。发送 /help 查看用法；引用推送消息可直接向对应会话下达指令。');
      }
      return;
    }
    if (!state.isOwner(inbound.senderOpenId)) {
      log(`rejected non-owner: sender=${inbound.senderOpenId} configuredOwners=${(state.config.ownerOpenIds ?? []).join(',') || '(none)'}`, 'warn');
      await feishu.replyText(inbound.messageId, '⛔ 该机器人仅限管理员使用。');
      return;
    }

    const [command, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ');
    try {
      switch (command) {
        case '/help':
          await feishu.replyText(inbound.messageId, HELP);
          return;

        case '/sessions': {
          const items = await listSessions(15);
          lastListings.set(inbound.chatId, { at: Date.now(), items });
          if (items.length === 0) {
            await feishu.replyText(inbound.messageId, '当前没有可列出的会话。');
            return;
          }
          const lines = items.map((item, index) =>
            `${index + 1}. ${item.title ?? '（无内容）'} · ${item.workspace} · id:${shortId(item.sessionId)}`);
          await feishu.replyText(inbound.messageId,
            ['最近会话（/watch 序号 即可关注）：', ...lines].join('\n'));
          return;
        }

        case '/watch': {
          if (!arg) {
            await feishu.replyText(inbound.messageId, '用法：/watch <会话ID前缀 或 /sessions 序号>');
            return;
          }
          const resolved = await resolveWatchTarget(inbound.chatId, arg);
          if (resolved.error) {
            await feishu.replyText(inbound.messageId, `❌ ${resolved.error}`);
            return;
          }
          // Baseline the cursor so we never push historical turns.
          const snapshot = await gateway.sessionSnapshot(resolved.sessionId, 1, signal);
          state.addWatch({
            chatId: inbound.chatId,
            sessionId: resolved.sessionId,
            title: resolved.title,
            lastSeq: snapshot.cursor,
            replyToMessageId: inbound.messageId,
            watchStartedAt: new Date().toISOString(),
          });
          await feishu.replyText(inbound.messageId,
            `⭐ 已关注「${resolved.title ?? resolved.sessionId.slice(0, 8)}」。任务完成后会以回复本条消息的形式推送；引用推送可直接向该会话下达指令。`);
          return;
        }

        case '/watchall': {
          if (arg.trim().toLowerCase() === 'off') {
            if (!state.watchAll) {
              await feishu.replyText(inbound.messageId, '全量推送本来就没开启。');
              return;
            }
            state.setWatchAll(null);
            await feishu.replyText(inbound.messageId, '已关闭全量推送。之后只有 /watch 关注的会话会推送。');
            return;
          }
          state.setWatchAll({
            chatId: inbound.chatId,
            replyToMessageId: inbound.messageId,
            startedAt: new Date().toISOString(),
          });
          await feishu.replyText(inbound.messageId,
            '🔔 已开启全量推送：所有未被 /watch 关注的会话完成后都会推送到本聊天。'
            + '一旦 /watch 关注了某个会话，它只推给关注目标。/watchall off 关闭。');
          return;
        }

        case '/unwatch': {
          const watches = state.watchesIn(inbound.chatId);
          if (!arg) {
            await feishu.replyText(inbound.messageId, '用法：/unwatch <会话ID前缀 或 watchlist 序号>');
            return;
          }
          const index = /^\d+$/.test(arg) ? Number(arg) - 1 : -1;
          const target = index >= 0 ? watches[index] : undefined;
          if (target) {
            state.removeWatch(inbound.chatId, target.sessionId);
            await feishu.replyText(inbound.messageId, `已取消关注「${target.title ?? target.sessionId.slice(0, 8)}」。`);
            return;
          }
          const hits = watches.filter((watch) => watch.sessionId.startsWith(arg.toLowerCase()));
          if (hits.length === 1) {
            state.removeWatch(inbound.chatId, hits[0].sessionId);
            await feishu.replyText(inbound.messageId, `已取消关注「${hits[0].title ?? hits[0].sessionId.slice(0, 8)}」。`);
          } else {
            await feishu.replyText(inbound.messageId, hits.length === 0 ? '没有匹配的关注项。' : `匹配到 ${hits.length} 个，请提供更长前缀。`);
          }
          return;
        }

        case '/watchlist': {
          const watches = state.watchesIn(inbound.chatId);
          const all = state.watchAll && state.watchAll.chatId === inbound.chatId ? state.watchAll : null;
          const lines = watches.map((watch, index) =>
            `${index + 1}. ${watch.title ?? watch.sessionId.slice(0, 8)} · ${watch.sessionId.slice(0, 8)}…${engine.isRunning(watch.sessionId) ? ' · 🏃 运行中' : ''}`);
          const head = [
            `全量推送：${all ? `✅ 已开启（未关注的会话完成后也推送到本聊天）${state.watches.length > 0 ? '，另有 ' + state.watches.length + ' 个显式关注' : ''}` : '未开启'}`,
            ...(watches.length > 0 ? ['关注的会话：'] : ['本聊天没有显式关注的会话。']),
          ];
          await feishu.replyText(inbound.messageId, [...head, ...lines].join('\n'));
          return;
        }

        case '/status': {
          const status = feishu.status;
          await feishu.replyText(inbound.messageId, [
            'dsh-im-notify 状态',
            `连接：${status.ready ? '✅ 飞书长连接正常' : `⚠️ ${status.lastError ?? '未连接'}`}`,
            `启动：${status.startedAt ?? '-'} · 收消息 ${status.messagesReceived} · 发卡片 ${status.cardsSent}`,
            `关注：${state.watches.length} 个 · 全量推送：${state.watchAll ? '✅ 开' : '关'} · 回程映射：${Object.keys(state.mappings).length} 条`,
          ].join('\n'));
          return;
        }

        default:
          await feishu.replyText(inbound.messageId, `未知命令 ${command}。/help 查看用法。`);
      }
    } catch (error) {
      log(`[dsh-im-notify] command ${command} failed: ${error?.message ?? error}`, 'warn');
      try {
        await feishu.replyText(inbound.messageId, `❌ 命令执行失败：${error?.message ?? error}`);
      } catch { /* reply itself failed */ }
    }
  }

  // ---- start ----
  engine.start(ctx);
  // Feishu WS handshake failing must NEVER blow up the whole plugin (it used to
  // throw → apply rejected → settings RPC unregistered → panel 404). Degrade
  // instead: keep engine + settings alive, retry with backoff, panel shows state.
  //
  // Lifecycle (proven 2026-11-17, see the sync-apply note above): apply() must
  // return immediately, so the state load AND the first dial both run on a
  // fire-and-forget chain — same shape as dshmarket's repairTimer chain, which
  // survives on this Host in production. Retries go through the host `timer`
  // service first (callbacks run in the host context).
  const hostTimer = (() => { try { return ctx.get?.('timer'); } catch { return undefined; } })();
  const scheduleRetry = (delay) => {
    if (retryTimer) { clearRetry(); }
    try {
      if (typeof hostTimer?.timeout === 'function') {
        log(`[dsh-im-notify] retry scheduled in ${delay}ms (host timer service)`);
        retryTimer = hostTimer.timeout(() => { retryTimer = null; void attemptStart(); }, delay);
        return;
      }
    } catch { /* fall through to global timer */ }
    log(`[dsh-im-notify] retry scheduled in ${delay}ms (global timer)`);
    retryTimer = setTimeout(() => { retryTimer = null; void attemptStart(); }, delay);
  };
  const clearRetry = () => {
    try {
      if (retryTimer && typeof retryTimer === 'object' && typeof retryTimer.dispose === 'function') retryTimer.dispose();
      else clearTimeout(retryTimer);
    } catch { /* best effort */ }
    retryTimer = null;
  };
  attemptStart = async () => {
    if (signal.aborted) { log('[dsh-im-notify] attemptStart skipped: aborted'); return; }
    log(`[dsh-im-notify] attemptStart: configured=${state.configured} appId=${state.config.appId ? 'present' : 'missing'}`);
    if (!state.configured) { connection.state = 'offline'; return; } // nothing to dial yet
    connection.state = connection.attempts === 0 ? 'connecting' : 'retrying';
    log(`[dsh-im-notify] dialing feishu (${connection.state}, attempt ${connection.attempts + 1})…`);
    try {
      feishu.stop();
      feishu = createFeishu(); // pick up fresh credentials after re-authorization
      await feishu.start(signal);
      connection.state = 'online';
      connection.error = null;
      connection.attempts = 0;
      log('[dsh-im-notify] started — feishu long connection ready');
    } catch (error) {
      if (signal.aborted) return;
      connection.attempts += 1;
      connection.state = 'failed';
      connection.error = error?.message ?? String(error);
      log(`[dsh-im-notify] feishu start failed (attempt ${connection.attempts}): ${connection.error}`, 'error');
      scheduleRetry(Math.min(60_000, 5_000 * 2 ** (connection.attempts - 1)));
    }
  };
  // Bootstrap off the apply chain: load persisted state, then first dial.
  // Fire-and-forget on purpose — apply() must stay synchronous (see header).
  void (async () => {
    try {
      await state.load(config);
      if (!state.configured) {
        log(`[dsh-im-notify] no credentials found at ${dir}/config.json — idle, settings panel offers QR onboarding`, 'warn');
        return;
      }
      await attemptStart();
    } catch (error) {
      log(`[dsh-im-notify] bootstrap failed: ${error?.message ?? error}`, 'error');
    }
  })();

  const dispose = () => {
    log('[dsh-im-notify] dispose invoked — stopping runtime', 'warn');
    if (retryTimer) clearRetry();
    abort.abort(new DOMException('dsh-im-notify disposed', 'AbortError'));
    registration.cancel();
    stopSettingsRpc();
    engine.stop();
    feishu.stop();
  };
  // ctx.effect takes a FACTORY: running it mounts, its RETURN value cleans up
  // (dshmarket lib/index.js:315 production pattern). Passing `dispose` directly
  // made cordis "mount" it on registration — dispose ran 3ms into apply,
  // aborting the signal and tearing the settings route down (v0.2.13/0.2.14
  // forensics). So: no mount work here, just hand back the real disposer.
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => dispose, 'dsh-im-notify: runtime');
  }
}
