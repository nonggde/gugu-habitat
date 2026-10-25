# Gugu Habitat

Gugu Habitat is a local-first home for a persistent AI character. The local
runtime owns her persona, memory, schedules, and channel connections. A
configurable external API supplies language-model reasoning when the runtime
decides it needs it.

The repository contains the local agent core, the official QQ Bot adapter, and
the Douyin adapter backed by a separately running loopback service.

## Design

- Persona, conversation history, and action journal stay in the local data
  directory.
- The model is called on inbound messages and autonomous heartbeats; it does
  not need to run continuously.
- Channel adapters share one agent and one memory store.
- Autonomous decisions use a small validated action vocabulary. The core only
  sends owner-directed messages; channel adapters enforce each platform's
  limits and configuration.
- Public video publishing remains a human action. Private messages and sharing
  are separate capabilities with their own channel settings.

## Development

Requires Node.js 24 or newer. Copy `.env.example` to `.env`, set the model
endpoint, key, and model name, then run:

```sh
npm test
npm run check
npm start
```

`npm run check` runs syntax validation and the complete test suite. No live
platform credentials are needed for tests.

For QQ, create an official QQ Bot and set `QQBOT_APP_ID`,
`QQBOT_APP_SECRET`, and `QQBOT_OWNER_ID`. For Douyin, start the existing local
standalone service on loopback and set `DOUYIN_OWNER_NAME` to the exact owner
conversation name shown in its inbox. The adapter refuses non-loopback service
URLs and ambiguous recipient names. The first run creates a private local
`data/persona.md`; edit it to define Gugu's stable character. Conversation
history and action records are stored in `data/gugu.sqlite`.

The local database, API credentials, browser profiles, persona file, and
message history are not part of the repository. Tests use fake model and
channel implementations; they do not contact QQ or Douyin. Start with
proactive messaging disabled or with a small daily limit while validating a
new deployment.

The local control page is served on `http://127.0.0.1:7862` by default. It
shows connected channels and heartbeat state, and can pause or resume
autonomous heartbeats. Incoming messages continue to receive replies while
autonomous heartbeats are paused. Set `GUGU_CONTROL_PORT=0` to let the operating
system select a port, or `GUGU_CONTROL_ENABLED=false` to disable the page.

## Current status

- [x] Local SQLite-backed conversation, state, and action memory
- [x] OpenAI-compatible API provider
- [x] Validated autonomous decision format and owner-only contact limits
- [x] Shared channel registry and heartbeat scheduler
- [x] Official QQ Bot adapter (C2C owner only)
- [x] Douyin adapter backed by the existing local service (DM, bounded read-only watch, owner share)
- [x] Loopback-only control page with autonomy pause/resume and runtime status
- [ ] Guided onboarding

The autonomous loop currently supports rest, reflection, read-only Douyin
watching, private video-card sharing to the configured owner, and owner
messages. It has no public comment or post action. QQ and Douyin proactive
messages share a daily limit and cooldown. QQ platform delivery permissions and
Douyin account login are still prerequisites and have not been live-tested.

## License

MIT. Runtime dependency notices are in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Any upstream code, SDKs, or
media added later must retain their original copyright and license notices.
