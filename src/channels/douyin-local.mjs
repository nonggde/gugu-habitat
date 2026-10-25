import { createHash } from 'node:crypto';

export const DOUYIN_LOCAL_ENDPOINTS = Object.freeze({
  list: '/api/im/list',
  read: '/api/im/read',
  send: '/api/im/send',
  watch: '/api/watch/light',
  share: '/api/share',
});

function normalizeBaseUrl(value) {
  const url = new URL(String(value || 'http://127.0.0.1:7861'));
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new TypeError('The local Douyin adapter only accepts a loopback service URL');
  }
  return url.toString().replace(/\/$/, '');
}

function messageKey(message) {
  return JSON.stringify({ fromMe: Boolean(message?.fromMe), text: String(message?.text ?? '') });
}

function overlapSize(previous, current) {
  const max = Math.min(previous.length, current.length);
  for (let size = max; size > 0; size--) {
    let matches = true;
    for (let i = 0; i < size; i++) {
      if (previous[previous.length - size + i] !== current[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return size;
  }
  return 0;
}

export class DouyinLocalChannel {
  constructor({
    baseUrl = process.env.DOUYIN_BASE_URL || 'http://127.0.0.1:7861',
    ownerName = process.env.DOUYIN_OWNER_NAME,
    fetchImpl = globalThis.fetch,
    pollIntervalMs = 15_000,
    requestTimeoutMs = 20_000,
    onError = (error) => console.error('[douyin-local]', error),
    clock = () => new Date(),
  } = {}) {
    if (!String(ownerName || '').trim()) throw new TypeError('DOUYIN_OWNER_NAME must be set to the exact owner conversation name');
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
    if (!Number.isFinite(Number(pollIntervalMs)) || Number(pollIntervalMs) < 2_000) {
      throw new RangeError('pollIntervalMs must be at least 2000 ms');
    }
    this.id = 'douyin';
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.ownerName = String(ownerName).trim();
    this.fetch = fetchImpl;
    this.pollIntervalMs = Number(pollIntervalMs);
    this.requestTimeoutMs = Number(requestTimeoutMs);
    this.onError = onError;
    this.clock = clock;
    this.timer = null;
    this.controller = null;
    this.onMessage = null;
    this.stopped = true;
    this.polling = false;
    this.previousSnapshot = null;
    this.eventSequence = 0;
  }

  async start(onMessage) {
    if (typeof onMessage !== 'function') throw new TypeError('start() requires an onMessage callback');
    if (!this.stopped) return;
    this.onMessage = onMessage;
    this.stopped = false;
    // Establish a baseline without replaying historical DMs after startup.
    await this.#pollSafely();
    if (!this.stopped) {
      this.timer = setInterval(() => void this.#pollSafely(), this.pollIntervalMs);
      this.timer.unref?.();
    }
  }

  async sendOwnerMessage(text) {
    return this.#sendToOwner(text);
  }

  async sendReply({ conversationId, text } = {}) {
    if (String(conversationId || '') !== this.ownerName) {
      throw new Error('Douyin adapter only sends replies to the configured owner conversation');
    }
    return this.#sendToOwner(text);
  }

  async watch() {
    return this.#request(DOUYIN_LOCAL_ENDPOINTS.watch, { method: 'POST', body: { pages: 2, budget: 8 } });
  }

  async shareVideo({ awemeId } = {}) {
    const id = String(awemeId ?? '').trim();
    if (!/^\d{8,32}$/.test(id)) throw new TypeError('A numeric Douyin awemeId is required');
    await this.#ownerContact();
    return this.#request(DOUYIN_LOCAL_ENDPOINTS.share, {
      method: 'POST',
      body: { awemeId: id, to: this.ownerName },
    }).then((result) => ({ ...result, recipient: this.ownerName }));
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.onMessage = null;
  }

  async #request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(new Error('Local Douyin service request timed out')), this.requestTimeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`Local Douyin service returned invalid JSON (${method} ${path})`);
      }
      if (!response.ok || payload?.ok === false || payload?.error) {
        throw new Error(String(payload?.error || `Local Douyin service returned HTTP ${response.status}`));
      }
      return payload;
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = null;
    }
  }

  async #ownerContact() {
    const payload = await this.#request(DOUYIN_LOCAL_ENDPOINTS.list);
    const contacts = payload?.data;
    if (!Array.isArray(contacts)) throw new Error('Local Douyin /api/im/list response did not contain a data array');
    const matches = contacts.filter((contact) => String(contact?.name || '').trim() === this.ownerName);
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `Configured owner conversation “${this.ownerName}” is not in the current Douyin inbox`
        : `Owner conversation name “${this.ownerName}” is ambiguous in the Douyin inbox`);
    }
    const index = Number(matches[0].index);
    if (!Number.isInteger(index) || index < 0) throw new Error('Owner conversation has an invalid inbox index');
    return { ...matches[0], index };
  }

  async #sendToOwner(text) {
    const cleanText = String(text || '').trim();
    if (!cleanText) throw new TypeError('Douyin message text is required');
    const owner = await this.#ownerContact();
    const result = await this.#request(DOUYIN_LOCAL_ENDPOINTS.send, {
      method: 'POST',
      body: { text: cleanText, index: owner.index },
    });
    return { ...result, recipient: this.ownerName };
  }

  async #pollSafely() {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      await this.#pollOwnerInbox();
    } catch (error) {
      if (!this.stopped) this.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.polling = false;
    }
  }

  async #pollOwnerInbox() {
    const owner = await this.#ownerContact();
    const response = await this.#request(`${DOUYIN_LOCAL_ENDPOINTS.read}?index=${owner.index}`);
    if (!Array.isArray(response?.data)) throw new Error('Local Douyin /api/im/read response did not contain a data array');
    // The local service returns the newest message first. Normalize to
    // chronological order before snapshot diffing so new inbound messages
    // append at the end of the sequence.
    const messages = [...response.data].reverse()
      .filter((message) => message && typeof message.text === 'string')
      .map((message) => ({ fromMe: Boolean(message.fromMe), text: message.text.trim().slice(0, 500) }))
      .filter((message) => message.text);
    const current = messages.map(messageKey);
    const previous = this.previousSnapshot;
    this.previousSnapshot = current;
    // No message IDs or timestamps are exposed by the current local service.
    // Diff chronological message snapshots, and fail closed when there is no overlap.
    if (previous === null || this.stopped || !this.onMessage) return;
    const overlap = overlapSize(previous, current);
    if (overlap === 0) return;
    for (const message of messages.slice(overlap)) {
      if (message.fromMe || this.stopped || !this.onMessage) continue;
      this.eventSequence += 1;
      const digest = createHash('sha256')
        .update(`${this.ownerName}\0${message.text}\0${this.eventSequence}`)
        .digest('hex').slice(0, 20);
      await this.onMessage({
        channel: this.id,
        conversationId: this.ownerName,
        messageId: `douyin:${digest}`,
        text: message.text,
        receivedAt: this.clock().toISOString(),
      });
    }
  }
}

export function createDouyinLocalChannel(options) {
  return new DouyinLocalChannel(options);
}
