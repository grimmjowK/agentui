import assert from 'node:assert/strict';
import test from 'node:test';
import { codexTerminalFailure } from './terminal-failure.js';

test('recognizes the reported account bootstrap timeout without labeling unrelated errors', () => {
  assert.match(codexTerminalFailure('Error: account/read failed during TUI bootstrap: account/read failed: workspace routing discovery timed out (code -32603)')!, /retry the same session/);
  assert.equal(codexTerminalFailure('Error: no rollout found'), null);
  assert.equal(codexTerminalFailure('workspace routing discovery timed out'), null);
});

test('recognizes the paginated thread resume gap without labeling unrelated errors', () => {
  assert.match(codexTerminalFailure('Error: Failed to resume session from /x.jsonl: thread/resume failed during TUI bootstrap: thread/resume failed: paginated_threads is not supported yet (code -32601)')!, /paginated thread format/);
  assert.match(codexTerminalFailure('paginated threads require thread/items/list support')!, /paginated thread format/);
  assert.equal(codexTerminalFailure('Error: some unrelated failure'), null);
});
