/**
 * Official QQ Bot channel adapter.
 *
 * The SDK is loaded only when this adapter starts. That keeps the core
 * installable and makes this boundary straightforward to test without QQ
 * credentials or a network connection.
 */

const DEFAULT_SDK_FACTORY = async () => {
  const sdk = await import('@tencent-connect/qqbot-nodejs');
  return sdk.QQBot;
};

function required(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

/**
 * Create a channel backed by Tencent's official QQ Bot Open Platform SDK.
 *
 * `sdkFactory` is intentionally injectable: production uses the SDK class,
 * while tests can provide a fake constructor and never contact QQ.
 */
export function createOfficialQQChannel({
  appId = process.env.QQBOT_APP_ID,
  appSecret = process.env.QQBOT_APP_SECRET,
  ownerId = process.env.QQBOT_OWNER_ID,
  sdkFactory = DEFAULT_SDK_FACTORY,
  logger = console,
} = {}) {
  const config = {
    appId: required(appId, 'QQBOT_APP_ID'),
    appSecret: required(appSecret, 'QQBOT_APP_SECRET'),
    ownerId: required(ownerId, 'QQBOT_OWNER_ID'),
  };
  if (typeof sdkFactory !== 'function') throw new TypeError('sdkFactory must be a function');

  let bot = null;
  let startTask = null;
  let stopped = false;
  let onMessage = () => {};

  const channel = {
    id: 'qq',

    async start(messageHandler = () => {}) {
      if (typeof messageHandler !== 'function') throw new TypeError('messageHandler must be a function');
      if (stopped) throw new Error('QQ channel has been stopped');
      onMessage = messageHandler;
      if (bot) return;

      const QQBot = await sdkFactory();
      if (typeof QQBot !== 'function') throw new TypeError('sdkFactory must resolve to the QQBot constructor');
      bot = new QQBot({
        appId: config.appId,
        appSecret: config.appSecret,
        transport: 'websocket',
        logger,
      });
      if (!bot || typeof bot.on !== 'function' || typeof bot.start !== 'function' || typeof bot.stop !== 'function' || typeof bot.sendText !== 'function') {
        throw new TypeError('QQBot instance does not implement the required SDK methods');
      }

      bot.on('message', async (_ctx, message) => {
        // This first adapter intentionally handles only the owner’s private
        // messages. Group traffic and other users remain out of the core.
        if (message?.kind !== 'c2c' || String(message.senderId ?? '') !== config.ownerId) return;
        const text = String(message.content ?? '').trim();
        if (!text) return;
        await onMessage({
          channel: 'qq',
          conversationId: config.ownerId,
          messageId: String(message.messageId ?? ''),
          text,
          receivedAt: message.timestamp || new Date().toISOString(),
        });
      });

      // QQBot.start() is the long-lived WebSocket lifecycle promise. The core
      // must keep booting while that promise runs in the background.
      startTask = Promise.resolve(bot.start()).catch((error) => {
        logger.error?.(`[gugu-qq] gateway stopped: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      });
      // Prevent a rejected lifecycle promise from becoming an unhandled
      // rejection when the caller only uses the channel contract.
      startTask.catch(() => {});
    },

    async sendOwnerMessage(text) {
      if (!bot) throw new Error('QQ channel is not started');
      const content = required(text, 'text');
      return bot.sendText({ scope: 'c2c', targetId: config.ownerId }, content);
    },

    async sendReply({ conversationId, replyTo, text } = {}) {
      if (!bot) throw new Error('QQ channel is not started');
      if (String(conversationId ?? '') !== config.ownerId) throw new Error('QQ reply target is not the configured owner');
      const content = required(text, 'text');
      const target = { scope: 'c2c', targetId: config.ownerId };
      if (replyTo) target.msgId = String(replyTo);
      return bot.sendText(target, content);
    },

    async stop() {
      stopped = true;
      if (!bot) return;
      const current = bot;
      bot = null;
      startTask = null;
      await current.stop();
    },
  };

  return channel;
}

export function officialQQConfigFromEnv(env = process.env) {
  return {
    appId: String(env.QQBOT_APP_ID ?? '').trim(),
    appSecret: String(env.QQBOT_APP_SECRET ?? '').trim(),
    ownerId: String(env.QQBOT_OWNER_ID ?? '').trim(),
  };
}
