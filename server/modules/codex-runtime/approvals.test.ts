import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexApprovals } from './approvals.js';

test('approval replies are bound to owner/thread, limited to advertised choices and consumed once', () => {
  const approvals = new CodexApprovals();
  const replies: unknown[] = [];
  const events: Record<string, any>[] = [];
  const id = approvals.add({ userId: 'u1', threadId: 't1', turnId: 'turn1', instanceId: 'run1',
    request: { id: 'original-id', method: 'item/commandExecution/requestApproval', params: { availableDecisions: ['accept', 'decline'] } },
    reply: (result) => replies.push(result), notify: (message) => events.push(message),
  });
  assert.equal(approvals.decide(id, 'u2', 't1', 'accept'), false);
  assert.equal(approvals.decide(id, 'u1', 't2', 'accept'), false);
  assert.equal(approvals.decide(id, 'u1', 't1', 'acceptForSession'), false);
  assert.equal(replies.length, 0);
  assert.equal(approvals.decide(id, 'u1', 't1', 'accept'), true);
  assert.deepEqual(replies, [{ decision: 'accept' }]);
  assert.equal(approvals.decide(id, 'u1', 't1', 'accept'), false);
  assert.equal(events.at(-1)?.kind, 'permission_cancelled');
});

test('reconnection replays only the owner requests; shutdown refuses them', () => {
  const approvals = new CodexApprovals();
  const replies: unknown[] = [];
  approvals.add({ userId: 7, threadId: 'thread', turnId: 'turn', instanceId: 'run',
    request: { id: 0, method: 'item/fileChange/requestApproval' },
    reply: (result) => replies.push(result), notify: () => {},
  });
  const events: unknown[] = [];
  approvals.replay(8, 'thread', (message) => events.push(message));
  assert.equal(events.length, 0);
  approvals.replay(7, 'thread', (message) => events.push(message));
  assert.equal(events.length, 1);
  approvals.clear('another-run');
  assert.equal(replies.length, 0);
  approvals.clear('run');
  assert.deepEqual(replies, [{ decision: 'decline' }]);
  assert.equal(events.length, 2);
});

test('extra permissions grant only the requested object for this turn', () => {
  const approvals = new CodexApprovals();
  const replies: unknown[] = [];
  const permissions = { network: { enabled: true } };
  const id = approvals.add({ userId: 'u', threadId: 't', turnId: 'turn', instanceId: 'r',
    request: { id: 0, method: 'item/permissions/requestApproval', params: { permissions } },
    reply: (result) => replies.push(result), notify: () => {},
  });
  approvals.decide(id, 'u', 't', 'accept');
  assert.deepEqual(replies, [{ permissions, scope: 'turn' }]);
});

test('expiry cancels advertised command operation and cannot be approved later', async () => {
  const approvals = new CodexApprovals();
  const replies: unknown[] = [];
  const id = approvals.add({ userId: 'u', threadId: 't', turnId: 'turn', instanceId: 'r', timeoutMs: 10,
    request: { id: 0, method: 'item/commandExecution/requestApproval', params: { availableDecisions: ['accept', 'cancel'] } },
    reply: (result) => replies.push(result), notify: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(replies, [{ decision: 'cancel' }]);
  assert.equal(approvals.decide(id, 'u', 't', 'accept'), false);
});

test('actual recorded command fixture does not expose unadvertised decisions or widen exec policy', async () => {
  const fs = await import('node:fs');
  const fixture = JSON.parse(fs.readFileSync(new URL('../../../docs/fixtures/codex/command-accept.json', import.meta.url), 'utf8'));
  const request = fixture.find((event: any) => event.method === 'item/commandExecution/requestApproval');
  const approvals = new CodexApprovals();
  let card: any; let response: any;
  const options = { userId: 1, threadId: 't', turnId: 'turn', instanceId: 'run', request,
    notify: (message: any) => { if (message.kind === 'permission_request') card = message; },
    reply: (result: any) => { response = { id: request.id, result }; },
  };
  const id = approvals.add(options);
  assert.equal(approvals.add(options), id);
  assert.deepEqual(card.context.decisions, ['accept', 'cancel']);
  assert.equal(approvals.decide(id, 1, 't', 'acceptForSession'), false);
  assert.equal(approvals.decide(id, 1, 't', 'accept'), true);
  assert.deepEqual(response, { id: 0, result: { decision: 'accept' } });
});
