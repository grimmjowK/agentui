import assert from 'node:assert/strict';
import test from 'node:test';

import { AntigravitySessionsProvider } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import { parseAntigravitySessionPath } from '@/modules/providers/list/antigravity/antigravity-session-synchronizer.provider.js';

const provider = new AntigravitySessionsProvider();

test('normalizeMessage parses text and kind records', () => {
  const [msg] = provider.normalizeMessage(
    { role: 'user', text: 'Hello Antigravity' },
    's-1',
  );
  assert.equal(msg.kind, 'text');
  assert.equal(msg.role, 'user');
  assert.equal(msg.content, 'Hello Antigravity');
  assert.equal(msg.provider, 'antigravity');
});

test('parseAntigravitySessionPath extracts conversation id from brain paths', () => {
  const samplePath = '/Users/username/.gemini/antigravity/brain/d9bc5a72-f456-487a-9724-6db040c4d79a/.system_generated/logs/transcript.jsonl';
  assert.equal(
    parseAntigravitySessionPath(samplePath),
    'd9bc5a72-f456-487a-9724-6db040c4d79a',
  );

  const flatPath = '/Users/username/.gemini/antigravity/brain/session-abc-123/transcript.jsonl';
  assert.equal(
    parseAntigravitySessionPath(flatPath),
    'session-abc-123',
  );

  assert.equal(parseAntigravitySessionPath('/some/other/path.jsonl'), null);
  assert.equal(
    parseAntigravitySessionPath('/data/brain/antigravity/brain/native-id/transcript.jsonl'),
    'native-id',
  );
});

test('fetchHistory handles limit: 0 gracefully', async () => {
  const emptyResult = await provider.fetchHistory('any-session-id', { limit: 0 });
  assert.equal(emptyResult.messages.length, 0);
  assert.equal(emptyResult.hasMore, false);
  assert.equal(emptyResult.limit, 0);
});

test('listBrainArtifacts 只回傳會話目錄頂層的 .md，且不越出 brain 根目錄', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { listBrainArtifacts } = await import('@/modules/providers/list/antigravity/antigravity-sessions.provider.js');

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  const root = path.join(base, 'brain');
  const session = path.join(root, 's1');
  fs.mkdirSync(path.join(session, '.system_generated', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(session, 'task.md'), '# 任務清單\n- [x] a\n');
  fs.writeFileSync(path.join(session, 'task.md.metadata.json'), '{}');
  fs.writeFileSync(path.join(session, '.system_generated', 'logs', 'notes.md'), 'internal');
  fs.writeFileSync(path.join(base, 'secret.md'), 'outside');
  fs.symlinkSync(path.join(base, 'secret.md'), path.join(session, 'leak.md'));
  fs.symlinkSync(base, path.join(root, 'escape'));

  const artifacts = await listBrainArtifacts('s1', [root]);
  assert.deepEqual(artifacts.map((a) => [a.fileName, a.title]), [['task.md', '任務清單']]);
  assert.match(artifacts[0].content, /- \[x\] a/);

  // 路徑穿越與指向外部的會話目錄都不讀取
  assert.deepEqual(await listBrainArtifacts('../../etc', [root]), []);
  assert.deepEqual(await listBrainArtifacts('escape', [root]), []);
  assert.deepEqual(await listBrainArtifacts('missing', [root]), []);
});

test('fetchHistory 略過 CLI 寫給模型的 SYSTEM_MESSAGE 步驟', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-'));
  const logs = path.join(home, 'brain', 'sys-1', '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'transcript.jsonl'), [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-04T09:18:18Z', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' },
    { step_index: 1, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: '2026-11-04T09:18:18Z', content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user. ... server restart ...' },
    { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-04T09:18:20Z', content: 'hello' },
  ].map((entry) => JSON.stringify(entry)).join('\n'));

  const previous = process.env.ANTIGRAVITY_HOME;
  process.env.ANTIGRAVITY_HOME = home;
  try {
    const { messages } = await provider.fetchHistory('sys-1');
    assert.deepEqual(messages.map((m) => [m.role, m.content]), [['user', 'hi'], ['assistant', 'hello']]);
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = previous;
  }
});

test('fetchHistory 與搜尋優先讀未截斷的 transcript_full.jsonl', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-'));
  const logs = path.join(home, 'brain', 'full-1', '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const write = (name: string, reply: string) => fs.writeFileSync(path.join(logs, name), [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-04T09:18:18Z', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-04T09:18:20Z', content: reply },
  ].map((entry) => JSON.stringify(entry)).join('\n'));
  write('transcript.jsonl', 'head\n<truncated 5112 bytes>\ntail');
  write('transcript_full.jsonl', 'head middle tail');

  const previous = process.env.ANTIGRAVITY_HOME;
  process.env.ANTIGRAVITY_HOME = home;
  try {
    const { messages } = await provider.fetchHistory('full-1');
    assert.equal(messages.at(-1)?.content, 'head middle tail');
    const searchable = [];
    for await (const m of provider.extractSearchableMessages(provider.resolveSearchablePath(path.join(logs, 'transcript.jsonl')))) searchable.push(m.text);
    assert.deepEqual(searchable, ['hi', 'head middle tail']);
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = previous;
  }
});
