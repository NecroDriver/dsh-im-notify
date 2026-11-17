// plugin-src/host/index.mjs
import { basename } from "node:path";

// plugin-src/host/state.mjs
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
function resolveDshHome(cordisConfig) {
  return cordisConfig?.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
function stateDirectory(cordisConfig) {
  return resolve(resolveDshHome(cordisConfig), "integrations", "dsh-im-notify");
}
var DEFAULTS = {
  domain: "feishu",
  maxWatchesPerChat: 8,
  mappingTtlMs: 24 * 60 * 60 * 1e3
};
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}
var StateStore = class {
  #dir;
  #configFile;
  #stateFile;
  #saveTimer = null;
  #persisted = "";
  log = () => {
  };
  /** @param {string} dir state directory */
  constructor(dir, log) {
    this.#dir = dir;
    this.#configFile = join(dir, "config.json");
    this.#stateFile = join(dir, "state.json");
    if (log) this.log = log;
    this.config = { ...DEFAULTS };
    this.watches = [];
    this.mappings = {};
  }
  async load(cordisConfig = {}) {
    await mkdir(this.#dir, { recursive: true });
    const fileConfig = await readJson(this.#configFile) ?? {};
    this.config = {
      ...DEFAULTS,
      ...fileConfig,
      // cordis patch `config:` keys win (operator-declared), except dshHome routing
      ...cordisConfig.appId !== void 0 ? { appId: cordisConfig.appId } : {},
      ...cordisConfig.appSecret !== void 0 ? { appSecret: cordisConfig.appSecret } : {},
      ...Array.isArray(cordisConfig.ownerOpenIds) ? { ownerOpenIds: cordisConfig.ownerOpenIds } : {},
      ...cordisConfig.domain !== void 0 ? { domain: cordisConfig.domain } : {},
      ...cordisConfig.maxWatchesPerChat !== void 0 ? { maxWatchesPerChat: Number(cordisConfig.maxWatchesPerChat) || DEFAULTS.maxWatchesPerChat } : {}
    };
    const state = await readJson(this.#stateFile) ?? {};
    this.watches = Array.isArray(state.watches) ? state.watches : [];
    this.mappings = state.mappings && typeof state.mappings === "object" ? state.mappings : {};
    this.#persisted = JSON.stringify(this.#snapshot());
    this.#gcMappings();
    return this;
  }
  get configured() {
    return typeof this.config.appId === "string" && this.config.appId.trim() !== "" && typeof this.config.appSecret === "string" && this.config.appSecret.trim() !== "";
  }
  isOwner(senderOpenId) {
    const owners = this.config.ownerOpenIds;
    if (!Array.isArray(owners) || owners.length === 0) return true;
    return owners.includes(senderOpenId);
  }
  watchesFor(sessionId) {
    return this.watches.filter((watch) => watch.sessionId === sessionId);
  }
  watchesIn(chatId) {
    return this.watches.filter((watch) => watch.chatId === chatId);
  }
  addWatch(entry) {
    this.watches = this.watches.filter(
      (watch) => !(watch.chatId === entry.chatId && watch.sessionId === entry.sessionId)
    );
    const inChat = this.watchesIn(entry.chatId);
    const cap = this.config.maxWatchesPerChat;
    if (inChat.length >= cap) {
      const drop = [...inChat].sort((a, b) => a.watchStartedAt.localeCompare(b.watchStartedAt)).slice(0, Math.max(1, inChat.length - cap + 1));
      const dropSet = new Set(drop);
      this.watches = this.watches.filter((watch) => !dropSet.has(watch));
    }
    this.watches.push(entry);
    this.save();
  }
  removeWatch(chatId, sessionId) {
    const before = this.watches.length;
    this.watches = this.watches.filter(
      (watch) => !(watch.chatId === chatId && watch.sessionId === sessionId)
    );
    this.save();
    return this.watches.length < before;
  }
  updateWatch(sessionId, patch) {
    for (const watch of this.watches) {
      if (watch.sessionId === sessionId) Object.assign(watch, patch);
    }
    this.save();
  }
  addMapping(messageId, sessionId, title) {
    this.mappings[messageId] = { sessionId, title, at: Date.now() };
    this.#gcMappings();
    this.save();
  }
  getMapping(messageId) {
    const hit = this.mappings[messageId];
    if (!hit) return null;
    if (Date.now() - hit.at > this.config.mappingTtlMs) {
      delete this.mappings[messageId];
      this.save();
      return null;
    }
    return hit;
  }
  #gcMappings() {
    const ttl = this.config.mappingTtlMs;
    const now = Date.now();
    for (const [id, entry] of Object.entries(this.mappings)) {
      if (now - entry.at > ttl) delete this.mappings[id];
    }
  }
  #snapshot() {
    return {
      version: 1,
      watches: this.watches,
      mappings: this.mappings,
      savedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  /** Debounced atomic save (tmp + rename). Never throws. */
  save() {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      const json = JSON.stringify(this.#snapshot());
      if (json === this.#persisted) return;
      this.#persisted = json;
      const tmp = `${this.#stateFile}.tmp`;
      Promise.resolve().then(() => writeFile(tmp, json, "utf8")).then(() => rename(tmp, this.#stateFile)).catch((error) => this.log(`[dsh-im-notify] state save failed: ${error?.message ?? error}`, "warn"));
    }, 400);
  }
};

// plugin-src/host/gateway.mjs
import { randomUUID } from "node:crypto";
function timeZoneName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? void 0;
  } catch {
    return void 0;
  }
}
function createGateway(ctx, log) {
  const gateway = ctx?.typertGateway;
  if (!gateway || typeof gateway.invoke !== "function" || typeof gateway.stream !== "function") {
    throw new TypeError("dsh-im-notify requires ctx.typertGateway (inject list: typertGateway)");
  }
  const connection = ctx?.connection;
  let peer;
  if (typeof connection?.createPeer === "function") {
    peer = connection.createPeer({ principal: { kind: "owner" }, interactions: "none" });
  } else {
    log("[dsh-im-notify] ctx.connection.createPeer unavailable; invoking without an explicit peer", "warn");
  }
  async function invoke(namespace, method, args, signal) {
    return gateway.invoke({
      namespace,
      method,
      args,
      ...signal === void 0 ? {} : { signal },
      ...peer === void 0 ? {} : { peer }
    });
  }
  async function streamFirst(namespace, method, args, signal) {
    const controller = new AbortController();
    const streamSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let iterator;
    try {
      const source = await gateway.stream({
        namespace,
        method,
        args,
        signal: streamSignal,
        ...peer === void 0 ? {} : { peer }
      });
      iterator = source[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done) throw new Error(`${namespace}.${method} stream ended before its baseline`);
      return first.value;
    } finally {
      controller.abort(new DOMException("Baseline received", "AbortError"));
      await Promise.resolve(iterator?.return?.()).catch(() => void 0);
    }
  }
  return {
    async sessionSnapshot(sessionId, maxMessages = 20, signal) {
      const frame = await streamFirst("session", "follow", {
        request: { address: { kind: "session", sessionId }, maxMessages }
      }, signal);
      if (frame?.type !== "snapshot" || !Number.isSafeInteger(frame.cursor)) {
        throw new Error("session.follow returned no snapshot");
      }
      return frame;
    },
    async workspaceBaseline(signal) {
      const frame = await streamFirst("workspace", "follow", {}, signal);
      if (frame?.type !== "baseline" || !frame.value || typeof frame.value !== "object") {
        throw new Error("workspace.follow returned no baseline");
      }
      return frame.value;
    },
    /**
     * Submit user text into an existing session. `mode`:
     *   'queue' — idle session: resume its Agent with the persisted config
     *   'steer' — running session: inject as a steering instruction
     */
    async prompt(sessionId, text, { mode = "queue", signal } = {}) {
      const timeZone = timeZoneName();
      return invoke("session", "prompt", {
        request: {
          requestId: randomUUID(),
          sessionId,
          mode,
          content: [{ type: "text", text }],
          ...timeZone ? { clientTimeZone: timeZone } : {}
        }
      }, signal);
    }
  };
}

// plugin-src/host/watch-engine.mjs
var WatchEngine = class {
  #state;
  #gateway;
  #deliver;
  #log;
  #dispose = null;
  #runningStarts = /* @__PURE__ */ new Map();
  // sessionId → turn/start time (ms)
  /** @type {Set<string>} sessions with a turn in flight */
  #running = /* @__PURE__ */ new Set();
  #started = false;
  /**
   * @param {{
   *   state: import('./state.mjs').StateStore,
   *   gateway: Awaited<ReturnType<import('./gateway.mjs').createGateway>>,
   *   deliver: (arg: {sessionId:string,title:string|null,chatId:string,replyToMessageId:string|null,kind:string,startedAt:number|null,note?:string}) => Promise<void>,
   *   log: (msg:string, level?:string)=>void,
   * }} options
   */
  constructor({ state, gateway, deliver, log }) {
    this.#state = state;
    this.#gateway = gateway;
    this.#deliver = deliver;
    this.#log = log;
  }
  get started() {
    return this.#started;
  }
  isRunning(sessionId) {
    return this.#running.has(sessionId);
  }
  start(ctx) {
    if (this.#started || typeof ctx?.on !== "function") return;
    this.#dispose = ctx.on("session/event", (session, event) => {
      try {
        this.handle(session, event);
      } catch (error) {
        this.#log(`[dsh-im-notify] event handler error: ${error?.message ?? error}`, "warn");
      }
    }, { global: true });
    this.#started = true;
  }
  stop() {
    if (this.#dispose) {
      try {
        this.#dispose();
      } catch {
      }
      this.#dispose = null;
    }
    this.#started = false;
  }
  handle(session, event) {
    const sessionId = session?.id;
    if (typeof sessionId !== "string" || !event || typeof event !== "object") return;
    const watches = this.#state.watchesFor(sessionId);
    if (watches.length === 0) return;
    const seq = Number.isSafeInteger(event.seq) ? event.seq : null;
    if (seq !== null) {
      const maxKnown = Math.max(...watches.map((watch) => Number.isSafeInteger(watch.lastSeq) ? watch.lastSeq : -1));
      if (seq <= maxKnown) return;
      if (seq > maxKnown + 1 && maxKnown >= 0) {
      }
    }
    if (event.type === "turn/start") {
      const startedAt2 = typeof event.time === "number" ? event.time : Date.now();
      this.#runningStarts.set(sessionId, startedAt2);
      this.#running.add(sessionId);
      return;
    }
    if (event.type !== "turn/end") return;
    const startedAt = this.#runningStarts.get(sessionId) ?? null;
    this.#runningStarts.delete(sessionId);
    this.#running.delete(sessionId);
    const kind = event.data?.reason?.kind ?? "completed";
    for (const watch of watches) {
      void Promise.resolve().then(() => this.#deliver({
        sessionId,
        title: watch.title ?? null,
        chatId: watch.chatId,
        replyToMessageId: watch.replyToMessageId,
        kind,
        startedAt
      })).catch((error) => this.#log(`[dsh-im-notify] deliver failed: ${error?.message ?? error}`, "warn"));
    }
  }
  /**
   * Restart compensation: for every watch, read the session.follow snapshot,
   * re-push missed turn/end events with seq > watch.lastSeq, then fast-forward
   * the cursor. Also refreshes titles from the snapshot header.
   */
  async compensate(signal) {
    const watches = [...this.#state.watches];
    for (const watch of watches) {
      if (signal?.aborted) return;
      try {
        const snapshot = await this.#gateway.sessionSnapshot(watch.sessionId, 20, signal);
        const header = snapshot.header;
        if (header?.id !== watch.sessionId) {
          this.#log(`[dsh-im-notify] watch ${watch.sessionId} no longer resolvable; keeping but flagging`, "warn");
          this.#state.updateWatch(watch.sessionId, { title: "\u26A0\uFE0F \u4F1A\u8BDD\u4E0D\u53EF\u7528" });
          continue;
        }
        const missed = [];
        for (const record of Array.isArray(snapshot.records) ? snapshot.records : []) {
          const event = record?.event ?? record;
          if (event?.type !== "turn/end") continue;
          if (Number.isSafeInteger(event.seq) && event.seq > watch.lastSeq) missed.push(event);
        }
        const title = typeof header.title === "string" && header.title ? header.title : watch.title;
        for (const event of missed.slice(-3)) {
          await this.#deliver({
            sessionId: watch.sessionId,
            title,
            chatId: watch.chatId,
            replyToMessageId: watch.replyToMessageId,
            kind: event.data?.reason?.kind ?? "completed",
            startedAt: null,
            note: missed.length > 3 ? `\uFF08\u91CD\u542F\u8865\u53D1\uFF0C\u5171 ${missed.length} \u6761\uFF0C\u4EC5\u663E\u793A\u6700\u8FD1 3 \u6761\uFF09` : "\uFF08\u91CD\u542F\u8865\u53D1\uFF09"
          });
        }
        this.#state.updateWatch(watch.sessionId, { lastSeq: snapshot.cursor, title });
      } catch (error) {
        this.#log(`[dsh-im-notify] compensate failed for ${watch.sessionId}: ${error?.message ?? error}`, "warn");
      }
    }
  }
};

// plugin-src/host/feishu.mjs
import * as lark from "@larksuiteoapi/node-sdk";
var CONNECT_TIMEOUT_MS = 2e4;
function statusEmojiAndTemplate(kind) {
  switch (kind) {
    case "completed":
      return { emoji: "\u2705", template: "green", label: "\u4EFB\u52A1\u5B8C\u6210" };
    case "stopped":
      return { emoji: "\u23F9\uFE0F", template: "grey", label: "\u4EFB\u52A1\u5DF2\u505C\u6B62" };
    case "aborted":
      return { emoji: "\u26A0\uFE0F", template: "orange", label: "\u4EFB\u52A1\u5DF2\u4E2D\u6B62" };
    case "cancelled":
      return { emoji: "\u{1F6AB}", template: "grey", label: "\u4EFB\u52A1\u5DF2\u53D6\u6D88" };
    default:
      return { emoji: "\u{1F514}", template: "blue", label: `\u56DE\u5408\u7ED3\u675F\uFF08${kind}\uFF09` };
  }
}
function formatElapsed(startedAt) {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1e3));
  if (seconds < 60) return ` \xB7 \u8017\u65F6 ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return ` \xB7 \u8017\u65F6 ${minutes}m${seconds % 60}s`;
  return ` \xB7 \u8017\u65F6 ${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
function buildCompletionCard({ title, sessionId, kind, startedAt, note }) {
  const { emoji, template, label } = statusEmojiAndTemplate(kind);
  const md = [
    `**${title ?? "\u672A\u547D\u540D\u4F1A\u8BDD"}**`,
    `\`${sessionId}\``,
    `${emoji} ${label}${formatElapsed(startedAt)}${note ? `\u3000${note}` : ""}`
  ].join("\n");
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `${emoji} ${label}` },
      template
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: md } },
      { tag: "hr" },
      {
        tag: "note",
        elements: [{
          tag: "plain_text",
          content: "\u5F15\u7528\u56DE\u590D\u8FD9\u6761\u6D88\u606F\uFF0C\u5185\u5BB9\u5C06\u76F4\u8FBE\u5BF9\u5E94\u4F1A\u8BDD"
        }]
      }
    ]
  };
}
function normalizeInbound(event) {
  const message = event?.message ?? {};
  const senderOpenId = event?.sender?.open_id ?? event?.sender?.open_id?.id ?? null;
  let text = "";
  if (message.message_type === "text" && typeof message.content === "string") {
    try {
      text = JSON.parse(message.content).text ?? "";
    } catch {
      text = "";
    }
  }
  return {
    senderOpenId,
    messageId: typeof message.message_id === "string" ? message.message_id : null,
    chatId: typeof message.chat_id === "string" ? message.chat_id : null,
    chatType: typeof message.chat_type === "string" ? message.chat_type : null,
    messageType: message.message_type ?? null,
    text,
    parentId: typeof message.parent_id === "string" && message.parent_id ? message.parent_id : null,
    rootId: typeof message.root_id === "string" && message.root_id ? message.root_id : null
  };
}
function stripMentions(text) {
  return text.replace(/<at[^>]*>\s*<\/at>/g, "").replace(/@_user_\d+/g, "").replace(/\u2006/g, " ").replace(/[ \t]{2,}/g, " ").trim();
}
var FeishuRuntime = class {
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
    cardsSent: 0
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
    if (!appId || !appSecret) throw new Error("Feishu credentials are incomplete");
    const domain = this.#config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
    const larkConfig = { appId, appSecret, domain };
    const client = new lark.Client(larkConfig);
    this.#client = client;
    this.#status.startedAt = (/* @__PURE__ */ new Date()).toISOString();
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": (event) => {
        this.#status.messagesReceived += 1;
        try {
          this.#onEvent(normalizeInbound(event));
        } catch (error) {
          this.#log(`[dsh-im-notify] inbound handler error: ${error?.message ?? error}`, "warn");
        }
      }
    });
    await new Promise((resolve2, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Feishu WebSocket handshake timed out after ${CONNECT_TIMEOUT_MS}ms`)),
        CONNECT_TIMEOUT_MS
      );
      const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      const settle = (fn, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn(value);
      };
      this.#wsClient = new lark.WSClient({
        ...larkConfig,
        loggerLevel: lark.LoggerLevel.warn,
        onReady: () => {
          this.#status.ready = true;
          this.#status.connectedAt = (/* @__PURE__ */ new Date()).toISOString();
          this.#status.lastError = null;
          settle(resolve2, void 0);
          try {
            this.#onReady?.();
          } catch (error) {
            this.#log(`[dsh-im-notify] onReady hook: ${error?.message ?? error}`, "warn");
          }
        },
        onError: (error) => {
          this.#status.lastError = error?.message ?? String(error);
          if (!this.#status.ready) settle(reject, error);
        }
      });
      Promise.resolve(this.#wsClient.start(dispatcher)).catch((error) => settle(reject, error));
    });
  }
  stop() {
    this.#status.ready = false;
    try {
      this.#wsClient?.close?.();
    } catch {
    }
    this.#wsClient = null;
    this.#client = null;
  }
  async #send(data) {
    if (!this.#client) throw new Error("Feishu client not started");
    const response = await this.#client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data
    });
    const messageId = response?.data?.message_id ?? null;
    this.#status.cardsSent += 1;
    return messageId;
  }
  async #reply(messageId, data) {
    if (!this.#client) throw new Error("Feishu client not started");
    const response = await this.#client.im.message.reply({ params: { message_id: messageId }, data });
    const sentId = response?.data?.message_id ?? null;
    this.#status.cardsSent += 1;
    return sentId;
  }
  /** Send a completion card; prefers a thread reply to the /watch message. */
  async sendCompletionCard({ chatId, replyToMessageId, card }) {
    const data = { msg_type: "interactive", content: JSON.stringify(card) };
    if (replyToMessageId) {
      try {
        return await this.#reply(replyToMessageId, data);
      } catch (error) {
        this.#log(`[dsh-im-notify] card reply fell back to direct send: ${error?.message ?? error}`, "warn");
      }
    }
    return this.#send({ receive_id: chatId, ...data });
  }
  async replyText(messageId, text) {
    return this.#reply(messageId, { msg_type: "text", content: JSON.stringify({ text }) });
  }
  async sendText(chatId, text) {
    return this.#send({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) });
  }
};

// plugin-src/host/route-back.mjs
var RouteBack = class {
  #state;
  #gateway;
  #engine;
  #feishu;
  #log;
  constructor({ state, gateway, engine, feishu, log }) {
    this.#state = state;
    this.#gateway = gateway;
    this.#engine = engine;
    this.#feishu = feishu;
    this.#log = log;
  }
  /** @returns {Promise<boolean>} true when the message was routed */
  async maybeRoute(inbound) {
    const parentId = inbound.parentId ?? inbound.rootId;
    if (!parentId || !inbound.messageId) return false;
    const mapping = this.#state.getMapping(parentId);
    if (!mapping) return false;
    const text = inbound.text.trim();
    if (!text) {
      await this.#feishu.replyText(
        inbound.messageId,
        "\u5F15\u7528\u4E86\u4EFB\u52A1\u901A\u77E5\uFF0C\u4F46\u6CA1\u6709\u6587\u5B57\u5185\u5BB9\u3002\u8BF7\u5F15\u7528\u901A\u77E5\u6D88\u606F\u5E76\u76F4\u63A5\u8F93\u5165\u8981\u53D1\u7ED9\u8BE5\u4F1A\u8BDD\u7684\u6307\u4EE4\u3002"
      );
      return true;
    }
    const mode = this.#engine.isRunning(mapping.sessionId) ? "steer" : "queue";
    try {
      await this.#gateway.prompt(mapping.sessionId, text, { mode });
    } catch (error) {
      this.#log(`[dsh-im-notify] route-back prompt failed: ${error?.message ?? error}`, "warn");
      await this.#feishu.replyText(
        inbound.messageId,
        `\u274C \u9001\u8FBE\u5931\u8D25\uFF08${error?.message ?? error}\uFF09\u3002\u4F1A\u8BDD\u53EF\u80FD\u5DF2\u88AB\u6E05\u7406\uFF0C\u8BF7\u7528 /watchlist \u68C0\u67E5\u3002`
      );
      return true;
    }
    const label = mapping.title ?? mapping.sessionId.slice(0, 8);
    await this.#feishu.replyText(
      inbound.messageId,
      mode === "steer" ? `\u2705 \u5DF2\u4F5C\u4E3A\u8865\u5145\u6307\u4EE4\u6CE8\u5165\u8FD0\u884C\u4E2D\u7684\u4F1A\u8BDD\u300C${label}\u300D` : `\u2705 \u5DF2\u9001\u8FBE\u4F1A\u8BDD\u300C${label}\u300D\u5E76\u5F00\u59CB\u5904\u7406\uFF0C\u5B8C\u6210\u540E\u4F1A\u518D\u63A8\u9001`
    );
    return true;
  }
};

// plugin-src/host/registration.mjs
import * as Lark from "@larksuiteoapi/node-sdk";
import QRCode from "qrcode";
var QR_TTL_MS = 10 * 60 * 1e3;
var ADDONS = {
  preset: false,
  scopes: {
    tenant: [
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:message:send_as_bot"
    ]
  },
  events: {
    items: {
      tenant: ["im.message.receive_v1"]
    }
  }
};
var APP_PRESET = {
  name: "DSH Notify",
  description: "DeepSeek Harness \u4EFB\u52A1\u5B8C\u6210\u901A\u77E5\uFF1A/watch \u5173\u6CE8\u4F1A\u8BDD\uFF0C\u5B8C\u6210\u540E\u63A8\u9001\u5230\u98DE\u4E66\uFF0C\u5F15\u7528\u63A8\u9001\u5373\u53EF\u5411\u4F1A\u8BDD\u4E0B\u8FBE\u6307\u4EE4\u3002"
};
async function encodeQr(url) {
  return QRCode.toDataURL(url, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
    type: "image/png"
  });
}
function maskAppId(appId) {
  if (typeof appId !== "string" || appId.length < 8) return appId ?? null;
  return `${appId.slice(0, 6)}\u2026${appId.slice(-4)}`;
}
function createRegistrationManager({
  getConfig,
  saveCredentials,
  log = () => {
  },
  registerApp: registerAppOverride
}) {
  const callRegisterApp = typeof registerAppOverride === "function" ? registerAppOverride : (options) => Lark.registerApp(options);
  let attempt = 0;
  let current = null;
  const qrCache = /* @__PURE__ */ new Map();
  async function cachedQr(url) {
    if (!url) return void 0;
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
    if (!current) return { state: "idle", attemptId: null };
    const { id, state, qrCodeUrl, expiresAt, pollIntervalMs, error } = current;
    return {
      state,
      attemptId: String(id),
      ...qrCodeUrl ? { qrCodeUrl } : {},
      expiresAt,
      pollIntervalMs: pollIntervalMs ?? 1800,
      remainingSeconds: expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 1e3)) : void 0,
      ...error ? { error } : {}
    };
  }
  async function begin() {
    cancel(String(attempt));
    attempt += 1;
    const id = attempt;
    const controller = new AbortController();
    const config = getConfig() ?? {};
    const entry = {
      id,
      controller,
      state: "starting",
      qrCodeUrl: null,
      startedAt: Date.now(),
      expiresAt: Date.now() + QR_TTL_MS,
      pollIntervalMs: 5e3,
      error: null,
      domainSwitched: false
    };
    current = entry;
    const finish = (state, error = null) => {
      if (current !== entry) return;
      entry.state = state;
      if (error) entry.error = { code: state, message: String(error?.message ?? error) };
    };
    const expiry = setTimeout(() => {
      if (current === entry && !["succeeded", "error", "cancelled"].includes(entry.state)) {
        controller.abort(new DOMException("QR expired", "AbortError"));
        finish("expired");
      }
    }, QR_TTL_MS);
    const clearExpiry = () => clearTimeout(expiry);
    void (async () => {
      try {
        const result = await callRegisterApp({
          ...config.domain === "lark" ? { domain: "accounts.larksuite.com" } : {},
          source: "dsh-im-notify",
          createOnly: true,
          appPreset: APP_PRESET,
          addons: ADDONS,
          signal: controller.signal,
          onQRCodeReady: (qr) => {
            const url = typeof qr === "string" ? qr : qr?.url;
            if (current !== entry || typeof url !== "string" || url === "") return;
            entry.qrCodeUrl = url;
            const expireIn = typeof qr?.expireIn === "number" && qr.expireIn > 0 ? qr.expireIn : null;
            if (expireIn) entry.expiresAt = Date.now() + expireIn * 1e3;
            if (entry.state === "starting") entry.state = "qr_ready";
          },
          onStatusChange: (change) => {
            const status = typeof change === "string" ? change : change?.status;
            if (current !== entry) return;
            if (status === "domain_switched") entry.domainSwitched = true;
            if (status === "polling" && entry.state === "starting" && entry.qrCodeUrl) entry.state = "qr_ready";
          }
        });
        if (current !== entry) return;
        entry.state = "saving";
        await saveCredentials({
          appId: result?.client_id,
          appSecret: result?.client_secret,
          openId: result?.user_info?.open_id,
          domain: entry.domainSwitched || config.domain === "lark" ? "lark" : config.domain ?? "feishu"
        });
        entry.state = "succeeded";
        entry.qrCodeUrl = null;
        log("[dsh-im-notify] QR registration succeeded \u2014 credentials saved, Host restart required");
      } catch (error) {
        if (controller.signal.aborted) {
          if (current === entry && entry.state !== "expired") finish("cancelled");
        } else {
          const code = error?.failure?.code ?? error?.code;
          finish("error", code === "access_denied" ? new Error("\u7528\u6237\u5728\u98DE\u4E66\u4FA7\u62D2\u7EDD\u4E86\u6388\u6743") : code === "expired_token" ? new Error("\u4E8C\u7EF4\u7801\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77") : error);
          log(`[dsh-im-notify] QR registration failed: ${error?.message ?? error}`, "warn");
        }
      } finally {
        clearExpiry();
      }
    })();
    const deadline = Date.now() + 2e4;
    while (current === entry && !entry.qrCodeUrl && Date.now() < deadline) {
      await new Promise((resolve2) => setTimeout(resolve2, 200));
    }
    const snap = snapshot();
    return {
      ...snap,
      ...snap.qrCodeUrl ? { qrCodeDataUrl: await cachedQr(snap.qrCodeUrl) } : {}
    };
  }
  async function poll(attemptId) {
    if (!current || String(current.id) !== String(attemptId)) {
      return { ok: false, error: { code: "stale-attempt", message: "\u8BE5\u626B\u7801\u4F1A\u8BDD\u5DF2\u7ED3\u675F\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u3002" } };
    }
    const snap = snapshot();
    return {
      ok: true,
      ...snap,
      ...snap.state === "succeeded" ? { appIdMasked: maskAppId(getConfig()?.appId) } : {},
      ...snap.qrCodeUrl ? { qrCodeDataUrl: await cachedQr(snap.qrCodeUrl) } : {}
    };
  }
  function cancel(attemptId) {
    if (!current) return false;
    if (attemptId != null && String(current.id) !== String(attemptId)) return false;
    if (!["succeeded", "error", "cancelled", "expired"].includes(current.state)) {
      current.state = "cancelled";
      current.controller.abort(new DOMException("cancelled", "AbortError"));
    }
    current = null;
    return true;
  }
  return {
    begin,
    poll,
    cancel,
    snapshot,
    get activeAttemptId() {
      return current ? String(current.id) : null;
    }
  };
}

// plugin-src/host/settings-rpc.mjs
var RPC_KEY = "dsh-im-notify";
function isLoopbackAuthority(authority) {
  if (!authority) return false;
  try {
    const url = new URL(`http://${authority}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
    const hostname = url.hostname.replace(/\.$/, "");
    return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
  } catch {
    return false;
  }
}
function isLoopbackRequest(request) {
  if (!isLoopbackAuthority(request.headers.get("host"))) return false;
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && isLoopbackAuthority(url.host);
  } catch {
    return false;
  }
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function reply(rpcId, result) {
  const value = result?.ok === false ? { ...result, error: { details: {}, ...result.error } } : result;
  return Response.json({ type: "server-response", rpcId, result: value });
}
function installSettingsRpc(ctx, handler, { log = () => {
} } = {}) {
  if (typeof ctx?.connection?.fetch?.register !== "function") {
    log("[dsh-im-notify] Host Connection Fetch registry unavailable \u2014 settings panel disabled", "warn");
    return () => {
    };
  }
  const unregister = ctx.connection.fetch.register({
    path: `/api/${RPC_KEY}`,
    methods: ["POST"],
    requestBody: "buffered",
    async fetch(request) {
      if (!isLoopbackRequest(request)) return new Response("forbidden", { status: 403 });
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        return new Response("content type must be application/json", { status: 415 });
      }
      let message;
      try {
        message = await request.json();
      } catch {
        return new Response("body is not JSON", { status: 400 });
      }
      const rpcId = typeof message?.rpcId === "string" ? message.rpcId : "invalid-request";
      const call = message?.payload;
      if (!isRecord(message) || message.type !== "client-request" || message.method !== RPC_KEY || !isRecord(call) || typeof call.method !== "string" || !Object.hasOwn(call, "payload")) {
        return reply(rpcId, { ok: false, error: { code: "bad-request", message: "Invalid settings request." } });
      }
      try {
        const result = await handler(call.method, call.payload, request.signal);
        return reply(rpcId, result ?? { ok: true, value: null });
      } catch (error) {
        log(`[dsh-im-notify] settings rpc ${call.method} failed: ${error?.message ?? error}`, "warn");
        return new Response("settings handler failed", { status: 500 });
      }
    }
  });
  return () => {
    try {
      unregister?.();
    } catch {
    }
  };
}

// plugin-src/host/index.mjs
var name = "dsh-im-notify";
var inject = ["connection", "typertGateway"];
var HELP = [
  "dsh-im-notify \xB7 \u4EFB\u52A1\u5B8C\u6210\u901A\u77E5",
  "/watch <\u4F1A\u8BDDID\u6216\u5E8F\u53F7> \u2014 \u5173\u6CE8\u4F1A\u8BDD\uFF0C\u5B8C\u6210\u540E\u63A8\u9001",
  "/watchlist \u2014 \u67E5\u770B\u672C\u804A\u5929\u5173\u6CE8\u7684\u4F1A\u8BDD",
  "/unwatch <\u4F1A\u8BDDID\u6216\u5E8F\u53F7> \u2014 \u53D6\u6D88\u5173\u6CE8",
  "/sessions \u2014 \u5217\u51FA\u6700\u8FD1\u4F1A\u8BDD\uFF08\u914D\u5408 /watch \u5E8F\u53F7\uFF09",
  "/status \u2014 \u63D2\u4EF6\u72B6\u6001",
  "",
  "\u63A8\u9001\u6765\u4E4B\u540E\uFF1A\u5F15\u7528\u90A3\u6761\u63A8\u9001\u6D88\u606F\u76F4\u63A5\u56DE\u590D\uFF0C\u5185\u5BB9\u4F1A\u76F4\u8FBE\u5BF9\u5E94\u4F1A\u8BDD\u3002"
].join("\n");
async function apply(ctx, config = {}) {
  const log = (message, level = "info") => {
    const target = ctx?.logger ?? console;
    try {
      (target[level] ?? target.log).call(target, message);
    } catch {
      console.log(message);
    }
  };
  const dir = stateDirectory(config);
  const state = new StateStore(dir, log);
  await state.load(config);
  let gateway = null;
  let engine = null;
  let feishu = null;
  const registration = createRegistrationManager({
    getConfig: () => state.config,
    saveCredentials: async ({ appId, appSecret, openId, domain }) => {
      const owners = Array.isArray(state.config.ownerOpenIds) && state.config.ownerOpenIds.length > 0 ? state.config.ownerOpenIds : openId ? [openId] : [];
      state.config = { ...state.config, appId, appSecret, domain, ownerOpenIds: owners };
      await state.save();
    },
    log
  });
  async function settingsStatus() {
    return {
      configured: state.configured,
      appIdMasked: state.configured ? maskAppId(state.config.appId) : null,
      domain: state.config.domain ?? "feishu",
      watchCount: state.watches.length,
      mappingCount: Object.keys(state.mappings).length,
      botReady: feishu?.status?.ready === true,
      botStartedAt: feishu?.status?.startedAt ?? null,
      registration: registration.snapshot(),
      watches: state.watches.map((watch) => ({
        sessionId: watch.sessionId,
        title: watch.title,
        chatId: watch.chatId,
        addedAt: watch.watchStartedAt,
        running: engine?.isRunning(watch.sessionId) === true
      }))
    };
  }
  const stopSettingsRpc = installSettingsRpc(ctx, async (method, payload) => {
    switch (method) {
      case "status":
        return { ok: true, value: await settingsStatus() };
      case "registration.begin": {
        const value = await registration.begin(payload ?? {});
        return { ok: true, value };
      }
      case "registration.poll":
        return registration.poll(payload?.attemptId);
      case "registration.cancel":
        registration.cancel(payload?.attemptId);
        return { ok: true, value: { cancelled: true } };
      case "watch.remove":
        state.removeWatch(String(payload?.chatId ?? ""), String(payload?.sessionId ?? ""));
        return { ok: true, value: await settingsStatus() };
      case "watch.clear":
        for (const watch of [...state.watches]) state.removeWatch(watch.chatId, watch.sessionId);
        return { ok: true, value: await settingsStatus() };
      default:
        return { ok: false, error: { code: "bad-request", message: `Unknown method: ${method}` } };
    }
  }, { log });
  if (!state.configured) {
    log(`[dsh-im-notify] no credentials found at ${dir}/config.json \u2014 idle, settings panel offers QR onboarding`, "warn");
    return () => {
      registration.cancel();
      stopSettingsRpc();
    };
  }
  gateway = createGateway(ctx, log);
  const abort = new AbortController();
  const { signal } = abort;
  feishu = new FeishuRuntime({
    config: state.config,
    log,
    onEvent: (inbound) => void handleInbound(inbound),
    onReady: () => {
      void engine.compensate(signal).catch(() => void 0);
    }
  });
  engine = new WatchEngine({
    state,
    gateway,
    deliver: async ({ sessionId, title, chatId, replyToMessageId, kind, startedAt, note }) => {
      const card = buildCompletionCard({ title, sessionId, kind, startedAt, note });
      const messageId = await feishu.sendCompletionCard({ chatId, replyToMessageId, card });
      if (messageId) state.addMapping(messageId, sessionId, title);
    },
    log
  });
  const routeBack = new RouteBack({ state, gateway, engine, feishu, log });
  const lastListings = /* @__PURE__ */ new Map();
  async function listSessions(limit = 15) {
    const baseline = await gateway.workspaceBaseline(signal);
    const workspaces = Array.isArray(baseline?.items) ? baseline.items : [];
    const flat = [];
    for (const workspace of workspaces) {
      for (const sessionId of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []) {
        flat.push({ sessionId, workspace: basename(String(workspace?.path ?? workspace?.workspaceId ?? "")) });
      }
    }
    const tail = flat.slice(-limit).reverse();
    const items = [];
    for (const entry of tail) {
      let title = null;
      try {
        const snapshot = await gateway.sessionSnapshot(entry.sessionId, 1, signal);
        title = typeof snapshot.header?.title === "string" && snapshot.header.title ? snapshot.header.title : null;
      } catch {
      }
      items.push({ ...entry, title });
    }
    return items;
  }
  async function resolveWatchTarget(chatId, arg) {
    const trimmed = arg.trim();
    if (/^\d+$/.test(trimmed)) {
      const listing2 = lastListings.get(chatId);
      const index = Number(trimmed) - 1;
      if (!listing2 || Date.now() - listing2.at > 10 * 60 * 1e3) {
        return { error: "\u5E8F\u53F7\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u5148\u6267\u884C /sessions" };
      }
      if (index < 0 || index >= listing2.items.length) return { error: "\u5E8F\u53F7\u8D85\u51FA\u8303\u56F4" };
      const item = listing2.items[index];
      return { sessionId: item.sessionId, title: item.title };
    }
    if (trimmed.length < 4) return { error: "\u8BF7\u63D0\u4F9B\u81F3\u5C11 4 \u4F4D\u4F1A\u8BDD ID \u524D\u7F00\uFF0C\u6216\u5148 /sessions \u518D\u7528\u5E8F\u53F7" };
    const listing = await listSessions(30);
    const hits = listing.filter((item) => item.sessionId.startsWith(trimmed.toLowerCase()));
    if (hits.length === 0) return { error: "\u6CA1\u6709\u5339\u914D\u7684\u4F1A\u8BDD\uFF0C\u8BD5\u8BD5 /sessions \u67E5\u770B\u5217\u8868" };
    if (hits.length > 1) return { error: `\u524D\u7F00\u5339\u914D\u5230 ${hits.length} \u4E2A\u4F1A\u8BDD\uFF0C\u8BF7\u63D0\u4F9B\u66F4\u957F\u524D\u7F00` };
    return { sessionId: hits[0].sessionId, title: hits[0].title };
  }
  const hintCooldown = /* @__PURE__ */ new Map();
  async function handleInbound(inbound) {
    if (!inbound.messageId || !inbound.chatId) return;
    try {
      if (await routeBack.maybeRoute(inbound)) return;
    } catch (error) {
      log(`[dsh-im-notify] route-back error: ${error?.message ?? error}`, "warn");
    }
    const text = stripMentions(inbound.text);
    if (!text.startsWith("/")) {
      const last = hintCooldown.get(inbound.chatId) ?? 0;
      if (Date.now() - last > 6 * 60 * 60 * 1e3 && text) {
        hintCooldown.set(inbound.chatId, Date.now());
        await feishu.replyText(
          inbound.messageId,
          "\u672C\u673A\u5668\u4EBA\u53EA\u505A\u4EFB\u52A1\u5B8C\u6210\u901A\u77E5\u3002\u53D1\u9001 /help \u67E5\u770B\u7528\u6CD5\uFF1B\u5F15\u7528\u63A8\u9001\u6D88\u606F\u53EF\u76F4\u63A5\u5411\u5BF9\u5E94\u4F1A\u8BDD\u4E0B\u8FBE\u6307\u4EE4\u3002"
        );
      }
      return;
    }
    if (!state.isOwner(inbound.senderOpenId)) {
      await feishu.replyText(inbound.messageId, "\u26D4 \u8BE5\u673A\u5668\u4EBA\u4EC5\u9650\u7BA1\u7406\u5458\u4F7F\u7528\u3002");
      return;
    }
    const [command, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ");
    try {
      switch (command) {
        case "/help":
          await feishu.replyText(inbound.messageId, HELP);
          return;
        case "/sessions": {
          const items = await listSessions(15);
          lastListings.set(inbound.chatId, { at: Date.now(), items });
          if (items.length === 0) {
            await feishu.replyText(inbound.messageId, "\u5F53\u524D\u6CA1\u6709\u53EF\u5217\u51FA\u7684\u4F1A\u8BDD\u3002");
            return;
          }
          const lines = items.map((item, index) => `${index + 1}. ${item.title ?? "\uFF08\u65E0\u6807\u9898\uFF09"} \xB7 ${item.workspace} \xB7 ${item.sessionId.slice(0, 8)}\u2026`);
          await feishu.replyText(
            inbound.messageId,
            ["\u6700\u8FD1\u4F1A\u8BDD\uFF08/watch \u5E8F\u53F7 \u5373\u53EF\u5173\u6CE8\uFF09\uFF1A", ...lines].join("\n")
          );
          return;
        }
        case "/watch": {
          if (!arg) {
            await feishu.replyText(inbound.messageId, "\u7528\u6CD5\uFF1A/watch <\u4F1A\u8BDDID\u524D\u7F00 \u6216 /sessions \u5E8F\u53F7>");
            return;
          }
          const resolved = await resolveWatchTarget(inbound.chatId, arg);
          if (resolved.error) {
            await feishu.replyText(inbound.messageId, `\u274C ${resolved.error}`);
            return;
          }
          const snapshot = await gateway.sessionSnapshot(resolved.sessionId, 1, signal);
          state.addWatch({
            chatId: inbound.chatId,
            sessionId: resolved.sessionId,
            title: resolved.title,
            lastSeq: snapshot.cursor,
            replyToMessageId: inbound.messageId,
            watchStartedAt: (/* @__PURE__ */ new Date()).toISOString()
          });
          await feishu.replyText(
            inbound.messageId,
            `\u2B50 \u5DF2\u5173\u6CE8\u300C${resolved.title ?? resolved.sessionId.slice(0, 8)}\u300D\u3002\u4EFB\u52A1\u5B8C\u6210\u540E\u4F1A\u4EE5\u56DE\u590D\u672C\u6761\u6D88\u606F\u7684\u5F62\u5F0F\u63A8\u9001\uFF1B\u5F15\u7528\u63A8\u9001\u53EF\u76F4\u63A5\u5411\u8BE5\u4F1A\u8BDD\u4E0B\u8FBE\u6307\u4EE4\u3002`
          );
          return;
        }
        case "/unwatch": {
          const watches = state.watchesIn(inbound.chatId);
          if (!arg) {
            await feishu.replyText(inbound.messageId, "\u7528\u6CD5\uFF1A/unwatch <\u4F1A\u8BDDID\u524D\u7F00 \u6216 watchlist \u5E8F\u53F7>");
            return;
          }
          const index = /^\d+$/.test(arg) ? Number(arg) - 1 : -1;
          const target = index >= 0 ? watches[index] : void 0;
          if (target) {
            state.removeWatch(inbound.chatId, target.sessionId);
            await feishu.replyText(inbound.messageId, `\u5DF2\u53D6\u6D88\u5173\u6CE8\u300C${target.title ?? target.sessionId.slice(0, 8)}\u300D\u3002`);
            return;
          }
          const hits = watches.filter((watch) => watch.sessionId.startsWith(arg.toLowerCase()));
          if (hits.length === 1) {
            state.removeWatch(inbound.chatId, hits[0].sessionId);
            await feishu.replyText(inbound.messageId, `\u5DF2\u53D6\u6D88\u5173\u6CE8\u300C${hits[0].title ?? hits[0].sessionId.slice(0, 8)}\u300D\u3002`);
          } else {
            await feishu.replyText(inbound.messageId, hits.length === 0 ? "\u6CA1\u6709\u5339\u914D\u7684\u5173\u6CE8\u9879\u3002" : `\u5339\u914D\u5230 ${hits.length} \u4E2A\uFF0C\u8BF7\u63D0\u4F9B\u66F4\u957F\u524D\u7F00\u3002`);
          }
          return;
        }
        case "/watchlist": {
          const watches = state.watchesIn(inbound.chatId);
          if (watches.length === 0) {
            await feishu.replyText(inbound.messageId, "\u672C\u804A\u5929\u8FD8\u6CA1\u6709\u5173\u6CE8\u4EFB\u4F55\u4F1A\u8BDD\u3002/sessions \u67E5\u770B\uFF0C/watch \u5173\u6CE8\u3002");
            return;
          }
          const lines = watches.map((watch, index) => `${index + 1}. ${watch.title ?? watch.sessionId.slice(0, 8)} \xB7 ${watch.sessionId.slice(0, 8)}\u2026${engine.isRunning(watch.sessionId) ? " \xB7 \u{1F3C3} \u8FD0\u884C\u4E2D" : ""}`);
          await feishu.replyText(inbound.messageId, ["\u5173\u6CE8\u7684\u4F1A\u8BDD\uFF1A", ...lines].join("\n"));
          return;
        }
        case "/status": {
          const status = feishu.status;
          await feishu.replyText(inbound.messageId, [
            "dsh-im-notify \u72B6\u6001",
            `\u8FDE\u63A5\uFF1A${status.ready ? "\u2705 \u98DE\u4E66\u957F\u8FDE\u63A5\u6B63\u5E38" : `\u26A0\uFE0F ${status.lastError ?? "\u672A\u8FDE\u63A5"}`}`,
            `\u542F\u52A8\uFF1A${status.startedAt ?? "-"} \xB7 \u6536\u6D88\u606F ${status.messagesReceived} \xB7 \u53D1\u5361\u7247 ${status.cardsSent}`,
            `\u5173\u6CE8\uFF1A${state.watches.length} \u4E2A \xB7 \u56DE\u7A0B\u6620\u5C04\uFF1A${Object.keys(state.mappings).length} \u6761`
          ].join("\n"));
          return;
        }
        default:
          await feishu.replyText(inbound.messageId, `\u672A\u77E5\u547D\u4EE4 ${command}\u3002/help \u67E5\u770B\u7528\u6CD5\u3002`);
      }
    } catch (error) {
      log(`[dsh-im-notify] command ${command} failed: ${error?.message ?? error}`, "warn");
      try {
        await feishu.replyText(inbound.messageId, `\u274C \u547D\u4EE4\u6267\u884C\u5931\u8D25\uFF1A${error?.message ?? error}`);
      } catch {
      }
    }
  }
  engine.start(ctx);
  try {
    await feishu.start(signal);
    log("[dsh-im-notify] started \u2014 feishu long connection ready");
  } catch (error) {
    engine.stop();
    log(`[dsh-im-notify] feishu start failed: ${error?.message ?? error}`, "error");
    throw error;
  }
  const dispose = () => {
    abort.abort(new DOMException("dsh-im-notify disposed", "AbortError"));
    registration.cancel();
    stopSettingsRpc();
    engine.stop();
    feishu.stop();
  };
  if (typeof ctx?.effect === "function") {
    ctx.effect(dispose, "dsh-im-notify: runtime");
  }
  return dispose;
}
export {
  apply,
  inject,
  name
};
