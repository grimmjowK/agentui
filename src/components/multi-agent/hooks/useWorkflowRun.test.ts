import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowRun } from '../types/types';
import { applyWorkflowRunEvent } from './useWorkflowRun';

const sampleRun: WorkflowRun = {
  id: 'run-1',
  multiAgentId: 'ma-1',
  status: 'running',
  definitionVersion: 1,
  definition: { nodes: [] },
  nodeStates: { a: { state: 'running', progress: 20 } },
  startInput: null,
  startedAt: '2026-11-24T00:00:00Z',
  finishedAt: null,
};

test('applyWorkflowRunEvent：對已知 run 純函式更新單節點或整包狀態，未知 runId 回傳 null 不觸發副作用', () => {
  assert.equal(
    applyWorkflowRunEvent([sampleRun], {
      type: 'multi-agent-run',
      multiAgentId: 'ma-1',
      runId: 'unknown-run',
      status: 'running',
    }),
    null,
  );

  const updated = applyWorkflowRunEvent([sampleRun], {
    type: 'multi-agent-run',
    multiAgentId: 'ma-1',
    runId: 'run-1',
    status: 'succeeded',
    nodeId: 'a',
    node: { state: 'succeeded', progress: 100, output: 'OK' },
  });
  assert.ok(updated);
  assert.equal(updated[0].status, 'succeeded');
  assert.equal(updated[0].nodeStates.a.output, 'OK');
});
