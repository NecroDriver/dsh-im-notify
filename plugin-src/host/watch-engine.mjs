// dsh-im-notify watch engine — the completion pump.
//
// Subscribes to the Host-wide session event stream
//   ctx.on('session/event', (session, event) => ..., { global: true })
// (verified in dsh-im plugin-src/host/modern-harness-api.mjs:279) and pushes a
// card for every watched session's `turn/end` event. seq cursors dedupe pushes
// and drive the restart compensation pass (session.follow snapshot scan).

export class WatchEngine {
  #state;
  #gateway;
  #deliver;
  #log;
  #dispose = null;
  #runningStarts = new Map(); // sessionId → turn/start time (ms)
  /** @type {Set<string>} sessions with a turn in flight */
  #running = new Set();
  // sessionId → { answer, label } — spoken text harvested live from the event
  // stream. turn/end reads it directly: no snapshot round-trip, no races.
  #spoken = new Map();
  #started = false;

  /**
   * @param {{
   *   state: import('./state.mjs').StateStore,
   *   gateway: Awaited<ReturnType<import('./gateway.mjs').createGateway>>,
   *   deliver: (arg: {sessionId:string,title:string|null,summary:string|null,chatId:string,replyToMessageId:string|null,kind:string,startedAt:number|null,note?:string}) => Promise<void>,
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

  #rememberSpoken(sessionId, key, value) {
    let entry = this.#spoken.get(sessionId);
    if (!entry) {
      entry = { answer: null, label: null };
      this.#spoken.set(sessionId, entry);
      // cheap cap: drop the oldest half when the map grows unbounded
      if (this.#spoken.size > 400) {
        const drop = Math.floor(this.#spoken.size / 2);
        let i = 0;
        for (const k of this.#spoken.keys()) {
          if (i++ >= drop) break;
          this.#spoken.delete(k);
        }
      }
    }
    entry[key] = value;
  }

  start(ctx) {
    if (this.#started || typeof ctx?.on !== 'function') return;
    this.#dispose = ctx.on('session/event', (session, event) => {
      try {
        this.handle(session, event);
      } catch (error) {
        this.#log(`[dsh-im-notify] event handler error: ${error?.message ?? error}`, 'warn');
      }
    }, { global: true });
    this.#started = true;
  }

  stop() {
    if (this.#dispose) {
      try { this.#dispose(); } catch { /* best effort */ }
      this.#dispose = null;
    }
    this.#started = false;
    this.#spoken.clear();
  }

  handle(session, event) {
    const sessionId = session?.id;
    if (typeof sessionId !== 'string' || !event || typeof event !== 'object') return;

    // Harvest spoken text from the live stream BEFORE any early return so every
    // session's final answer is available the moment its turn ends. Records:
    // {type:'assistant/message'|'user/message', data:{message:{content:[blocks]}}};
    // only {type:'text'} blocks are spoken — tool-call/reasoning are skipped.
    if (event.type === 'assistant/message' || event.type === 'user/message') {
      const blocks = event.data?.message?.content;
      if (Array.isArray(blocks)) {
        const spoken = blocks
          .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
          .trim();
        if (spoken) {
          if (event.type === 'assistant/message') {
            this.#rememberSpoken(sessionId, 'answer', spoken);
          } else {
            this.#rememberSpoken(sessionId, 'label', spoken.replace(/\s+/g, ' ').slice(0, 60));
          }
        }
      }
    }

    const watches = this.#state.watchesFor(sessionId);
    // Explicit watches always win; only sessions with none fall through to the
    // catch-all (/watchall) target.
    const catchAll = watches.length === 0 ? this.#state.watchAll : null;
    if (watches.length === 0 && !catchAll) return;
    const targets = watches.length > 0
      ? watches.map((watch) => ({ chatId: watch.chatId, replyToMessageId: watch.replyToMessageId, title: watch.title ?? null }))
      : [{ chatId: catchAll.chatId, replyToMessageId: catchAll.replyToMessageId, title: null }];

    if (watches.length > 0) {
      const seq = Number.isSafeInteger(event.seq) ? event.seq : null;
      if (seq !== null) {
        const maxKnown = Math.max(...watches.map((watch) => Number.isSafeInteger(watch.lastSeq) ? watch.lastSeq : -1));
        if (seq <= maxKnown) return; // duplicate / already compensated
        if (seq > maxKnown + 1 && maxKnown >= 0) {
          // Gap: we missed events (host restart while plugin down). Pushing from
          // here is still correct for turn/end; compensation covers the rest.
        }
      }
    }

    if (event.type === 'turn/start') {
      const startedAt = typeof event.time === 'number' ? event.time : Date.now();
      this.#runningStarts.set(sessionId, startedAt);
      this.#running.add(sessionId);
      return;
    }
    if (event.type !== 'turn/end') return;

    const startedAt = this.#runningStarts.get(sessionId) ?? null;
    this.#runningStarts.delete(sessionId);
    this.#running.delete(sessionId);
    const kind = event.data?.reason?.kind ?? 'completed';
    const spoken = this.#spoken.get(sessionId) ?? {};
    for (const target of targets) {
      void Promise.resolve()
        .then(() => this.#deliver({
          sessionId,
          title: target.title,
          summary: spoken.answer ?? null,
          fallbackTitle: spoken.label ?? null,
          chatId: target.chatId,
          replyToMessageId: target.replyToMessageId,
          kind,
          startedAt,
        }))
        .catch((error) => this.#log(`[dsh-im-notify] deliver failed: ${error?.message ?? error}`, 'warn'));
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
          this.#log(`[dsh-im-notify] watch ${watch.sessionId} no longer resolvable; keeping but flagging`, 'warn');
          this.#state.updateWatch(watch.sessionId, { title: '⚠️ 会话不可用' });
          continue;
        }
        const missed = [];
        for (const record of Array.isArray(snapshot.records) ? snapshot.records : []) {
          const event = record?.event ?? record;
          if (event?.type !== 'turn/end') continue;
          if (Number.isSafeInteger(event.seq) && event.seq > watch.lastSeq) missed.push(event);
        }
        const title = typeof header.title === 'string' && header.title ? header.title : watch.title;
        for (const event of missed.slice(-3)) {
          await this.#deliver({
            sessionId: watch.sessionId,
            title,
            chatId: watch.chatId,
            replyToMessageId: watch.replyToMessageId,
            kind: event.data?.reason?.kind ?? 'completed',
            startedAt: null,
            note: missed.length > 3 ? `（重启补发，共 ${missed.length} 条，仅显示最近 3 条）` : '（重启补发）',
          });
        }
        this.#state.updateWatch(watch.sessionId, { lastSeq: snapshot.cursor, title });
      } catch (error) {
        this.#log(`[dsh-im-notify] compensate failed for ${watch.sessionId}: ${error?.message ?? error}`, 'warn');
      }
    }
  }
}
