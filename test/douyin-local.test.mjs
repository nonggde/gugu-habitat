import test from 'node:test';
import assert from 'node:assert/strict';
import { DouyinLocalChannel, DOUYIN_LOCAL_ENDPOINTS } from '../src/channels/douyin-local.mjs';

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function fakeService({ contacts, messages, sent = [] }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });
    if (parsed.pathname === DOUYIN_LOCAL_ENDPOINTS.list) {
      return jsonResponse({ ok: true, data: contacts });
    }
    if (parsed.pathname === DOUYIN_LOCAL_ENDPOINTS.read) {
      return jsonResponse({ ok: true, data: messages });
    }
    if (parsed.pathname === DOUYIN_LOCAL_ENDPOINTS.send) {
      const body = JSON.parse(init.body);
      sent.push(body);
      return jsonResponse({ ok: true, sent: true, messageId: 'local-confirmed' });
    }
    return jsonResponse({ error: 'not found' }, 404);
  };
  return { calls, fetchImpl, sent };
}

test('requires exact owner and only permits loopback local service URLs', () => {
  assert.throws(() => new DouyinLocalChannel({ fetchImpl: async () => {} }), /DOUYIN_OWNER_NAME/);
  assert.throws(() => new DouyinLocalChannel({ ownerName: 'Owner', baseUrl: 'https://example.com', fetchImpl: async () => {} }), /loopback/);
});

test('sends only to the exact configured owner using confirmed local API payload', async () => {
  const contacts = [
    { index: 0, name: 'someone else' },
    { index: 1, name: '主人' },
  ];
  const { calls, fetchImpl, sent } = fakeService({ contacts, messages: [] });
  const channel = new DouyinLocalChannel({ ownerName: '主人', fetchImpl });

  const result = await channel.sendOwnerMessage('  看看这个视频  ');
  assert.equal(result.recipient, '主人');
  assert.deepEqual(sent, [{ text: '看看这个视频', index: 1 }]);
  assert.equal(calls[0].url.pathname, DOUYIN_LOCAL_ENDPOINTS.list);
  assert.equal(calls[1].url.pathname, DOUYIN_LOCAL_ENDPOINTS.send);
  assert.equal(calls[1].init.method, 'POST');
});

test('does not send when the configured owner is missing or ambiguous', async () => {
  for (const contacts of [[], [{ index: 0, name: '主人' }, { index: 1, name: '主人' }]]) {
    const { sent, fetchImpl } = fakeService({ contacts, messages: [] });
    const channel = new DouyinLocalChannel({ ownerName: '主人', fetchImpl });
    await assert.rejects(channel.sendOwnerMessage('hello'), /not in the current|ambiguous/);
    assert.deepEqual(sent, []);
  }
});

test('polls only the configured owner and emits only new incoming messages', async () => {
  const contacts = [{ index: 0, name: '主人' }, { index: 1, name: 'other' }];
  let messages = [
    { fromMe: true, text: 'old reply' },
    { fromMe: false, text: 'old message' },
  ];
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    requests.push(parsed);
    if (parsed.pathname === DOUYIN_LOCAL_ENDPOINTS.list) return jsonResponse({ ok: true, data: contacts });
    if (parsed.pathname === DOUYIN_LOCAL_ENDPOINTS.read) return jsonResponse({ ok: true, data: messages });
    return jsonResponse({ ok: true });
  };
  const channel = new DouyinLocalChannel({ ownerName: '主人', fetchImpl, pollIntervalMs: 60_000 });
  const received = [];
  await channel.start(async (event) => received.push(event));
  assert.equal(received.length, 0, 'startup history is baselined, not replayed');

  messages = [
    { fromMe: false, text: 'new question' },
    { fromMe: true, text: 'old reply' },
    { fromMe: false, text: 'old message' },
  ];
  // Use a second channel interval to verify the same polling path without exposing internals.
  await channel.stop();
  const fast = new DouyinLocalChannel({ ownerName: '主人', fetchImpl, pollIntervalMs: 2_000 });
  await fast.start(async (event) => received.push(event));
  assert.equal(received.length, 0, 'restarting creates a fresh baseline');
  messages.unshift({ fromMe: false, text: 'another question' });
  // Timer is unref'ed; wait for the scheduled poll to run once.
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  await fast.stop();
  assert.equal(received.length, 1);
  assert.equal(received[0].channel, 'douyin');
  assert.equal(received[0].conversationId, '主人');
  assert.equal(received[0].text, 'another question');
  assert.ok(received[0].messageId.startsWith('douyin:'));
  assert.ok(requests.filter((url) => url.pathname === DOUYIN_LOCAL_ENDPOINTS.read).every((url) => url.searchParams.get('index') === '0'));
});

test('sendReply rejects non-owner conversations', async () => {
  const { sent, fetchImpl } = fakeService({ contacts: [{ index: 0, name: '主人' }], messages: [] });
  const channel = new DouyinLocalChannel({ ownerName: '主人', fetchImpl });
  await assert.rejects(channel.sendReply({ conversationId: 'someone else', text: 'no' }), /only sends replies to the configured owner/);
  assert.deepEqual(sent, []);
});

test('watch uses the confirmed bounded local endpoint and sharing targets only the owner', async () => {
  const contacts = [{ index: 0, name: '主人' }];
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ parsed, init });
    if (parsed.pathname === DOUYIN_LOCAL_ENDPOINTS.list) return jsonResponse({ ok: true, data: contacts });
    if (parsed.pathname === DOUYIN_LOCAL_ENDPOINTS.watch) return jsonResponse({ ok: true, summary: 'interesting' });
    if (parsed.pathname === DOUYIN_LOCAL_ENDPOINTS.share) return jsonResponse({ ok: true, shared: true });
    return jsonResponse({ ok: false, error: 'unknown' }, 404);
  };
  const channel = new DouyinLocalChannel({ ownerName: '主人', fetchImpl });
  assert.equal((await channel.watch()).summary, 'interesting');
  const shared = await channel.shareVideo({ awemeId: '1234567890123456789' });
  assert.equal(shared.recipient, '主人');
  const watchCall = calls.find(({ parsed }) => parsed.pathname === DOUYIN_LOCAL_ENDPOINTS.watch);
  assert.deepEqual(JSON.parse(watchCall.init.body), { pages: 2, budget: 8 });
  const shareCall = calls.find(({ parsed }) => parsed.pathname === DOUYIN_LOCAL_ENDPOINTS.share);
  assert.deepEqual(JSON.parse(shareCall.init.body), { awemeId: '1234567890123456789', to: '主人' });
  await assert.rejects(channel.shareVideo({ awemeId: 'bad' }), /numeric Douyin awemeId/);
});
