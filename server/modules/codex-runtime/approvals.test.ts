import assert from 'node:assert/strict';
import test from 'node:test';

import { elicitationUrl, validateElicitationContent } from '../../../shared/elicitation.js';

import { CodexApprovals } from './approvals.js';
import type { ServerRequest } from './protocol/index.js';

/** 測試只給出與行為相關的欄位，其餘協議欄位省略。 */
const wire = (request: unknown) => request as ServerRequest;

test('elicitation validates form input, binds owner/thread, replays and consumes the response once', () => {
  const approvals = new CodexApprovals();
  const replies: unknown[] = [];
  const schema = { type: 'object', properties: { approved: { type: 'boolean' }, count: { type: 'integer', minimum: 1 } }, required: ['approved'] };
  const id = approvals.add({ userId: 'u', threadId: 't', turnId: '', instanceId: 'r',
    request: wire({ id: 1, method: 'mcpServer/elicitation/request', params: { mode: 'form', requestedSchema: schema, turnId: null } }),
    reply: (result) => replies.push(result), notify: () => {},
  });
  const decision = { action: 'accept', content: { approved: false, count: 2 } };
  assert.equal(approvals.decide(id, 'other', 't', decision), false);
  assert.equal(approvals.decide(id, 'u', 'other', decision), false);
  for (const invalid of ['accept', { action: 'acceptForSession' }, { action: 'accept', content: {} },
    { action: 'accept', content: { approved: 'true' } }, { action: 'accept', content: { approved: true, count: 0 } }]) {
    assert.equal(approvals.decide(id, 'u', 't', invalid), false);
  }
  const events: any[] = [];
  approvals.replay('u', 't', (event) => events.push(event));
  assert.deepEqual(events[0].input.requestedSchema, schema);
  assert.equal(approvals.decide(id, 'u', 't', decision), true);
  assert.deepEqual(replies, [{ ...decision, _meta: null }]);
  assert.equal(events.at(-1).kind, 'permission_cancelled');
  assert.equal(approvals.decide(id, 'u', 't', decision), false);
});

test('elicitation decline/cancel/URL acceptance and lifecycle return protocol action/content', async () => {
  for (const action of ['decline', 'cancel', 'accept', 'expired', 'cleared']) {
    const approvals = new CodexApprovals();
    const replies: unknown[] = [];
    const id = approvals.add({ userId: 'u', threadId: 't', turnId: '', instanceId: 'r', timeoutMs: action === 'expired' ? 5 : 10000,
      request: wire({ id: 1, method: 'mcpServer/elicitation/request', params: { mode: 'url', url: 'https://example.com' } }),
      reply: (result) => replies.push(result), notify: () => {},
    });
    if (action === 'expired') await new Promise((resolve) => setTimeout(resolve, 20));
    else if (action === 'cleared') approvals.clear('r');
    else assert.equal(approvals.decide(id, 'u', 't', { action, content: { ignored: true } }), true);
    assert.deepEqual(replies, [{ action: ['expired', 'cleared'].includes(action) ? 'cancel' : action, content: null, _meta: null }]);
    assert.deepEqual(approvals.listPending('u'), []);
  }
});

test('elicitation selections, required fields and links are checked', () => {
  const schema = { type: 'object', properties: {
    choice: { type: 'string', oneOf: [{ const: 'yes', title: 'Yes' }, { const: 'no', title: 'No' }] },
    tags: { type: 'array', minItems: 1, items: { type: 'string', enum: ['a', 'b'] } },
  }, required: ['choice', 'tags'] };
  assert.equal(validateElicitationContent(schema, { choice: 'no', tags: ['b'] }), null);
  assert.ok(validateElicitationContent(schema, { choice: 'other', tags: ['b'] }));
  assert.ok(validateElicitationContent(schema, { choice: 'yes', tags: [] }));
  assert.ok(validateElicitationContent(schema, { choice: 'yes', tags: ['other'] }));
  assert.equal(elicitationUrl('javascript:alert(1)'), null);
  assert.equal(elicitationUrl('file:///etc/passwd'), null);
  assert.equal(elicitationUrl('https://example.com/auth'), 'https://example.com/auth');
});

test('approval replies are bound to owner/thread, limited to advertised choices and consumed once', () => {
  const approvals = new CodexApprovals();
  const replies: unknown[] = [];
  const events: Record<string, any>[] = [];
  const id = approvals.add({ userId: 'u1', threadId: 't1', turnId: 'turn1', instanceId: 'run1',
    request: wire({ id: 'original-id', method: 'item/commandExecution/requestApproval', params: { availableDecisions: ['accept', 'decline'] } }),
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
    request: wire({ id: 0, method: 'item/fileChange/requestApproval' }),
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
    request: wire({ id: 0, method: 'item/permissions/requestApproval', params: { permissions } }),
    reply: (result) => replies.push(result), notify: () => {},
  });
  approvals.decide(id, 'u', 't', 'accept');
  assert.deepEqual(replies, [{ permissions, scope: 'turn' }]);
});

test('expiry cancels advertised command operation and cannot be approved later', async () => {
  const approvals = new CodexApprovals();
  const replies: unknown[] = [];
  const id = approvals.add({ userId: 'u', threadId: 't', turnId: 'turn', instanceId: 'r', timeoutMs: 10,
    request: wire({ id: 0, method: 'item/commandExecution/requestApproval', params: { availableDecisions: ['accept', 'cancel'] } }),
    reply: (result) => replies.push(result), notify: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(replies, [{ decision: 'cancel' }]);
  assert.equal(approvals.decide(id, 'u', 't', 'accept'), false);
});

test('decision set filtering keeps supported choices and falls back to decline when emptied', () => {
  const approvals = new CodexApprovals();
  const cards: Record<string, any>[] = [];
  const notify = (message: Record<string, any>) => { if (message.kind === 'permission_request') cards.push(message); };

  // 正常候选集合：原样保留受支持的简单枚举。
  approvals.add({ userId: 'u', threadId: 't', turnId: 'turn', instanceId: 'r1',
    request: wire({ id: 1, method: 'item/commandExecution/requestApproval', params: { availableDecisions: ['accept', 'cancel'] } }),
    reply: () => {}, notify });
  assert.deepEqual(cards.at(-1)?.context.decisions, ['accept', 'cancel']);

  // 候选集合被过滤后仍非空：丢掉不支持的对象型决定，保留简单枚举。
  approvals.add({ userId: 'u', threadId: 't', turnId: 'turn', instanceId: 'r2',
    request: wire({ id: 2, method: 'item/commandExecution/requestApproval',
      params: { availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: [] } }, 'decline'] } }),
    reply: () => {}, notify });
  assert.deepEqual(cards.at(-1)?.context.decisions, ['accept', 'decline']);

  // 候选集合被过滤后为空：只提供不支持的对象型决定 → 回退为仅拒绝，不产出空卡片。
  approvals.add({ userId: 'u', threadId: 't', turnId: 'turn', instanceId: 'r3',
    request: wire({ id: 3, method: 'item/commandExecution/requestApproval',
      params: { availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: [] } }] } }),
    reply: () => {}, notify });
  assert.deepEqual(cards.at(-1)?.context.decisions, ['decline']);
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

test('listPending 只列出該使用者的項目，可依會話過濾', () => {
  const approvals = new CodexApprovals();
  const add = (userId: string, threadId: string, id: number) => approvals.add({ userId, threadId, turnId: 'turn', instanceId: `r${id}`,
    request: wire({ id, method: 'item/fileChange/requestApproval', params: {} }), reply: () => {}, notify: () => {} });
  const mine = add('u1', 't1', 1);
  add('u1', 't2', 2);
  add('u2', 't1', 3);
  assert.deepEqual(approvals.listPending('u1').map((item) => item.sessionId).sort(), ['t1', 't2']);
  assert.deepEqual(approvals.listPending('u1', 't1').map((item) => item.requestId), [mine]);
  assert.equal(approvals.listPending('u1')[0].provider, 'codex');
  assert.deepEqual(approvals.listPending(null), []);
});
