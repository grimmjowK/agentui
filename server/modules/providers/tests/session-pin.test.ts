import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// PINNED_ROOT 在載入時由 os.homedir() 決定：先把 HOME 與資料庫指到暫存目錄再載入
const home = fs.mkdtempSync(path.join(tmpdir(), 'pin-home-'));
process.env.HOME = home;
process.env.DATABASE_PATH = path.join(home, 'auth.db');
const { initializeDatabase, sessionsDb } = await import('@/modules/database/index.js');
const { sessionPinService } = await import('@/modules/providers/services/session-pin.service.js');
const { AntigravitySessionsProvider } = await import('@/modules/providers/list/antigravity/antigravity-sessions.provider.js');

test('收藏的 Antigravity 會話連同 transcript_full.jsonl 一起備份；原檔被清掉後仍讀到完整內容', async () => {
  await initializeDatabase();
  const logs = path.join(home, 'brain', 'pin-1', '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const write = (name: string, reply: string) => fs.writeFileSync(path.join(logs, name), [
    { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-05T09:00:00Z', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' },
    { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-05T09:00:01Z', content: reply },
  ].map((entry) => JSON.stringify(entry)).join('\n'));
  write('transcript.jsonl', 'head\n<truncated 5112 bytes>\ntail');
  write('transcript_full.jsonl', 'head middle tail');
  const transcript = path.join(logs, 'transcript.jsonl');
  sessionsDb.createSession('pin-1', 'antigravity', '/tmp/pin', undefined, undefined, undefined, transcript);
  sessionsDb.updateSessionIsStarred('pin-1', true);

  await sessionPinService.syncPinnedTranscript('pin-1');
  fs.rmSync(path.join(home, 'brain'), { recursive: true, force: true });

  const pinned = await sessionPinService.resolveTranscriptPath('pin-1');
  assert.equal(path.basename(pinned ?? ''), 'transcript.jsonl');
  const { messages } = await new AntigravitySessionsProvider().fetchHistory('pin-1');
  assert.equal(messages.at(-1)?.content, 'head middle tail');
});

test('資料庫查詢拋錯或未就緒時，syncPinnedTranscript 靜默略過且 resolveTranscriptPath 回退到備份', async () => {
  const originalGet = sessionsDb.getSessionById;
  (sessionsDb as any).getSessionById = () => {
    throw new Error('Database not ready');
  };
  try {
    await assert.doesNotReject(async () => {
      await sessionPinService.syncPinnedTranscript('pin-error');
    });

    const result = await sessionPinService.resolveTranscriptPath('pin-error');
    assert.equal(result, null);
  } finally {
    sessionsDb.getSessionById = originalGet;
  }
});
