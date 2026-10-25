import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRegistry } from '../src/channels/registry.mjs';

test('startAll stops channels that started before a later channel fails', async () => {
  const stopped = [];
  const registry = new ChannelRegistry()
    .register({
      id: 'first',
      start: async () => {},
      stop: async () => { stopped.push('first'); },
      sendOwnerMessage: async () => ({ ok: true }),
    })
    .register({
      id: 'second',
      start: async () => { throw new Error('startup failed'); },
      sendOwnerMessage: async () => ({ ok: true }),
    });

  await assert.rejects(registry.startAll(() => {}), /startup failed/);
  assert.deepEqual(stopped, ['first']);
});

test('stop callback stops every started channel', async () => {
  const stopped = [];
  const registry = new ChannelRegistry()
    .register({
      id: 'first',
      start: async () => {},
      stop: async () => { stopped.push('first'); },
      sendOwnerMessage: async () => ({ ok: true }),
    })
    .register({
      id: 'second',
      start: async () => {},
      stop: async () => { stopped.push('second'); },
      sendOwnerMessage: async () => ({ ok: true }),
    });

  const stopAll = await registry.startAll(() => {});
  await stopAll();
  assert.deepEqual(stopped.sort(), ['first', 'second']);
});
