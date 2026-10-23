import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCodexChildEnv } from './child-env.js';

test('managed Codex children do not inherit a parent Codex run identity or sandbox', () => {
  const source = {
    PATH: '/bin',
    CODEX_HOME: '/old',
    CODEX_SESSION_ID: 'ambient-session',
    CODEX_THREAD_ID: 'ambient-thread',
    CODEX_SANDBOX: 'seatbelt',
    CODEX_SANDBOX_NETWORK_DISABLED: '1',
  };

  assert.deepEqual(buildCodexChildEnv('/selected', source), {
    PATH: '/bin',
    CODEX_HOME: '/selected',
  });
  assert.equal(source.CODEX_THREAD_ID, 'ambient-thread');
});
