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

test('輸入佇列：中斷時 close 丟掉尚未交出的插話', async () => {
  const input = createInputQueue();
  const it = input[Symbol.asyncIterator]();
  input.push('first');
  await it.next();
  input.push('buffered-steer');
  input.close();
  assert.equal((await it.next()).done, true, '已緩衝的插話不能在停止後交給 CLI');
});

test('輸入佇列：只有單數 user_message_uuid 的舊版 CLI，插話併入同一輪後仍會關閉', async () => {
  const input = createInputQueue();
  const it = input[Symbol.asyncIterator]();
  input.push('first');
  const first = (await it.next()).value;
  input.push('folded-steer');
  await it.next();
  // 插話被併入這一輪：單數 uuid 只代表其中一則，沒有複數列表；以 queued_turn_count 0 判斷已無待處理
  assert.equal(input.onResult({ user_message_uuid: first.uuid, queued_turn_count: 0 }), true);
});

test('輸入佇列：只有單數 uuid 且還有排隊中的一輪時不關閉', () => {
  const input = createInputQueue();
  input.push('a');
  input.push('b');
  assert.equal(input.onResult({ user_message_uuid: 'x', queued_turn_count: 1 }), false);
});

test('輸入佇列：result 後仍有背景任務時不關閉，可繼續插話；任務清空且閒置才關閉', () => {
  const input = createInputQueue();
  input.push('first');
  input.onBackgroundTasksChanged([{ task_id: 'bbjpcm257', task_type: 'local_bash', description: 'rollout' }]);
  assert.equal(input.onResult({ queued_turn_count: 0 }), false, '背景任務還在跑，CLI 行程未結束');
  assert.equal(input.push('steer'), true, '此時插話必須被接受');
  // steer 尚未消化：背景任務結束也不能關
  input.onBackgroundTasksChanged([]);
  assert.equal(input.closed, false);
  assert.equal(input.onResult({ queued_turn_count: 0 }), true);
});

test('輸入佇列：只剩 ambient 背景任務時照常關閉', () => {
  const input = createInputQueue();
  input.push('a');
  input.onBackgroundTasksChanged([{ task_id: 'w', task_type: 'watcher', description: '', ambient: true }]);
  assert.equal(input.onResult({ queued_turn_count: 0 }), true);
});
