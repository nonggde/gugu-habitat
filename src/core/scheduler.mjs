export function startHeartbeatScheduler({ agent, intervalMs, onError = (error) => console.error(error), timers = globalThis }) {
  if (!agent || typeof agent.heartbeat !== 'function') throw new TypeError('A heartbeat-capable agent is required');
  const period = Number(intervalMs);
  if (!Number.isFinite(period) || period < 60_000) throw new RangeError('Heartbeat interval must be at least 60 seconds');
  let running = false;
  let stopped = false;
  let paused = false;
  let lastStartedAt = null;
  let lastCompletedAt = null;
  let lastResult = null;
  let lastError = null;
  let activeRun = null;
  const tick = async () => {
    if (stopped || paused || running) return;
    running = true;
    lastStartedAt = new Date().toISOString();
    lastError = null;
    activeRun = (async () => {
      try {
        lastResult = await agent.heartbeat();
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        onError(error);
      } finally {
        lastCompletedAt = new Date().toISOString();
        running = false;
        activeRun = null;
      }
    })();
    await activeRun;
  };
  const timer = timers.setInterval(() => void tick(), period);
  timer?.unref?.();
  const stop = () => {
    stopped = true;
    timers.clearInterval(timer);
  };
  stop.drain = async () => {
    await activeRun;
  };
  stop.pause = () => {
    paused = true;
    agent.autonomyPaused = true;
  };
  stop.resume = () => {
    paused = false;
    agent.autonomyPaused = false;
    void tick();
  };
  stop.status = () => ({
    paused,
    running,
    stopped,
    intervalMs: period,
    lastStartedAt,
    lastCompletedAt,
    lastResult,
    lastError,
  });
  void tick();
  return stop;
}
