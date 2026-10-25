import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlServer } from '../src/core/control-server.mjs';

function schedulerFixture() {
  let paused = false;
  return {
    pause() { paused = true; },
    resume() { paused = false; },
    status() { return { paused, running: false, stopped: false, intervalMs: 60_000, lastResult: { action: 'rest' } }; },
  };
}

test('control server exposes status and loopback pause/resume controls', async () => {
  const scheduler = schedulerFixture();
  const channels = { ids: () => ['qq', 'douyin'] };
  const control = await createControlServer({ scheduler, channels, port: 0 });
  const port = control.address.port;
  try {
    const status = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(status.status, 200);
    assert.deepEqual((await status.json()).channels, ['qq', 'douyin']);
    const paused = await fetch(`http://127.0.0.1:${port}/api/autonomy/pause`, { method: 'POST' });
    assert.equal((await paused.json()).heartbeat.paused, true);
    const resumed = await fetch(`http://127.0.0.1:${port}/api/autonomy/resume`, { method: 'POST' });
    assert.equal((await resumed.json()).heartbeat.paused, false);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.match(await page.text(), /Gugu Habitat/);
  } finally {
    await control.close();
  }
});

test('control server refuses non-loopback binding', async () => {
  assert.throws(() => createControlServer({ scheduler: schedulerFixture(), channels: { ids: () => [] }, host: '0.0.0.0', port: 0 }), /loopback/);
});
