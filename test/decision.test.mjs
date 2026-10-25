import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecision } from '../src/core/decision.mjs';

test('accepts only bounded, owner-directed actions', () => {
  assert.deepEqual(parseDecision('{"action":"message_owner","channel":"qq","text":"I found something interesting.","reason":"Specific update"}'), {
    action: 'message_owner', channel: 'qq', text: 'I found something interesting.', reason: 'Specific update',
  });
  assert.equal(parseDecision('{"action":"send_money"}').action, 'rest');
  assert.equal(parseDecision('{"action":"message_owner","channel":"telegram","text":"hi"}').action, 'rest');
  assert.equal(parseDecision('{"action":"message_owner","text":"  "}').action, 'rest');
  assert.equal(parseDecision('{"action":"share_douyin_video","awemeId":"not-an-id"}').action, 'rest');
  assert.equal(parseDecision('not json').action, 'rest');
});
