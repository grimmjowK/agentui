import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { AntigravitySessionsProvider } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import { searchConversations } from '@/modules/providers/services/session-conversations-search.service.js';

// node --test 每個檔案一個行程：在第一次連線前指定獨立的資料庫即可隔離。
process.env.DATABASE_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'search-')), 'auth.db');

const transcript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/fixtures/antigravity/multistep.transcript.jsonl',
);

test('Antigravity 只提取使用者輸入與模型回覆，不含工具輸出', async () => {
  const messages = [];
  for await (const message of new AntigravitySessionsProvider().extractSearchableMessages(transcript)) {
    messages.push(message);
  }

  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
  assert.match(messages[0].text, /^在當前目錄完成以下多步驟任務/);
  assert.match(messages[1].text, /^已完成所有 10 個步驟/);
  assert.ok(messages.every((m) => !m.text.includes('Created file.')));
});

test('搜尋結果包含 Antigravity 會話並附高亮片段；未實作提取的 provider 列在 unsearchableProviders', async () => {
  await initializeDatabase();
  sessionsDb.createSession('agy-1', 'antigravity', '/tmp/agy-probe', undefined, undefined, undefined, transcript);

  const result = await searchConversations('任務清單');

  assert.deepEqual(result.unsearchableProviders, ['cursor']);
  const [session] = result.results.flatMap((project) => project.sessions);
  assert.equal(session.sessionId, 'agy-1');
  assert.equal(session.provider, 'antigravity');
  assert.equal(session.matches[0].role, 'user');
  const { snippet, highlights } = session.matches[0];
  assert.equal(snippet.slice(highlights[0].start, highlights[0].end), '任務清單');
});
