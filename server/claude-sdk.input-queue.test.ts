import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createInputQueue } from './claude-sdk.js';

test('輸入佇列：插話未被消化前不關閉，全部消化後結束迭代', async () => {
  const input = createInputQueue();
  const it = input[Symbol.asyncIterator]();

  input.push('first');
  const first = (await it.next()).value;
  assert.equal(first.message.content, 'first');

  input.push('steer');
  const steer = (await it.next()).value;

  // 第一輪只消化了 first：steer 還在排隊，不能關
  assert.equal(input.onResult({ user_message_uuids: [first.uuid] }), false);
  assert.equal(input.push('more'), true);
  const more = (await it.next()).value;

  // 下一輪把剩下的都消化掉才關閉
  assert.equal(input.onResult({ user_message_uuids: [steer.uuid, more.uuid] }), true);
  assert.equal((await it.next()).done, true);
  assert.equal(input.push('late'), false);
});

test('輸入佇列：舊版 CLI 沒有 uuid 列表時依 queued_turn_count 判斷', () => {
  const input = createInputQueue();
  input.push('a');
  input.push('b');
  assert.equal(input.onResult({ queued_turn_count: 1 }), false);
  assert.equal(input.onResult({ queued_turn_count: 0 }), true);
});
