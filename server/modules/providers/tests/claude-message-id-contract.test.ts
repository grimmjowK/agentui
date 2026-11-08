import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import {
  buildMessageIdContractReport,
  inspectHistoryIdStability,
} from '@/modules/providers/tests/message-id-contract.js';
import type { AnyRecord } from '@/shared/types.js';

async function readClaudeFixture(): Promise<AnyRecord[]> {
  const fixturePath = path.resolve(process.cwd(), 'docs/fixtures/claude/multistep.jsonl');
  const contents = await readFile(fixturePath, 'utf8');
  return contents
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AnyRecord);
}

test('Claude fixture keeps stable transcript ids and matches live anchors', async () => {
  const provider = new ClaudeSessionsProvider();
  const entries = await readClaudeFixture();
  const normalize = () => entries.flatMap((entry) => provider.normalizeMessage(entry, 'claude-session'));

  const stability = await inspectHistoryIdStability(async () => normalize());
  assert.equal(stability.stable, true, `unstable kinds: ${stability.unstableKinds.join(', ')}`);

  const history = normalize();
  const live = history.map((message) => {
    if (message.kind === 'text' && message.role === 'user' && !message.isInterrupted) {
      return { ...message, id: 'user:11111111-1111-4111-8111-111111111111' };
    }
    if (message.isInterrupted) {
      return { ...message, id: 'claude-session:interrupted:live-run' };
    }
    return message;
  });

  const report = buildMessageIdContractReport(live, history);
  assert.equal(report.stableHistoryIds, true);
  assert.equal(report.userPairing.unpairedLive.length, 0);
  assert.equal(report.userPairing.unpairedHistory.length, 0);
  assert.equal(report.byKind.tool_use.both.length, 1);
  assert.equal(report.byKind.tool_result.both.length, 1);
  assert.equal(report.byKind.interrupted.both.length, 1);
});
