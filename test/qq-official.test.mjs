import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfficialQQChannel, officialQQConfigFromEnv } from '../src/channels/qq-official.mjs';

function fakeSdk() {
  const instances = [];
  class FakeQQBot {
    constructor(options) {
      this.options = options;
      this.handlers = new Map();
      this.sent = [];
      this.started = 0;
      this.stopped = 0;
      instances.push(this);
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    async start() {
      this.started += 1;
      return new Promise(() => {});
    }
    async stop() {
      this.stopped += 1;
    }
    async sendText(target, content) {
      this.sent.push({ target, content });
      return { id: `sent-${this.sent.length}` };
    }
    async emitMessage(message) {
      await this.handlers.get('message')?.({}, message);
    }
  }
  return { QQBot: FakeQQBot, instances };
}

test('official QQ channel uses websocket SDK and routes only owner C2C messages', async () => {
  const sdk = fakeSdk();
  const received = [];
  const channel = createOfficialQQChannel({
    appId: 'app', appSecret: 'secret', ownerId: 'owner',
    sdkFactory: async () => sdk.QQBot,
    logger: { error() {} },
  });
  await channel.start((event) => received.push(event));
  const bot = sdk.instances[0];
  assert.equal(bot.options.transport, 'websocket');
  assert.equal(bot.options.appId, 'app');
  assert.equal(bot.started, 1);

  await bot.emitMessage({ kind: 'group', senderId: 'owner', content: 'ignore group', messageId: 'g1' });
  await bot.emitMessage({ kind: 'c2c', senderId: 'other', content: 'ignore other', messageId: 'o1' });
  await bot.emitMessage({ kind: 'c2c', senderId: 'owner', content: '  hello  ', messageId: 'm1', timestamp: '2026-10-25T10:00:00.000Z' });
  assert.deepEqual(received, [{
    channel: 'qq', conversationId: 'owner', messageId: 'm1', text: 'hello', receivedAt: '2026-10-25T10:00:00.000Z',
  }]);
});

test('owner messages are proactive and replies retain the inbound message id', async () => {
  const sdk = fakeSdk();
  const channel = createOfficialQQChannel({ appId: 'app', appSecret: 'secret', ownerId: 'owner', sdkFactory: async () => sdk.QQBot });
  await channel.start();
  const bot = sdk.instances[0];
  await channel.sendOwnerMessage('autonomous hello');
  await channel.sendReply({ conversationId: 'owner', replyTo: 'm9', text: 'reply hello' });
  assert.deepEqual(bot.sent, [
    { target: { scope: 'c2c', targetId: 'owner' }, content: 'autonomous hello' },
    { target: { scope: 'c2c', targetId: 'owner', msgId: 'm9' }, content: 'reply hello' },
  ]);
});

test('channel rejects invalid reply targets and stops the SDK', async () => {
  const sdk = fakeSdk();
  const channel = createOfficialQQChannel({ appId: 'app', appSecret: 'secret', ownerId: 'owner', sdkFactory: async () => sdk.QQBot });
  await channel.start();
  await assert.rejects(channel.sendReply({ conversationId: 'other', text: 'nope' }), /configured owner/);
  const bot = sdk.instances[0];
  await channel.stop();
  assert.equal(bot.stopped, 1);
  await assert.rejects(channel.sendOwnerMessage('after stop'), /not started/);
});

test('environment helper reads only QQ credentials', () => {
  assert.deepEqual(officialQQConfigFromEnv({ QQBOT_APP_ID: ' a ', QQBOT_APP_SECRET: ' b ', QQBOT_OWNER_ID: ' c ' }), {
    appId: 'a', appSecret: 'b', ownerId: 'c',
  });
});
