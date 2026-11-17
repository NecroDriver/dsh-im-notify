// dsh-im-notify state — config resolution + persistent watches/mappings.
//
// Layout (all outside the package, survives reinstalls):
//   <dshHome>/integrations/dsh-im-notify/config.json   credentials & options
//   <dshHome>/integrations/dsh-im-notify/state.json    watches + push mappings
//
// dshHome resolution mirrors dsh-im (src/channels/shared/default-workspace.mjs):
//   config.dshHome ?? process.env.DSH_HOME ?? ~/.dsh

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function resolveDshHome(cordisConfig) {
  return cordisConfig?.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

export function stateDirectory(cordisConfig) {
  return resolve(resolveDshHome(cordisConfig), 'integrations', 'dsh-im-notify');
}

const DEFAULTS = {
  domain: 'feishu',
  maxWatchesPerChat: 8,
  mappingTtlMs: 24 * 60 * 60 * 1000,
};

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export class StateStore {
  #dir;
  #configFile;
  #stateFile;
  #saveTimer = null;
  #persistedConfig = null;
  #persisted = '';
  log = () => {};

  /** @param {string} dir state directory */
  constructor(dir, log) {
    this.#dir = dir;
    this.#configFile = join(dir, 'config.json');
    this.#stateFile = join(dir, 'state.json');
    if (log) this.log = log;
    /** runtime config, merged: defaults < config.json < cordis patch config */
    this.config = { ...DEFAULTS };
    /** @type {Array<{chatId:string,sessionId:string,title:string|null,lastSeq:number,replyToMessageId:string|null,watchStartedAt:string}>} */
    this.watches = [];
    /** @type {Record<string,{sessionId:string,title:string|null,at:number}>} messageId → session */
    this.mappings = {};
    /** @type {{chatId:string,replyToMessageId:string|null,startedAt:string}|null} catch-all target */
    this.watchAll = null;
  }

  async load(cordisConfig = {}) {
    await mkdir(this.#dir, { recursive: true });
    const fileConfig = (await readJson(this.#configFile)) ?? {};
    this.config = {
      ...DEFAULTS,
      ...fileConfig,
      // cordis patch `config:` keys win (operator-declared), except dshHome routing
      ...(cordisConfig.appId !== undefined ? { appId: cordisConfig.appId } : {}),
      ...(cordisConfig.appSecret !== undefined ? { appSecret: cordisConfig.appSecret } : {}),
      ...(Array.isArray(cordisConfig.ownerOpenIds) ? { ownerOpenIds: cordisConfig.ownerOpenIds } : {}),
      ...(cordisConfig.domain !== undefined ? { domain: cordisConfig.domain } : {}),
      ...(cordisConfig.maxWatchesPerChat !== undefined
        ? { maxWatchesPerChat: Number(cordisConfig.maxWatchesPerChat) || DEFAULTS.maxWatchesPerChat }
        : {}),
    };
    const state = (await readJson(this.#stateFile)) ?? {};
    this.watches = Array.isArray(state.watches) ? state.watches : [];
    this.mappings = state.mappings && typeof state.mappings === 'object' ? state.mappings : {};
    this.watchAll = state.watchAll && typeof state.watchAll === 'object' && typeof state.watchAll.chatId === 'string'
      ? state.watchAll : null;
    this.#persisted = JSON.stringify(this.#snapshot());
    this.#gcMappings();
    return this;
  }

  get configured() {
    return typeof this.config.appId === 'string' && this.config.appId.trim() !== ''
      && typeof this.config.appSecret === 'string' && this.config.appSecret.trim() !== '';
  }

  isOwner(senderOpenId) {
    const owners = this.config.ownerOpenIds;
    if (!Array.isArray(owners) || owners.length === 0) return true; // open access
    return owners.includes(senderOpenId);
  }

  /**
   * Catch-all watch: when set, sessions with NO explicit watch push here.
   * Explicit watches always win over the catch-all.
   */
  setWatchAll(entry) {
    this.watchAll = entry; // {chatId, replyToMessageId, startedAt} | null
    this.save();
  }

  watchesFor(sessionId) {
    return this.watches.filter((watch) => watch.sessionId === sessionId);
  }

  watchesIn(chatId) {
    return this.watches.filter((watch) => watch.chatId === chatId);
  }

  addWatch(entry) {
    this.watches = this.watches.filter(
      (watch) => !(watch.chatId === entry.chatId && watch.sessionId === entry.sessionId),
    );
    // Enforce a per-chat cap; drop the oldest entries beyond the cap.
    const inChat = this.watchesIn(entry.chatId);
    const cap = this.config.maxWatchesPerChat;
    if (inChat.length >= cap) {
      const drop = [...inChat].sort((a, b) => a.watchStartedAt.localeCompare(b.watchStartedAt))
        .slice(0, Math.max(1, inChat.length - cap + 1));
      const dropSet = new Set(drop);
      this.watches = this.watches.filter((watch) => !dropSet.has(watch));
    }
    this.watches.push(entry);
    this.save();
  }

  removeWatch(chatId, sessionId) {
    const before = this.watches.length;
    this.watches = this.watches.filter(
      (watch) => !(watch.chatId === chatId && watch.sessionId === sessionId),
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
      watchAll: this.watchAll,
      savedAt: new Date().toISOString(),
    };
  }

  /** Debounced atomic save (tmp + rename): state.json AND config.json (credentials). Never throws. */
  save() {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      const json = JSON.stringify(this.#snapshot());
      if (json !== this.#persisted) {
        this.#persisted = json;
        const tmp = `${this.#stateFile}.tmp`;
        Promise.resolve()
          .then(() => writeFile(tmp, json, 'utf8'))
          .then(() => rename(tmp, this.#stateFile))
          .catch((error) => this.log(`[dsh-im-notify] state save failed: ${error?.message ?? error}`, 'warn'));
      }
      const cfgJson = JSON.stringify(this.config, null, 2);
      if (cfgJson !== this.#persistedConfig) {
        this.#persistedConfig = cfgJson;
        const ctmp = `${this.#configFile}.tmp`;
        Promise.resolve()
          .then(() => writeFile(ctmp, cfgJson, 'utf8'))
          .then(() => rename(ctmp, this.#configFile))
          .catch((error) => this.log(`[dsh-im-notify] config save failed: ${error?.message ?? error}`, 'warn'));
      }
    }, 400);
  }
}
