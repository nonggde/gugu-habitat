export const DECISION_ACTIONS = Object.freeze(['rest', 'reflect', 'watch_douyin', 'share_douyin_video', 'message_owner']);
export const CHANNEL_IDS = Object.freeze(['qq', 'douyin', 'web']);

export function parseDecision(raw) {
  const text = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { action: 'rest', reason: 'The model response was not valid JSON.' };
  }
  if (!value || !DECISION_ACTIONS.includes(value.action)) {
    return { action: 'rest', reason: 'The model selected an unsupported action.' };
  }
  const decision = {
    action: value.action,
    reason: typeof value.reason === 'string' ? value.reason.slice(0, 300) : '',
  };
  if (value.action === 'message_owner') {
    if (typeof value.text !== 'string' || !value.text.trim()) {
      return { action: 'rest', reason: 'The message action had no text.' };
    }
    if (value.channel != null && !CHANNEL_IDS.includes(value.channel)) {
      return { action: 'rest', reason: 'The model selected an unsupported channel.' };
    }
    decision.text = value.text.trim().slice(0, 1000);
    if (value.channel) decision.channel = value.channel;
  }
  if (value.action === 'share_douyin_video') {
    const awemeId = String(value.awemeId ?? '').trim();
    if (!/^\d{8,32}$/.test(awemeId)) return { action: 'rest', reason: 'The video identifier is invalid.' };
    decision.awemeId = awemeId;
  }
  return decision;
}

export function decisionSystemPrompt({ persona, ownerName, channels }) {
  return [
    String(persona || '你是一个住在主人电脑里的、有好奇心和连续记忆的数字伙伴。'),
    `主人的称呼是${String(ownerName || '主人')}。`,
    '现在是一次自主心跳。结合本地记忆和最近行动，选择一个动作。没有值得做的事就休息。',
    '允许动作：rest、reflect、watch_douyin、share_douyin_video、message_owner。',
    'reflect 用 reason 写一条简短想法；watch_douyin 只浏览并记录，不点赞、不评论、不关注。',
    'share_douyin_video 只能把 recentDouyinFindings 中明确出现的具体作品私信分享给主人；不要猜 awemeId。',
    `message_owner 只在确实有具体内容时联系主人。可用渠道：${channels.join(', ') || '无'}。`,
    '不得联系其他人，不得公开评论或发布作品，不得声称尚未执行的动作已经完成。',
    '只返回 JSON: {"action":"rest|reflect|watch_douyin|share_douyin_video|message_owner","reason":"...","channel":"qq|douyin|web","text":"...","awemeId":"数字作品ID"}。',
  ].join('\n');
}
