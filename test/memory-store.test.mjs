import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/core/memory-store.mjs';

test('persists ordered conversations and shared state in SQLite', () => {
  const memory = new MemoryStore(':memory:');
  memory.appendMessage({ channel: 'qq', conversationId: 'owner', role: 'user', content: 'first', createdAt: '2026-01-01T00:00:00Z' });
  memory.appendMessage({ channel: 'qq', conversationId: 'owner', role: 'assistant', content: 'second', createdAt: '2026-01-01T00:00:01Z' });
  memory.appendMessage({ channel: 'douyin', conversationId: 'owner', role: 'user', content: 'other channel' });
  assert.deepEqual(memory.recentMessages({ channel: 'qq', conversationId: 'owner' }).map((m) => m.content), ['first', 'second']);
  memory.setState('persona', { interests: ['music'] });
  assert.deepEqual(memory.getState('persona'), { interests: ['music'] });
  memory.appendAction({ action: 'rest', reason: 'quiet moment', status: 'recorded' });
  assert.equal(memory.recentActions()[0].action, 'rest');
  memory.close();
});

test('isolates history by channel and conversation', () => {
  const memory = new MemoryStore(':memory:');
  memory.appendMessage({ channel: 'qq', conversationId: 'friend', role: 'user', content: 'private' });
  assert.deepEqual(memory.recentMessages({ channel: 'douyin', conversationId: 'friend' }), []);
  assert.deepEqual(memory.recentMessages({ channel: 'qq', conversationId: 'owner' }), []);
  memory.close();
});
