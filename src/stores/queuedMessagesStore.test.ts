import assert from 'node:assert/strict';
import test from 'node:test';

import { NEW_SESSION_KEY, getDraftQueueTransition, queuedMessages } from './queuedMessagesStore';

test('佇列依會話隔離，移除後不再出現', () => {
  queuedMessages.reset();
  const a = queuedMessages.enqueue('A', 'a1');
  queuedMessages.enqueue('B', 'b1');
  assert.deepEqual(queuedMessages.get('A').map((m) => m.text), ['a1']);
  assert.deepEqual(queuedMessages.get('B').map((m) => m.text), ['b1']);
  queuedMessages.remove('A', a.id);
  assert.equal(queuedMessages.get('A').length, 0);
  assert.equal(queuedMessages.get('missing'), queuedMessages.get('also-missing'), '空佇列回傳同一個參照，避免重新渲染');
});

test('takeNext 依序取出並跳過引導中的項目', () => {
  queuedMessages.reset();
  const first = queuedMessages.enqueue('A', 'first');
  queuedMessages.enqueue('A', 'second');
  queuedMessages.setSteering('A', first.id, true);
  assert.equal(queuedMessages.takeNext('A')?.text, 'second');
  assert.equal(queuedMessages.takeNext('A'), null, '只剩引導中的項目時不取出');
  queuedMessages.setSteering('A', first.id, false);
  assert.equal(queuedMessages.takeNext('A')?.text, 'first');
});

test('renameSession 把新會話佇列接到實際 id 後面', () => {
  queuedMessages.reset();
  queuedMessages.enqueue('real', 'existing');
  queuedMessages.enqueue(NEW_SESSION_KEY, 'queued-before-id');
  queuedMessages.renameSession(NEW_SESSION_KEY, 'real');
  assert.deepEqual(queuedMessages.get('real').map((m) => m.text), ['existing', 'queued-before-id']);
  assert.equal(queuedMessages.get(NEW_SESSION_KEY).length, 0);
});

test('狀態改變時通知訂閱者，無變化時不通知', () => {
  queuedMessages.reset();
  let calls = 0;
  const unsubscribe = queuedMessages.subscribe(() => { calls += 1; });
  const item = queuedMessages.enqueue('A', 'x');
  queuedMessages.setSteering('A', item.id, false);
  queuedMessages.remove('A', 'nope');
  assert.equal(calls, 1);
  unsubscribe();
});

test('getDraftQueueTransition：只有本次建立請求拿到 id 才搬移暫存佇列', () => {
  const draft = { sessionId: null, projectId: 'A' };
  assert.equal(getDraftQueueTransition(draft, { sessionId: 's1', projectId: 'A' }, 's1'), 'move');
  assert.equal(getDraftQueueTransition(draft, { sessionId: 'old', projectId: 'A' }, null), 'keep', '從新會話點進既有會話不搬');
  assert.equal(getDraftQueueTransition(draft, { sessionId: null, projectId: 'B' }, null), 'new-draft', '換專案換新暫存');
  assert.equal(getDraftQueueTransition({ sessionId: 's1', projectId: 'A' }, draft, null), 'new-draft', '離開會話回到新會話換新暫存');
  assert.equal(getDraftQueueTransition(draft, draft, null), 'keep');
});

test('enqueue front 放回最前面；discard 清掉整個佇列', () => {
  queuedMessages.reset();
  queuedMessages.enqueue('A', 'second');
  queuedMessages.enqueue('A', 'first', [], { front: true });
  assert.deepEqual(queuedMessages.get('A').map((m) => m.text), ['first', 'second']);
  queuedMessages.discard('A');
  assert.equal(queuedMessages.get('A').length, 0);
});
