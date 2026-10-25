import test from 'node:test';
import assert from 'node:assert/strict';
import { GuguAgent } from '../src/core/agent.mjs';
import { MemoryStore } from '../src/core/memory-store.mjs';
import { ChannelRegistry } from '../src/channels/registry.mjs';

function fixture(response) {
  const memory = new MemoryStore(':memory:');
  const sent = [];
  const channels = new ChannelRegistry().register({
    id: 'qq', start: async () => {},
    sendOwnerMessage: async (text) => { sent.push(text); return { ok: true }; },
    sendReply: async ({ text }) => { sent.push(text); return { ok: true }; },
  });
  const provider = { complete: async () => typeof response === 'function' ? response() : response };
  const agent = new GuguAgent({ provider, memory, channels, persona: 'Gugu likes finding small wonders.', clock: () => new Date('2026-10-25T03:00:00Z') });
  return { agent, memory, channels, sent };
}

test('replies using persistent local conversation history', async () => {
  const f = fixture('I remember what you told me.');
  const reply = await f.agent.handleInbound({ channel: 'qq', conversationId: 'owner', messageId: 'm1', text: 'remember this' });
  assert.equal(reply.sent, true);
  assert.deepEqual(f.sent, ['I remember what you told me.']);
  assert.deepEqual(f.memory.recentMessages({ channel: 'qq', conversationId: 'owner' }).map((m) => m.role), ['user', 'assistant']);
  f.memory.close();
});

test('heartbeat can choose rest or send a specific message on an available channel', async () => {
  const f = fixture('{"action":"message_owner","channel":"qq","text":"A specific thought","reason":"It matters to share"}');
  const decision = await f.agent.heartbeat();
  assert.equal(decision.action, 'message_owner');
  assert.deepEqual(f.sent, ['A specific thought']);
  assert.equal(f.memory.recentActions()[0].status, 'sent');
  f.memory.close();
});

test('does not overlap heartbeats', async () => {
  let release;
  const f = fixture(() => new Promise((resolve) => { release = resolve; }));
  const active = f.agent.heartbeat();
  await Promise.resolve();
  const second = await f.agent.heartbeat();
  assert.match(second.reason, /still running/);
  release('{"action":"rest","reason":"quiet"}');
  assert.equal((await active).action, 'rest');
  f.memory.close();
});

test('enforces proactive hourly and daily delivery limits', async () => {
  const f = fixture('{"action":"message_owner","channel":"qq","text":"A specific thought","reason":"It matters to share"}');
  // Use a time inside the allowed Japan contact window.
  f.agent.clock = () => new Date('2026-10-25T03:00:00Z');
  const first = await f.agent.heartbeat();
  assert.equal(first.action, 'message_owner');
  const second = await f.agent.heartbeat();
  assert.equal(second.action, 'rest');
  assert.match(second.reason, /cooldown/);
  assert.equal(f.sent.length, 1);
  f.memory.close();
});

test('serializes inbound messages within one conversation', async () => {
  const memory = new MemoryStore(':memory:');
  const requests = [];
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const provider = {
    complete: async ({ messages }) => {
      requests.push(messages.map((message) => `${message.role}:${message.content}`));
      if (requests.length === 1) {
        firstStarted();
        await new Promise((resolve) => { releaseFirst = resolve; });
      }
      return 'reply';
    },
  };
  const channels = new ChannelRegistry().register({ id: 'qq', start: async () => {}, sendOwnerMessage: async () => {}, sendReply: async () => ({ ok: true }) });
  const agent = new GuguAgent({ provider, memory, channels });
  const one = agent.handleInbound({ channel: 'qq', conversationId: 'owner', text: 'one' });
  await started;
  const two = agent.handleInbound({ channel: 'qq', conversationId: 'owner', text: 'two' });
  releaseFirst();
  await Promise.all([one, two]);
  assert.deepEqual(requests[1], ['user:one', 'assistant:reply', 'user:two']);
  memory.close();
});

test('records uncertain delivery when an owner channel cannot confirm sending', async () => {
  const memory = new MemoryStore(':memory:');
  const channels = new ChannelRegistry().register({
    id: 'qq',
    start: async () => {},
    sendOwnerMessage: async () => ({ ok: false, error: 'gateway timeout' }),
    sendReply: async () => ({ ok: true }),
  });
  const agent = new GuguAgent({
    provider: { complete: async () => '{"action":"message_owner","channel":"qq","text":"hello","reason":"update"}' },
    memory,
    channels,
    clock: () => new Date('2026-10-25T03:00:00Z'),
  });
  const result = await agent.heartbeat();
  assert.equal(result.action, 'message_owner');
  assert.equal(result.reason, 'The channel did not confirm delivery.');
  assert.equal(memory.recentActions()[0].status, 'uncertain');
  memory.close();
});

test('performs a read-only Douyin watch and stores its result', async () => {
  const memory = new MemoryStore(':memory:');
  const watchResult = { items: [{ awemeId: '123456789' }] };
  const channels = new ChannelRegistry().register({
    id: 'douyin',
    start: async () => {},
    sendOwnerMessage: async () => ({ ok: true }),
    watch: async () => watchResult,
  });
  const agent = new GuguAgent({
    provider: { complete: async () => '{"action":"watch_douyin","reason":"curious"}' },
    memory,
    channels,
    clock: () => new Date('2026-10-25T03:00:00Z'),
  });
  const result = await agent.heartbeat();
  assert.deepEqual(result.result, watchResult);
  assert.deepEqual(memory.getState('lastDouyinWatch'), watchResult);
  assert.equal(memory.recentActions()[0].status, 'completed');
  memory.close();
});

test('shares only a video present in the latest Douyin watch', async () => {
  const memory = new MemoryStore(':memory:');
  const shares = [];
  const channels = new ChannelRegistry().register({
    id: 'douyin',
    start: async () => {},
    sendOwnerMessage: async () => ({ ok: true }),
    shareVideo: async (payload) => { shares.push(payload); return { ok: true, shared: true }; },
  });
  const agent = new GuguAgent({
    provider: { complete: async () => '{"action":"share_douyin_video","awemeId":"123456789","reason":"send it"}' },
    memory,
    channels,
    clock: () => new Date('2026-10-25T03:00:00Z'),
  });
  const skipped = await agent.heartbeat();
  assert.equal(skipped.action, 'rest');
  assert.deepEqual(shares, []);
  memory.setState('lastDouyinWatch', { picked: [{ url: 'https://www.douyin.com/video/123456789' }] });
  const shared = await agent.heartbeat();
  assert.equal(shared.action, 'share_douyin_video');
  assert.deepEqual(shares, [{ awemeId: '123456789' }]);
  memory.close();
});

test('marks an inbound reply as unsent when the channel does not confirm delivery', async () => {
  const memory = new MemoryStore(':memory:');
  const channels = new ChannelRegistry().register({
    id: 'qq', start: async () => {}, sendOwnerMessage: async () => ({ ok: true }),
    sendReply: async () => ({ ok: false, error: 'gateway timeout' }),
  });
  const agent = new GuguAgent({ provider: { complete: async () => 'reply' }, memory, channels });
  const result = await agent.handleInbound({ channel: 'qq', conversationId: 'owner', messageId: 'm1', text: 'hello' });
  assert.equal(result.sent, false);
  memory.close();
});
