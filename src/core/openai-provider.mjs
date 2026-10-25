function completionUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('GUGU_API_BASE_URL is required');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function readCompletion(payload) {
  return payload?.choices?.[0]?.message?.content;
}

async function responseContent(response) {
  if (typeof response.text === 'function') {
    const raw = await response.text();
    try {
      return readCompletion(JSON.parse(raw));
    } catch (error) {
      if (raw.trimStart().startsWith('data:')) return readSseContent(raw);
      throw error;
    }
  }
  return readCompletion(await response.json());
}

function readSseContent(raw) {
  let content = '';
  for (const line of String(raw).split(/\r?\n/)) {
    const value = line.trim();
    if (!value.startsWith('data:')) continue;
    const data = value.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let event;
    try { event = JSON.parse(data); } catch { continue; }
    const delta = event?.choices?.[0]?.delta?.content;
    const complete = event?.choices?.[0]?.message?.content;
    if (typeof delta === 'string') content += delta;
    else if (typeof complete === 'string') content = complete;
  }
  return content;
}

export class OpenAICompatibleProvider {
  constructor({ baseUrl, apiKey, model, fetchImpl = globalThis.fetch, timeoutMs = 60_000, userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' }) {
    if (!apiKey) throw new Error('GUGU_API_KEY is required');
    if (!model) throw new Error('GUGU_MODEL is required');
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    this.url = completionUrl(baseUrl);
    this.apiKey = apiKey;
    this.model = model;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
  }

  async complete({ system, messages, maxTokens = 1200, signal } = {}) {
    if (typeof system !== 'string' || !Array.isArray(messages)) {
      throw new TypeError('complete() requires a system string and messages array');
    }
    const response = await this.fetch(this.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': this.userAgent,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: system }, ...messages],
        max_tokens: maxTokens,
        stream: false,
        thinking: { type: 'disabled' },
      }),
      signal: signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Model request failed with HTTP ${response.status}`);
    const text = await responseContent(response);
    if (typeof text !== 'string' || !text.trim()) throw new Error('Model returned no text');
    return text.trim();
  }
}
