import assert from 'node:assert/strict';
import test from 'node:test';

import { computeMerged, type NormalizedMessage } from './useSessionStore';

const msg = (id: string, ts: string, extra: Partial<NormalizedMessage>): NormalizedMessage => ({
  id, sessionId: 's', timestamp: `2026-11-03T11:42:${ts}Z`, provider: 'claude', kind: 'text', ...extra,
});

test('未被服务端认领的用户提问按时间排在回答前面，旧错误不沉底', () => {
  const server = [
    msg('a1', '10', { role: 'assistant', content: 'old answer' }),
    msg('a2', '30', { role: 'assistant', content: 'new answer' }),
  ];
  const realtime = [
    msg('err', '15', { kind: 'error', content: 'some unrelated failure happened here' }),
    msg('local_u', '20', { role: 'user', content: 'skill chip text' }),
  ];
  assert.deepEqual(computeMerged(server, realtime).map((m) => m.id), ['a1', 'err', 'local_u', 'a2']);
});

test('已以助手正文出现过的 API 错误不再重复渲染', () => {
  const apiError = 'API Error: 422 {"detail":"supplier response failed"}';
  const server = [msg('a1', '44', { role: 'assistant', content: apiError })];
  const realtime = [msg('err', '45', { kind: 'error', content: `Claude Code returned an error result: ${apiError}` })];
  assert.deepEqual(computeMerged(server, realtime).map((m) => m.id), ['a1']);
  // 刷新前：两条都还在 realtime 里
  assert.deepEqual(computeMerged([], [...server, ...realtime]).map((m) => m.id), ['a1']);
});
