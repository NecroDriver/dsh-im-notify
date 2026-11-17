// dsh-im-notify route-back — quote-reply round trip.
//
// Every completion push registers {pushed message_id → sessionId} in the state
// store. When an inbound message has parent_id/root_id matching a live mapping,
// its text is submitted straight into that session via gateway.prompt:
//   idle session  → mode 'queue' (the next prompt resumes its Agent)
//   running turn  → mode 'steer' (injected as a steering instruction)
// The user gets a receipt reply on their own message.

export class RouteBack {
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
      await this.#feishu.replyText(inbound.messageId,
        '引用了任务通知，但没有文字内容。请引用通知消息并直接输入要发给该会话的指令。');
      return true;
    }

    const mode = this.#engine.isRunning(mapping.sessionId) ? 'steer' : 'queue';
    try {
      await this.#gateway.prompt(mapping.sessionId, text, { mode });
    } catch (error) {
      this.#log(`[dsh-im-notify] route-back prompt failed: ${error?.message ?? error}`, 'warn');
      await this.#feishu.replyText(inbound.messageId,
        `❌ 送达失败（${error?.message ?? error}）。会话可能已被清理，请用 /watchlist 检查。`);
      return true;
    }

    const label = mapping.title ?? mapping.sessionId.slice(0, 8);
    await this.#feishu.replyText(
      inbound.messageId,
      mode === 'steer'
        ? `✅ 已作为补充指令注入运行中的会话「${label}」`
        : `✅ 已送达会话「${label}」并开始处理，完成后会再推送`,
    );
    return true;
  }
}
