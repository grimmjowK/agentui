import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMessageIdContractReport,
  inspectHistoryIdStability,
} from '@/modules/providers/tests/message-id-contract.js';
import type { NormalizedMessage } from '@/shared/types.js';

function message(overrides: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: 'message-1',
    sessionId: 'session-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    provider: 'codex',
    kind: 'text',
    role: 'assistant',
    content: 'hello',
    ...overrides,
  };
}

test('message id contract reports matched anchors and pairs live user messages by order', () => {
  const live = [
    message({ id: 'user:11111111-1111-4111-8111-111111111111', role: 'user', content: 'hello' }),
    message({ id: 'assistant-1', content: 'done' }),
  ];
  const history = [
    message({ id: 'provider-user-1', role: 'user', content: 'hello' }),
    message({ id: 'assistant-1', content: 'done' }),
  ];

  const report = buildMessageIdContractReport(live, history);

  assert.equal(report.stableHistoryIds, true);
  assert.equal(report.byKind.assistant_text.both.length, 1);
  assert.equal(report.userPairing.paired.length, 1);
  assert.equal(report.userPairing.unpairedLive.length, 0);
});

test('message id contract flags provider ids that change between reads', async () => {
  let readCount = 0;
  const result = await inspectHistoryIdStability(async () => {
    readCount += 1;
    return [message({ id: `random-${readCount}`, kind: 'thinking' })];
  });

  assert.equal(result.stable, false);
  assert.deepEqual(result.unstableKinds, ['thinking']);
});
