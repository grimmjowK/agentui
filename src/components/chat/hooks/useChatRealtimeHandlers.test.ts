import assert from 'node:assert/strict';
import test from 'node:test';

import { getTurnOutcome } from './useChatRealtimeHandlers';

test('getTurnOutcome 區分正常結束、中斷與出錯', () => {
  assert.equal(getTurnOutcome({ kind: 'complete' }), 'completed');
  assert.equal(getTurnOutcome({ kind: 'complete', exitCode: 0 }), 'completed');
  assert.equal(getTurnOutcome({ kind: 'complete', exitCode: 0, aborted: true }), 'aborted');
  assert.equal(getTurnOutcome({ kind: 'complete', exitCode: 1 }), 'error');
  assert.equal(getTurnOutcome({ kind: 'error' }), 'error');
  assert.equal(getTurnOutcome({ kind: 'text' }), null);
});
