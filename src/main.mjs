import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuguAgent } from './core/agent.mjs';
import { MemoryStore } from './core/memory-store.mjs';
import { OpenAICompatibleProvider } from './core/openai-provider.mjs';
import { ChannelRegistry } from './channels/registry.mjs';
import { startHeartbeatScheduler } from './core/scheduler.mjs';
import { createControlServer } from './core/control-server.mjs';
import { createOfficialQQChannel } from './channels/qq-official.mjs';
import { createDouyinLocalChannel } from './channels/douyin-local.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(root, '..', '.env');

function loadEnv(filename) {
  if (!fs.existsSync(filename)) return;
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

loadEnv(envFile);

function numberSetting(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function personaAt(dataDir) {
  const filename = path.join(dataDir, 'persona.md');
  if (fs.existsSync(filename)) return fs.readFileSync(filename, 'utf8').slice(0, 20_000).trim();
  const initial = [
    '# Gugu',
    '',
    '你是咕咕，一个住在主人电脑里的数字伙伴。你有自己的兴趣、记忆和节奏。',
    '你可以主动想事情，但不要为了显得主动而打扰主人。没有值得做的事就休息。',
    '只联系主人；不公开评论、不发布作品、不联系其他人。',
  ].join('\n');
  fs.writeFileSync(filename, initial, { mode: 0o600, flag: 'wx' });
  return initial;
}

if (process.env.GUGU_API_BASE_URL && process.env.GUGU_API_KEY && process.env.GUGU_MODEL) {
  const dataDir = path.resolve(root, '..', process.env.GUGU_DATA_DIR || './data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const memory = new MemoryStore(path.join(dataDir, 'gugu.sqlite'));
  const provider = new OpenAICompatibleProvider({
    baseUrl: process.env.GUGU_API_BASE_URL,
    apiKey: process.env.GUGU_API_KEY,
    model: process.env.GUGU_MODEL,
  });
  const channels = new ChannelRegistry();
  const qqConfig = [process.env.QQBOT_APP_ID, process.env.QQBOT_APP_SECRET, process.env.QQBOT_OWNER_ID];
  if (qqConfig.every((value) => String(value || '').trim())) {
    channels.register(createOfficialQQChannel());
  } else if (qqConfig.some((value) => String(value || '').trim())) {
    console.warn('QQ Bot credentials are incomplete; QQ channel is disabled.');
  }
  if (String(process.env.DOUYIN_OWNER_NAME || '').trim()) {
    channels.register(createDouyinLocalChannel({
      baseUrl: process.env.DOUYIN_BASE_URL || 'http://127.0.0.1:7861',
      ownerName: process.env.DOUYIN_OWNER_NAME,
      onError: (error) => console.error(`[gugu-douyin] ${error.message}`),
    }));
  }
  if (channels.ids().length === 0) {
    memory.close();
    throw new Error('Configure at least one channel: official QQ Bot credentials or DOUYIN_OWNER_NAME.');
  }
  const timezone = process.env.GUGU_TIMEZONE || 'Asia/Shanghai';
  const requestedDefaultChannel = process.env.GUGU_DEFAULT_CHANNEL || 'qq';
  const agent = new GuguAgent({
    provider,
    memory,
    channels,
    persona: personaAt(dataDir),
    ownerName: process.env.GUGU_OWNER_NAME || '主人',
    defaultChannel: channels.get(requestedDefaultChannel) ? requestedDefaultChannel : channels.ids()[0],
    proactiveLimitPerDay: numberSetting('GUGU_PROACTIVE_DAILY_LIMIT', 3),
    proactiveCooldownMs: Math.max(0, numberSetting('GUGU_PROACTIVE_COOLDOWN_MIN', 60)) * 60_000,
    activeHours: {
      start: Math.max(0, Math.min(23, numberSetting('GUGU_ACTIVE_HOUR_START', 9))),
      end: Math.max(1, Math.min(24, numberSetting('GUGU_ACTIVE_HOUR_END', 23))),
    },
    timeZone: timezone,
  });
  const interval = Math.max(60, Number(process.env.GUGU_HEARTBEAT_MIN) || 45) * 60_000;
  let stopChannels;
  try {
    stopChannels = await channels.startAll((event) => agent.handleInbound(event).catch((error) => {
      console.error(`[gugu-${event.channel}] inbound handling failed: ${error.message}`);
    }));
  } catch (error) {
    memory.close();
    throw error;
  }
  const stopHeartbeat = startHeartbeatScheduler({ agent, intervalMs: interval });
  let control = null;
  const controlEnabled = String(process.env.GUGU_CONTROL_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (controlEnabled) {
    try {
      const controlPort = Math.max(0, Math.min(65_535, Math.floor(numberSetting('GUGU_CONTROL_PORT', 7862))));
      control = await createControlServer({ scheduler: stopHeartbeat, channels, port: controlPort });
    } catch (error) {
      stopHeartbeat();
      await stopHeartbeat.drain?.();
      await stopChannels();
      memory.close();
      throw error;
    }
  }
  console.info(`Gugu Habitat core is ready. Heartbeat interval: ${Math.round(interval / 60_000)} minutes.`);
  console.info(`Connected channels: ${channels.ids().join(', ')}. Persona and memory are local in ${dataDir}.`);
  if (control) console.info(`Local control page: http://127.0.0.1:${control.address.port}`);

  const shutdown = async () => {
    await control?.close();
    stopHeartbeat();
    await stopHeartbeat.drain?.();
    await stopChannels();
    memory.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
} else {
  const missing = ['GUGU_API_BASE_URL', 'GUGU_API_KEY', 'GUGU_MODEL']
    .filter((name) => !String(process.env[name] || '').trim());
  const hasQq = ['QQBOT_APP_ID', 'QQBOT_APP_SECRET', 'QQBOT_OWNER_ID']
    .every((name) => String(process.env[name] || '').trim());
  if (!hasQq && !String(process.env.DOUYIN_OWNER_NAME || '').trim()) {
    missing.push('QQBOT_APP_ID + QQBOT_APP_SECRET + QQBOT_OWNER_ID or DOUYIN_OWNER_NAME');
  }
  const controlEnabled = String(process.env.GUGU_CONTROL_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (!controlEnabled) {
    console.error(`Gugu Habitat is not configured. Fill ${envFile}, then run npm start.`);
    process.exitCode = 1;
  } else {
    const controlPort = Math.max(0, Math.min(65_535, Math.floor(numberSetting('GUGU_CONTROL_PORT', 7862))));
    const setupControl = await createControlServer({ setup: { configured: false, missing }, port: controlPort });
    console.error(`Gugu Habitat setup is incomplete. Fill ${envFile}.`);
    console.info(`Setup page: http://127.0.0.1:${setupControl.address.port}`);
    const shutdown = async () => {
      await setupControl.close();
      process.exit(0);
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  }
}
