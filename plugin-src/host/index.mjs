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

import { basename } from 'node:path';
import { StateStore, stateDirectory } from './state.mjs';
import { createGateway } from './gateway.mjs';
import { WatchEngine } from './watch-engine.mjs';
import { FeishuRuntime, buildCompletionCard, stripMentions } from './feishu.mjs';
import { RouteBack } from './route-back.mjs';

export const name = 'dsh-im-notify';

// 'connection' → createPeer (owner identity for gateway requests)
// 'typertGateway' → session.follow / session.prompt / workspace.follow
export const inject = ['connection', 'typertGateway'];

const HELP = [
  'dsh-im-notify · 任务完成通知',
  '/watch <会话ID或序号> — 关注会话，完成后推送',
  '/watchlist — 查看本聊天关注的会话',
  '/unwatch <会话ID或序号> — 取消关注',
  '/sessions — 列出最近会话（配合 /watch 序号）',
  '/status — 插件状态',
  '',
  '推送来之后：引用那条推送消息直接回复，内容会直达对应会话。',
].join('\n');

export async function apply(ctx, config = {}) {
  const log = (message, level = 'info') => {
    const target = ctx?.log ?? console;
    try {
      (target[level] ?? target.log).call(target, message);
    } catch {
      console.log(message);
    }
  };

  const dir = stateDirectory(config);
  const state = new StateStore(dir, log);
  await state.load(config);

  if (!state.configured) {
    log(`[dsh-im-notify] no credentials found at ${dir}/config.json (appId/appSecret) — plugin stays idle`, 'warn');
    return;
  }

  const gateway = createGateway(ctx, log);
  const abort = new AbortController();
  const { signal } = abort;

  // completion push → card + mapping
  const feishu = new FeishuRuntime({
    config: state.config,
    log,
    onEvent: (inbound) => void handleInbound(inbound),
    onReady: () => {
      void engine.compensate(signal).catch(() => undefined);
    },
  });

  const engine = new WatchEngine({
    state,
    gateway,
    deliver: async ({ sessionId, title, chatId, replyToMessageId, kind, startedAt, note }) => {
      const card = buildCompletionCard({ title, sessionId, kind, startedAt, note });
      const messageId = await feishu.sendCompletionCard({ chatId, replyToMessageId, card });
      if (messageId) state.addMapping(messageId, sessionId, title);
    },
    log,
  });

  const routeBack = new RouteBack({ state, gateway, engine, feishu, log });

  // ---- session listing (verified surface only: workspace.follow + session.follow) ----
  const lastListings = new Map(); // chatId → { at, items: [{sessionId,title,workspace}] }

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
        const snapshot = await gateway.sessionSnapshot(entry.sessionId, 1, signal);
        title = typeof snapshot.header?.title === 'string' && snapshot.header.title
          ? snapshot.header.title : null;
      } catch { /* keep null title */ }
      items.push({ ...entry, title });
    }
    return items;
  }

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
            `${index + 1}. ${item.title ?? '（无标题）'} · ${item.workspace} · ${item.sessionId.slice(0, 8)}…`);
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
          if (watches.length === 0) {
            await feishu.replyText(inbound.messageId, '本聊天还没有关注任何会话。/sessions 查看，/watch 关注。');
            return;
          }
          const lines = watches.map((watch, index) =>
            `${index + 1}. ${watch.title ?? watch.sessionId.slice(0, 8)} · ${watch.sessionId.slice(0, 8)}…${engine.isRunning(watch.sessionId) ? ' · 🏃 运行中' : ''}`);
          await feishu.replyText(inbound.messageId, ['关注的会话：', ...lines].join('\n'));
          return;
        }

        case '/status': {
          const status = feishu.status;
          await feishu.replyText(inbound.messageId, [
            'dsh-im-notify 状态',
            `连接：${status.ready ? '✅ 飞书长连接正常' : `⚠️ ${status.lastError ?? '未连接'}`}`,
            `启动：${status.startedAt ?? '-'} · 收消息 ${status.messagesReceived} · 发卡片 ${status.cardsSent}`,
            `关注：${state.watches.length} 个 · 回程映射：${Object.keys(state.mappings).length} 条`,
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
  try {
    await feishu.start(signal);
    log('[dsh-im-notify] started — feishu long connection ready');
  } catch (error) {
    engine.stop();
    log(`[dsh-im-notify] feishu start failed: ${error?.message ?? error}`, 'error');
    throw error;
  }

  const dispose = () => {
    abort.abort(new DOMException('dsh-im-notify disposed', 'AbortError'));
    engine.stop();
    feishu.stop();
  };
  if (typeof ctx?.effect === 'function') {
    ctx.effect(dispose, 'dsh-im-notify: runtime');
  }
  return dispose;
}
