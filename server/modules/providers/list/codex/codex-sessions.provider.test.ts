import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CodexSessionsProvider, isCodexInterruptedText } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { sessionPinService } from '@/modules/providers/services/session-pin.service.js';
import {
  buildMessageIdContractReport,
  foldToolResultsForContract,
} from '@/modules/providers/tests/message-id-contract.js';

const provider = new CodexSessionsProvider();
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function withCodexTranscript<T>(contents: string, run: () => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-contract-'));
  const transcriptPath = path.join(directory, 'rollout.jsonl');
  await writeFile(transcriptPath, contents, 'utf8');
  const originalResolve = sessionPinService.resolveTranscriptPath;
  sessionPinService.resolveTranscriptPath = async () => transcriptPath;
  try {
    return await run();
  } finally {
    sessionPinService.resolveTranscriptPath = originalResolve;
    await rm(directory, { recursive: true, force: true });
  }
}

test('isCodexInterruptedText recognizes turn abort markers', () => {
  assert.equal(isCodexInterruptedText('<turn_aborted>'), true);
  assert.equal(isCodexInterruptedText('  <turn_aborted> mid turn'), true);
  assert.equal(isCodexInterruptedText('Conversation interrupted - use /feedback if something went wrong'), true);
  assert.equal(isCodexInterruptedText('Normal user message'), false);
});

test('normalizeMessage surfaces <turn_aborted> as an isInterrupted user message', () => {
  const [msg] = provider.normalizeMessage(
    { message: { role: 'user', content: '<turn_aborted>' } },
    's1'
  );
  assert.equal(msg.kind, 'text');
  assert.equal(msg.role, 'user');
  assert.equal(msg.isInterrupted, true);
});

test('normalizeMessage normalizes tool_result with isError', () => {
  const [msg] = provider.normalizeMessage(
    { type: 'tool_result', toolCallId: 'call_1', output: 'curl: (56) 403 Forbidden', isError: true },
    's1'
  );
  assert.equal(msg.kind, 'tool_result');
  assert.equal(msg.isError, true);
  assert.equal(msg.content, 'curl: (56) 403 Forbidden');
});

test('normalizeMessage passes through codex-item-mapper output', () => {
  const [msg] = provider.normalizeMessage(
    {
      type: 'mapped',
      timestamp: '2026-11-01T00:00:00.000Z',
      mapped: { kind: 'tool_use', toolId: 'call_1', toolName: 'Bash', toolInput: { command: 'ls' } },
    },
    's1'
  );
  assert.equal(msg.kind, 'tool_use');
  assert.equal(msg.toolName, 'Bash');
  assert.equal(msg.toolId, 'call_1');
  assert.equal(msg.provider, 'codex');
  assert.equal(msg.sessionId, 's1');
});

test('Codex history ids stay deterministic across repeated reads', async () => {
  const fixture = fs.readFileSync(
    path.resolve(process.cwd(), 'docs/fixtures/codex/multistep-rollout.jsonl'),
    'utf8',
  );
  await withCodexTranscript(fixture, async () => {
    const first = await provider.fetchHistory('codex-stable');
    const second = await provider.fetchHistory('codex-stable');
    assert.deepEqual(
      first.messages.map((message) => message.id),
      second.messages.map((message) => message.id),
    );
  });
});

test('Codex multi-step fixture matches live anchor ids', async () => {
  const fixture = fs.readFileSync(
    path.resolve(process.cwd(), 'docs/fixtures/codex/multistep-rollout.jsonl'),
    'utf8',
  );
  await withCodexTranscript(fixture, async () => {
    const history = (await provider.fetchHistory('codex-contract')).messages;
    const live = history.map((message) => {
      if (message.kind === 'text' && message.role === 'user' && !message.isInterrupted) {
        return { ...message, id: 'user:22222222-2222-4222-8222-222222222222' };
      }
      if (message.isInterrupted) {
        return { ...message, id: 'codex-contract:interrupted:run-1' };
      }
      return message;
    });
    const report = buildMessageIdContractReport(
      foldToolResultsForContract(live),
      foldToolResultsForContract(history),
    );
    assert.equal(
      report.stableHistoryIds,
      true,
      JSON.stringify(Object.fromEntries(
        Object.entries(report.byKind).map(([kind, lists]) => [
          kind,
          {
            liveOnly: lists.liveOnly.map((message) => message.id),
            historyOnly: lists.historyOnly.map((message) => message.id),
          },
        ]),
      )),
    );
    assert.equal(report.userPairing.unpairedLive.length, 0);
  });
});

test('Codex merges equivalent event_msg and response_item user rows', async () => {
  const lines = [
    {
      type: 'event_msg',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { type: 'user_message', message: 'same input', kind: 'plain' },
    },
    {
      type: 'response_item',
      timestamp: '2026-01-01T00:00:00.100Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'same input' }],
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-01-01T00:00:01.000Z',
      payload: {
        id: 'assistant-anchor',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'done' }],
      },
    },
  ].map((entry) => JSON.stringify(entry)).join('\n');

  await withCodexTranscript(lines, async () => {
    const result = await provider.fetchHistory('codex-merge');
    const users = result.messages.filter((message) => message.kind === 'text' && message.role === 'user');
    assert.equal(users.length, 1);
    assert.equal(users[0].id, 'codex_codex-merge_1');
    assert.deepEqual(users[0].providerIds, ['codex_codex-merge_0', 'codex_codex-merge_1']);
  });
});
