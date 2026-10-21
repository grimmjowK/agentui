import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCodexSessionMetadata } from './codex-session-synchronizer.provider.js';

const rootPayload = {
  type: 'session_meta',
  payload: { id: 'root', cwd: '/project', source: 'exec', session_id: 'root' },
};

test('Codex session metadata keeps root threads in the top-level index', () => {
  assert.deepEqual(parseCodexSessionMetadata(rootPayload), {
    sessionId: 'root',
    projectPath: '/project',
    isSubagent: false,
  });
});

test('Codex session metadata identifies child transcripts that masquerade as peers', () => {
  assert.deepEqual(parseCodexSessionMetadata({
    type: 'session_meta',
    payload: {
      id: 'child',
      cwd: '/project',
      session_id: 'root',
      parent_thread_id: 'root',
      source: { subagent: { thread_spawn: { parent_thread_id: 'root' } } },
    },
  }), {
    sessionId: 'child',
    projectPath: '/project',
    isSubagent: true,
  });
});
