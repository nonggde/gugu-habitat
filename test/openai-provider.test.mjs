import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from '../src/core/openai-provider.mjs';

test('sends a chat completion request to an OpenAI-compatible endpoint', async () => {
  let request;
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://example.test/v1/', apiKey: 'test-secret', model: 'test-model',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'Hello' } }] }) };
    },
  });
  const answer = await provider.complete({ system: 'persona', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(answer, 'Hello');
  assert.equal(request.url, 'https://example.test/v1/chat/completions');
  assert.equal(request.init.headers.authorization, 'Bearer test-secret');
  assert.deepEqual(JSON.parse(request.init.body).messages, [
    { role: 'system', content: 'persona' }, { role: 'user', content: 'hi' },
  ]);
  assert.deepEqual(JSON.parse(request.init.body).thinking, { type: 'disabled' });
});

test('does not silently accept empty or failed model responses', async () => {
  const empty = new OpenAICompatibleProvider({
    baseUrl: 'https://example.test/v1', apiKey: 'x', model: 'm',
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '' } }] }) }),
  });
  await assert.rejects(empty.complete({ system: '', messages: [] }), /no text/i);
  const failed = new OpenAICompatibleProvider({
    baseUrl: 'https://example.test/v1', apiKey: 'x', model: 'm',
    fetchImpl: async () => ({ ok: false, status: 429 }),
  });
  await assert.rejects(failed.complete({ system: '', messages: [] }), /429/);
});

test('accepts gateways that return SSE despite stream:false', async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://example.test/v1', apiKey: 'x', model: 'm',
    fetchImpl: async () => ({
      ok: true,
      text: async () => 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n',
    }),
  });
  assert.equal(await provider.complete({ system: '', messages: [] }), 'hello world');
});
