// dsh-im-notify feishu runtime — @larksuiteoapi/node-sdk wiring.
//
// SDK usage mirrors dsh-im src/channels/feishu/feishu-runtime.mjs:
//   new lark.Client({ appId, appSecret, domain })
//   new lark.EventDispatcher({}).register({ 'im.message.receive_v1': fn, ... })
//   new lark.WSClient({ appId, appSecret, domain, loggerLevel, onReady, onError })
//   wsClient.start(dispatcher)
// Sending (src/channels/feishu/feishu-channel.mjs:598-605):
//   client.im.message.create({ params:{receive_id_type:'chat_id'},
//     data:{ receive_id, msg_type:'interactive'|'text', content: JSON.stringify(...) } })
//   client.im.message.reply({ params:{message_id}, data:{ msg_type, content } })

import * as lark from '@larksuiteoapi/node-sdk';

const CONNECT_TIMEOUT_MS = 20_000;

export function statusEmojiAndTemplate(kind) {
  switch (kind) {
    case 'completed': return { emoji: '✅', template: 'green', label: '任务完成' };
    case 'stopped': return { emoji: '⏹️', template: 'grey', label: '任务已停止' };
    case 'aborted': return { emoji: '⚠️', template: 'orange', label: '任务已中止' };
    case 'cancelled': return { emoji: '🚫', template: 'grey', label: '任务已取消' };
    default: return { emoji: '🔔', template: 'blue', label: `回合结束（${kind}）` };
  }
}

function formatElapsed(startedAt) {
  if (!startedAt) return '';
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return ` · 耗时 ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return ` · 耗时 ${minutes}m${seconds % 60}s`;
  return ` · 耗时 ${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function buildCompletionCard({ title, sessionId, kind, startedAt, note, summary }) {
  const { emoji, template, label } = statusEmojiAndTemplate(kind);
  const md = [
    `**${title ?? '未命名会话'}**`,
    `\`${sessionId}\``,
    `${emoji} ${label}${formatElapsed(startedAt)}${note ? `　${note}` : ''}`,
  ].join('\n');
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: md } },
  ];
  if (summary) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**📋 结果摘要**\n${summary}` },
    });
  }
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'note',
    elements: [{
      tag: 'plain_text',
      content: '引用回复这条消息，内容将直达对应会话',
    }],
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${emoji} ${label}` },
      template,
    },
    elements,
  };
}

export function normalizeInbound(event) {
  const message = event?.message ?? {};
  // v2 event schema nests the id: sender.sender_id.open_id (union_id/user_id
  // siblings). Reading sender.open_id directly yields null → every command
  // was rejected as "non-owner".
  const senderId = event?.sender?.sender_id ?? event?.sender ?? {};
  const senderOpenId = senderId.open_id ?? senderId.union_id ?? null;
  let text = '';
  if (message.message_type === 'text' && typeof message.content === 'string') {
    try {
      text = JSON.parse(message.content).text ?? '';
    } catch {
      text = '';
    }
  }
  return {
    senderOpenId,
    messageId: typeof message.message_id === 'string' ? message.message_id : null,
    chatId: typeof message.chat_id === 'string' ? message.chat_id : null,
    chatType: typeof message.chat_type === 'string' ? message.chat_type : null,
    messageType: message.message_type ?? null,
    text,
    parentId: typeof message.parent_id === 'string' && message.parent_id ? message.parent_id : null,
    rootId: typeof message.root_id === 'string' && message.root_id ? message.root_id : null,
  };
}

export function stripMentions(text) {
  return text
    .replace(/<at[^>]*>\s*<\/at>/g, '')
    .replace(/@_user_\d+/g, '')
    .replace(/\u2006/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export class FeishuRuntime {
  #config;
  #log;
  #onEvent;
  #onReady;
  #client = null;
  #wsClient = null;
  #status = {
    ready: false,
    startedAt: null,
    connectedAt: null,
    lastError: null,
    messagesReceived: 0,
    cardsSent: 0,
  };

  constructor({ config, log, onEvent, onReady }) {
    this.#config = config;
    this.#log = log;
    this.#onEvent = onEvent;
    this.#onReady = onReady;
  }

  get status() {
    return { ...this.#status };
  }

  async start(signal) {
    const { appId, appSecret } = this.#config;
    if (!appId || !appSecret) throw new Error('Feishu credentials are incomplete');
    const domain = this.#config.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
    const larkConfig = { appId, appSecret, domain };
    const client = new lark.Client(larkConfig);
    this.#client = client;
    this.#status.startedAt = new Date().toISOString();

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (event) => {
        this.#status.messagesReceived += 1;
        try {
          this.#onEvent(normalizeInbound(event));
        } catch (error) {
          this.#log(`[dsh-im-notify] inbound handler error: ${error?.message ?? error}`, 'warn');
        }
      },
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Feishu WebSocket handshake timed out after ${CONNECT_TIMEOUT_MS}ms`)),
        CONNECT_TIMEOUT_MS,
      );
      const onAbort = () => reject(signal?.reason ?? new Error('aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      const settle = (fn, value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      // Pipe SDK-internal [ws] logs into our debug log to expose exactly which
      // stage stalls inside the Host process (endpoint fetch vs ws connect).
      const sdkLogger = {
        debug: (...a) => this.#log(`sdk.debug ${a.map(String).join(' ')}`),
        info: (...a) => this.#log(`sdk.info ${a.map(String).join(' ')}`),
        warn: (...a) => this.#log(`sdk.warn ${a.map(String).join(' ')}`, 'warn'),
        error: (...a) => this.#log(`sdk.error ${a.map(String).join(' ')}`, 'error'),
      };
      this.#wsClient = new lark.WSClient({
        ...larkConfig,
        loggerLevel: lark.LoggerLevel.debug,
        logger: sdkLogger,
        onReady: () => {
          this.#status.ready = true;
          this.#status.connectedAt = new Date().toISOString();
          this.#status.lastError = null;
          settle(resolve, undefined);
          try { this.#onReady?.(); } catch (error) { this.#log(`[dsh-im-notify] onReady hook: ${error?.message ?? error}`, 'warn'); }
        },
        onError: (error) => {
          this.#status.lastError = error?.message ?? String(error);
          if (!this.#status.ready) settle(reject, error);
        },
      });
      // SDK 1.45+ start(params) DESTRUCTURES params.eventDispatcher — passing
      // the dispatcher positionally makes start() warn "need to start with a
      // eventDispatcher" and return WITHOUT connecting (the 20s "handshake
      // timeout" we chased since v0.2.10).
      Promise.resolve(this.#wsClient.start({ eventDispatcher: dispatcher })).catch((error) => settle(reject, error));
    });
  }

  stop() {
    this.#status.ready = false;
    try { this.#wsClient?.close?.(); } catch { /* best effort */ }
    this.#wsClient = null;
    this.#client = null;
  }

  async #send(data) {
    if (!this.#client) throw new Error('Feishu client not started');
    const response = await this.#client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data,
    });
    const messageId = response?.data?.message_id ?? null;
    this.#status.cardsSent += 1;
    return messageId;
  }

  async #reply(messageId, data) {
    if (!this.#client) throw new Error('Feishu client not started');
    // URL path params live in payload.path (SDK formatPayload:100760-100764);
    // passing them via params makes fillApiPath throw "request miss message_id
    // path argument" — which escaped as an unhandled rejection and KILLED the
    // whole DSH Host on the first /help reply (crash 2026-11-17T14-05-57).
    const response = await this.#client.im.message.reply({ path: { message_id: messageId }, data });
    const sentId = response?.data?.message_id ?? null;
    this.#status.cardsSent += 1;
    return sentId;
  }

  /** Send a completion card; prefers a thread reply to the /watch message. */
  async sendCompletionCard({ chatId, replyToMessageId, card }) {
    const data = { msg_type: 'interactive', content: JSON.stringify(card) };
    if (replyToMessageId) {
      try {
        return await this.#reply(replyToMessageId, data);
      } catch (error) {
        this.#log(`[dsh-im-notify] card reply fell back to direct send: ${error?.message ?? error}`, 'warn');
      }
    }
    return this.#send({ receive_id: chatId, ...data });
  }

  async replyText(messageId, text) {
    return this.#reply(messageId, { msg_type: 'text', content: JSON.stringify({ text }) });
  }

  async sendText(chatId, text) {
    return this.#send({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) });
  }
}
