import assert from 'node:assert/strict';
import test from 'node:test';

import { createReconnectableWriter } from './antigravity-cli.js';

test('Antigravity live writer always forwards to the durable logging writer while disconnected', () => {
  const sent: unknown[] = [];
  const sockets: unknown[] = [];
  const baseWriter = {
    userId: 7,
    ws: { readyState: 3 },
    send(message: unknown) { sent.push(message); },
    updateWebSocket(ws: unknown) { sockets.push(ws); },
    setSessionId() {},
  };
  const liveWriter = createReconnectableWriter(baseWriter);

  liveWriter.send({ kind: 'tool_result', toolId: 'tool-1', content: 'done' });
  liveWriter.reconnect({ userId: 7, ws: { readyState: 1 } });

  assert.deepEqual(sent, [{ kind: 'tool_result', toolId: 'tool-1', content: 'done' }]);
  assert.deepEqual(sockets, [{ readyState: 1 }]);
});
