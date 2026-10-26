import assert from 'node:assert/strict';
import test from 'node:test';

import { getAllSessions, getProjectLastActivity } from './utils';

test('Antigravity history remains selectable with its provider and activity timestamp', () => {
  const project = {
    projectId: 'project', displayName: 'Project', fullPath: '/workspace',
    geminiSessions: [{ id: 'old-gemini', lastActivity: '2026-10-20T00:00:00Z' }],
    antigravitySessions: [{ id: 'native-agy', lastActivity: '2026-10-23T00:00:00Z' }],
  };
  assert.deepEqual(getAllSessions(project).map(({ id, __provider }) => ({ id, __provider })), [
    { id: 'native-agy', __provider: 'antigravity' },
    { id: 'old-gemini', __provider: 'gemini' },
  ]);
  assert.equal(getProjectLastActivity(project).toISOString(), '2026-10-23T00:00:00.000Z');
});
