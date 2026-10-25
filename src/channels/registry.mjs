export class ChannelRegistry {
  #channels = new Map();

  register(channel) {
    if (!channel || !/^[a-z][a-z0-9_-]*$/.test(String(channel.id || ''))) {
      throw new TypeError('A channel must have a lowercase id');
    }
    if (typeof channel.start !== 'function' || typeof channel.sendOwnerMessage !== 'function') {
      throw new TypeError('A channel must implement start() and sendOwnerMessage()');
    }
    if (this.#channels.has(channel.id)) throw new Error(`Channel already registered: ${channel.id}`);
    this.#channels.set(channel.id, channel);
    return this;
  }

  get(id) {
    return this.#channels.get(id);
  }

  ids() {
    return [...this.#channels.keys()];
  }

  async startAll(onMessage) {
    const started = [];
    try {
      for (const channel of this.#channels.values()) {
        await channel.start(onMessage);
        started.push(channel);
      }
    } catch (error) {
      await Promise.allSettled(started.map((channel) => channel.stop?.()));
      throw error;
    }
    return async () => {
      await Promise.allSettled(started.map((channel) => channel.stop?.()));
    };
  }

  async sendOwnerMessage(id, text) {
    const channel = this.#channels.get(id);
    if (!channel) throw new Error(`Channel is unavailable: ${id}`);
    return channel.sendOwnerMessage(String(text));
  }
}
