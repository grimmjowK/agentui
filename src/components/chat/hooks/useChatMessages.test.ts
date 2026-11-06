import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { normalizedToChatMessages } from './useChatMessages';

const note = (status: string, summary: string): NormalizedMessage => ({
  id: `n-${status}`, sessionId: 's', timestamp: '2026-11-05T12:00:00Z', provider: 'antigravity',
  kind: 'task_notification', status, summary,
});

test('warning/error 的 task_notification 顯示為警告；info 不顯示', () => {
  const out = normalizedToChatMessages([
    note('info', 'Codex 0.163.0 · /usr/local/bin/codex'),
    note('warning', '需要審批的工具已被自動拒絕'),
    note('error', '會話被其他終端機佔用'),
  ]);
  assert.deepEqual(out.map((m) => [m.type, m.content]), [
    ['warning', '需要審批的工具已被自動拒絕'],
    ['warning', '會話被其他終端機佔用'],
  ]);
});
