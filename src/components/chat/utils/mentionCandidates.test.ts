import assert from 'node:assert/strict';
import test from 'node:test';

import { filterMentionCandidates } from './mentionCandidates';

const files = Array.from({ length: 15 }, (_, i) => ({ name: `f${i}.md`, path: `docs/f${i}.md` }));
const sessions = Array.from({ length: 30 }, (_, i) => ({ name: i === 7 ? '修 auth 鉴权' : `会话${i}`, path: `@session:id-${i}` }));

test('默认：文件在前最多 10 笔，会话在后最多 5 笔', () => {
  const out = filterMentionCandidates('', files, sessions);
  assert.equal(out.length, 15);
  assert.equal(out[0].path, 'docs/f0.md');
  assert.equal(out[10].path, '@session:id-0');
});

test('session 模式：只列会话、最多 20 笔，session: 后按标题或 id 过滤', () => {
  assert.equal(filterMentionCandidates('session', files, sessions).length, 20);
  assert.ok(filterMentionCandidates('Sess', files, sessions).every((c) => c.path.startsWith('@session:')));
  assert.deepEqual(filterMentionCandidates('session:auth', files, sessions).map((c) => c.path), ['@session:id-7']);
  assert.deepEqual(filterMentionCandidates('session:id-29', files, sessions).map((c) => c.path), ['@session:id-29']);
});
