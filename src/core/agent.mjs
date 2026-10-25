import { decisionSystemPrompt, parseDecision } from './decision.mjs';

function observedDouyinIds(value) {
  const ids = new Set();
  const add = (candidate) => {
    const match = String(candidate ?? '').match(/^\d{8,32}$/);
    if (match) ids.add(match[0]);
  };
  const visit = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    add(entry.awemeId);
    add(entry.aweme_id);
    add(entry.id);
    const url = String(entry.url ?? '');
    const urlMatch = url.match(/\/video\/(\d{8,32})(?:\?|$)/);
    if (urlMatch) add(urlMatch[1]);
    for (const key of ['items', 'judged', 'picked', 'videos']) {
      if (Array.isArray(entry[key])) entry[key].forEach(visit);
    }
  };
  visit(value);
  return ids;
}

function deliveryStatus(delivery) {
  return delivery && typeof delivery === 'object' && delivery.ok !== false ? 'sent' : 'uncertain';
}

export class GuguAgent {
  constructor({ provider, memory, channels, persona = '', ownerName = '主人', defaultChannel = 'qq', clock = () => new Date(), proactiveLimitPerDay = 3, proactiveCooldownMs = 60 * 60_000, activeHours = { start: 9, end: 23 }, timeZone = 'Asia/Shanghai' }) {
    if (!provider || typeof provider.complete !== 'function') throw new TypeError('A model provider is required');
    if (!memory || typeof memory.appendMessage !== 'function') throw new TypeError('A memory store is required');
    if (!channels || typeof channels.sendOwnerMessage !== 'function') throw new TypeError('A channel registry is required');
    this.provider = provider;
    this.memory = memory;
    this.channels = channels;
    this.persona = persona;
    this.ownerName = ownerName;
    this.defaultChannel = defaultChannel;
    this.clock = clock;
    this.proactiveLimitPerDay = Math.max(0, Math.floor(Number(proactiveLimitPerDay) || 0));
    this.proactiveCooldownMs = Math.max(0, Number(proactiveCooldownMs) || 0);
    this.activeHours = activeHours;
    this.timeZone = timeZone;
    this.busy = false;
    this.conversationQueues = new Map();
  }

  proactiveGate() {
    if (this.proactiveLimitPerDay === 0) return { allowed: false, reason: 'Proactive messaging is disabled.' };
    const now = this.clock();
    const localHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: this.timeZone, hour: '2-digit', hour12: false }).format(now));
    if (localHour < this.activeHours.start || localHour >= this.activeHours.end) {
      return { allowed: false, reason: 'Outside the configured proactive contact hours.' };
    }
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const actions = this.memory.recentActions(500).filter((entry) =>
      ['message_owner', 'share_douyin_video'].includes(entry.action) && ['sent', 'uncertain'].includes(entry.status));
    const todays = actions.filter((entry) => new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(entry.createdAt)) === today);
    if (todays.length >= this.proactiveLimitPerDay) return { allowed: false, reason: 'The daily proactive message limit has been reached.' };
    const last = actions.at(-1);
    if (last && now.getTime() - new Date(last.createdAt).getTime() < this.proactiveCooldownMs) {
      return { allowed: false, reason: 'The proactive contact cooldown has not elapsed.' };
    }
    return { allowed: true };
  }

  async handleInbound(event) {
    const channel = String(event?.channel || '').trim();
    const conversationId = String(event?.conversationId || '').trim();
    const text = String(event?.text || '').trim();
    if (!channel || !conversationId || !text) throw new TypeError('Inbound event requires channel, conversationId, and text');
    const key = `${channel}\0${conversationId}`;
    const previous = this.conversationQueues.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.conversationQueues.set(key, queued);
    await previous;
    try {
      return await this.#handleInbound({ ...event, channel, conversationId, text });
    } finally {
      release();
      if (this.conversationQueues.get(key) === queued) this.conversationQueues.delete(key);
    }
  }

  async #handleInbound(event) {
    const { channel, conversationId, text } = event;
    const receivedAt = event.receivedAt || this.clock().toISOString();
    this.memory.appendMessage({ channel, conversationId, role: 'user', content: text, createdAt: receivedAt });
    const history = this.memory.recentMessages({ channel, conversationId, limit: 20 });
    const answer = await this.provider.complete({
      system: `${this.persona}\n\nYou are replying to ${this.ownerName}. Use the supplied tools only when explicitly available.`,
      messages: history.map(({ role, content }) => ({ role, content })),
    });
    this.memory.appendMessage({ channel, conversationId, role: 'assistant', content: answer, createdAt: this.clock().toISOString() });
    const adapter = this.channels.get?.(channel);
    if (!adapter || typeof adapter.sendReply !== 'function') {
      return { text: answer, sent: false, reason: `Channel ${channel} cannot send replies` };
    }
    try {
      const delivery = await adapter.sendReply({ conversationId, replyTo: event.messageId, text: answer });
      const status = deliveryStatus(delivery);
      this.memory.appendAction({
        action: 'reply_owner', reason: status === 'sent' ? 'Inbound owner message answered.' : 'The channel did not confirm reply delivery.',
        channel, status, createdAt: this.clock().toISOString(),
      });
      return { text: answer, sent: status === 'sent', delivery };
    } catch (error) {
      this.memory.appendAction({
        action: 'reply_owner', reason: `Reply delivery failed (${error.message})`, channel, status: 'uncertain', createdAt: this.clock().toISOString(),
      });
      throw error;
    }
  }

  async heartbeat() {
    if (this.autonomyPaused) return { action: 'rest', reason: 'Autonomous heartbeats are paused.' };
    if (this.busy) return { action: 'rest', reason: 'A previous heartbeat is still running.' };
    this.busy = true;
    try {
      const availableChannels = this.channels.ids?.() ?? [];
      const context = {
        at: this.clock().toISOString(),
        recentMessages: this.memory.recentAcrossChannels(20),
        recentActions: this.memory.recentActions(10),
        recentDouyinFindings: this.memory.getState('lastDouyinWatch', null),
      };
      const raw = await this.provider.complete({
        system: decisionSystemPrompt({ persona: this.persona, ownerName: this.ownerName, channels: availableChannels }),
        messages: [{ role: 'user', content: JSON.stringify(context) }],
        maxTokens: 500,
      });
      const decision = parseDecision(raw);
      if (this.autonomyPaused) {
        this.memory.appendAction({ action: decision.action, reason: 'Autonomy was paused before the action started.', status: 'skipped', createdAt: this.clock().toISOString() });
        return { action: 'rest', reason: 'Autonomous heartbeats are paused.' };
      }
      if (decision.action === 'watch_douyin') {
        const douyin = this.channels.get?.('douyin');
        if (!douyin || typeof douyin.watch !== 'function') {
          this.memory.appendAction({ action: decision.action, reason: 'The Douyin read-only tool is not configured.', status: 'skipped', createdAt: this.clock().toISOString() });
          return { action: 'rest', reason: 'The Douyin read-only tool is not configured.' };
        }
        const result = await douyin.watch();
        this.memory.appendAction({ action: decision.action, reason: decision.reason, channel: 'douyin', status: 'completed', createdAt: this.clock().toISOString() });
        this.memory.setState('lastDouyinWatch', result);
        return { ...decision, result };
      }
      if (decision.action === 'share_douyin_video') {
        const findings = this.memory.getState('lastDouyinWatch', null);
        if (!observedDouyinIds(findings).has(decision.awemeId)) {
          this.memory.appendAction({
            action: decision.action,
            reason: `${decision.reason} (The video was not present in the latest Douyin watch.)`,
            status: 'skipped',
            createdAt: this.clock().toISOString(),
          });
          return { action: 'rest', reason: 'The video was not present in the latest Douyin watch.' };
        }
        const gate = this.proactiveGate();
        const douyin = this.channels.get?.('douyin');
        if (!gate.allowed) {
          this.memory.appendAction({ action: decision.action, reason: `${decision.reason} (${gate.reason})`, status: 'skipped', createdAt: this.clock().toISOString() });
          return { action: 'rest', reason: gate.reason };
        }
        if (!douyin || typeof douyin.shareVideo !== 'function') {
          this.memory.appendAction({ action: decision.action, reason: 'The Douyin video-sharing tool is not configured.', status: 'skipped', createdAt: this.clock().toISOString() });
          return { action: 'rest', reason: 'The Douyin video-sharing tool is not configured.' };
        }
        try {
          const delivery = await douyin.shareVideo({ awemeId: decision.awemeId });
          const status = deliveryStatus(delivery) === 'uncertain' || delivery?.shared === false ? 'uncertain' : 'sent';
          this.memory.appendAction({ action: decision.action, reason: decision.reason, channel: 'douyin', status, createdAt: this.clock().toISOString() });
          return { ...decision, delivery, ...(status === 'uncertain' ? { reason: 'Douyin did not confirm the share.' } : {}) };
        } catch (error) {
          this.memory.appendAction({ action: decision.action, reason: `${decision.reason} (${error.message})`, channel: 'douyin', status: 'uncertain', createdAt: this.clock().toISOString() });
          throw error;
        }
      }
      if (decision.action === 'message_owner') {
        const gate = this.proactiveGate();
        if (!gate.allowed) {
          this.memory.appendAction({ action: 'message_owner', reason: `${decision.reason} (${gate.reason})`, status: 'skipped', createdAt: this.clock().toISOString() });
          return { action: 'rest', reason: gate.reason };
        }
        const channel = decision.channel || this.defaultChannel;
        if (!availableChannels.includes(channel)) {
          this.memory.appendAction({ action: 'message_owner', reason: `The selected channel is unavailable: ${channel}`, status: 'skipped', createdAt: this.clock().toISOString() });
          return { action: 'rest', reason: `The selected channel is unavailable: ${channel}` };
        }
        try {
          const delivery = await this.channels.sendOwnerMessage(channel, decision.text);
          const status = deliveryStatus(delivery);
          this.memory.appendAction({ action: decision.action, reason: decision.reason, channel, status, createdAt: this.clock().toISOString() });
          return { ...decision, channel, delivery, ...(status === 'uncertain' ? { reason: 'The channel did not confirm delivery.' } : {}) };
        } catch (error) {
          this.memory.appendAction({ action: decision.action, reason: `${decision.reason} (${error.message})`, channel, status: 'uncertain', createdAt: this.clock().toISOString() });
          throw error;
        }
      }
      this.memory.appendAction({ action: decision.action, reason: decision.reason, status: 'recorded', createdAt: this.clock().toISOString() });
      if (decision.action === 'reflect') {
        this.memory.setState('lastReflection', { text: decision.reason, at: this.clock().toISOString() });
      }
      return decision;
    } finally {
      this.busy = false;
    }
  }
}
