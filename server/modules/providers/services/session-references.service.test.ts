import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '@/shared/types.js';

import {
  extractSessionMentionIds,
  renderSessionTranscript,
  SESSION_REFERENCE_NOTE_HEADER,
} from './session-references.service.js';

test('extractSessionMentionIds 去重、限制字符集与数量', () => {
  assert.deepEqual(
    extractSessionMentionIds('看 @session:abc-1 和 @session:abc-1 还有 @session:x_2;rm'),
    ['abc-1', 'x_2'],
  );
  assert.deepEqual(extractSessionMentionIds('没有引用 @src/a.ts'), []);
  const many = Array.from({ length: 8 }, (_, i) => `@session:s${i}`).join(' ');
  assert.equal(extractSessionMentionIds(many).length, 5);
});

test('renderSessionTranscript 保留对话文字、截断工具输出、跳过 thinking', () => {
  const base = { sessionId: 's1', timestamp: '2026-11-13T00:00:00Z', provider: 'codex' as const };
  const messages: NormalizedMessage[] = [
    { ...base, id: '1', kind: 'text', role: 'user', content: '帮我修 bug' },
    { ...base, id: '2', kind: 'thinking', content: '内部思考' },
    { ...base, id: '3', kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'ls' }, toolResult: { content: 'x'.repeat(600) } },
    { ...base, id: '4', kind: 'text', role: 'assistant', content: '修好了' },
  ];
  const out = renderSessionTranscript({ sessionId: 's1', title: '修 bug', provider: 'codex', projectPath: '/p' }, messages);
  assert.match(out, /^# 修 bug/);
  assert.match(out, /## User .*\n\n帮我修 bug/);
  assert.match(out, /## Assistant .*\n\n修好了/);
  assert.match(out, /\[tool\] Bash: \{"command":"ls"\}/);
  assert.match(out, /\(\+100 chars\)/);
  assert.doesNotMatch(out, /内部思考/);
});

test('引用说明头以前端剥除正则可识别的形式开头', () => {
  assert.ok(SESSION_REFERENCE_NOTE_HEADER.startsWith('[Referenced sessions:'));
  assert.ok(SESSION_REFERENCE_NOTE_HEADER.endsWith(']'));
  assert.ok(!SESSION_REFERENCE_NOTE_HEADER.includes('\n'));
});
