import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionStreamBuffer } from './sessionStreamBuffer';

function harness() {
  const rows = new Map<string, { content: string; provider: string; messageId?: string }>();
  const completed: string[] = [];
  const buffer = createSessionStreamBuffer({
    updateStreaming(sessionId, content, provider) {
      rows.set(sessionId, { content, provider });
    },
    finalizeStreaming(sessionId, messageId) {
      completed.push(sessionId);
      const row = rows.get(sessionId);
      if (row) row.messageId = messageId;
    },
  });
  return { buffer, rows, completed };
}

test('背景串流片段累積為一則訊息，切換顯示對話不影響累積', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { buffer, rows } = harness();
  buffer.append('a', '我', 'codex');
  t.mock.timers.tick(100);
  buffer.append('a', '繼續', 'codex');
  buffer.append('a', '審查', 'codex');
  t.mock.timers.tick(100);
  assert.equal(rows.size, 1);
  assert.equal(rows.get('a')?.content, '我繼續審查');
  buffer.finish('a', 'message-a');
  assert.equal(rows.get('a')?.messageId, 'message-a');
});

test('兩個 session 交錯輸出，完成其中一個不截斷另一個', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { buffer, rows, completed } = harness();
  buffer.append('a', '甲', 'codex');
  buffer.append('b', '乙', 'claude');
  buffer.finish('a', 'message-a');
  buffer.append('b', '繼續', 'claude');
  t.mock.timers.tick(100);
  assert.deepEqual(rows.get('a'), { content: '甲', provider: 'codex', messageId: 'message-a' });
  assert.deepEqual(rows.get('b'), { content: '乙繼續', provider: 'claude' });
  assert.deepEqual(completed, ['a']);
  buffer.dispose();
});

test('完成事件立即刷出尚未顯示的文字，取消舊計時器且下一段重新累積', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { buffer, rows } = harness();
  buffer.append('a', '第一段', 'codex');
  buffer.finish('a', 'first');
  t.mock.timers.tick(100);
  assert.equal(rows.get('a')?.messageId, 'first');
  buffer.append('a', '第二段', 'codex');
  buffer.finish('a', 'second');
  assert.deepEqual(rows.get('a'), { content: '第二段', provider: 'codex', messageId: 'second' });
});

test('卸載刷出所有 session 的剩餘文字，不留下計時器或偽造完成事件', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { buffer, rows, completed } = harness();
  buffer.append('a', '甲', 'codex');
  buffer.append('b', '乙', 'claude');
  buffer.dispose();
  assert.equal(rows.size, 2);
  rows.clear();
  t.mock.timers.tick(100);
  assert.equal(rows.size, 0);
  assert.deepEqual(completed, []);
});
