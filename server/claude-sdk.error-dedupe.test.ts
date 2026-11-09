import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldSuppressClaudeWrappedError } from './claude-sdk.js';

test('Claude suppresses an SDK wrapper when the same API error was already emitted as text', () => {
  assert.equal(
    shouldSuppressClaudeWrappedError(
      'API Error: 529 overloaded',
      'Claude Code failed: API Error: 529 overloaded',
    ),
    true,
  );
  assert.equal(
    shouldSuppressClaudeWrappedError('Working on it', 'Claude Code failed'),
    false,
  );
});
