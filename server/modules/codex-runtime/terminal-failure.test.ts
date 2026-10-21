import assert from 'node:assert/strict';
import test from 'node:test';
import { codexTerminalFailure } from './terminal-failure.js';

test('recognizes the reported account bootstrap timeout without labeling unrelated errors', () => {
  assert.match(codexTerminalFailure('Error: account/read failed during TUI bootstrap: account/read failed: workspace routing discovery timed out (code -32603)')!, /retry the same session/);
  assert.equal(codexTerminalFailure('Error: no rollout found'), null);
  assert.equal(codexTerminalFailure('workspace routing discovery timed out'), null);
});
