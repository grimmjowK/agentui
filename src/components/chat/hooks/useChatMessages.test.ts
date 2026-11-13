import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { normalizedToChatMessages } from './useChatMessages';
import { getCommandUserText, wrapCommandContext } from '../utils/commandContext';

const note = (status: string, summary: string): NormalizedMessage => ({
  id: `n-${status}`, sessionId: 's', timestamp: '2026-11-05T12:00:00Z', provider: 'antigravity',
  kind: 'task_notification', status, summary,
});

test('warning/error 的 task_notification 顯示為警告；info 不顯示', () => {
  const out = normalizedToChatMessages([
    note('info', 'Codex 0.163.0 · /usr/local/bin/codex'),
    note('warning', '需要審批的工具已被自動拒絕'),
    note('error', '會話被其他終端機佔用'),
  ]);
  assert.deepEqual(out.map((m) => [m.type, m.content]), [
    ['warning', '需要審批的工具已被自動拒絕'],
    ['warning', '會話被其他終端機佔用'],
  ]);
});

test('image-only user messages remain visible after refresh without broken thumbnails', () => {
  const out = normalizedToChatMessages([{
    id: 'user:11111111-1111-4111-8111-111111111111',
    sessionId: 's',
    timestamp: '2026-11-07T12:00:00Z',
    provider: 'codex',
    kind: 'text',
    role: 'user',
    content: '',
    images: [{ name: 'image.png', byteLength: 3 } as never],
    seq: 1,
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'user');
  assert.equal(out[0].images?.length, 0);
});

test('手動斜線命令回放只顯示使用者參數，模板仍可作為原始參數查看', () => {
  const userText = getCommandUserText('/review', '/review 檢查登入流程\n  包含逾時情況');
  const [message] = normalizedToChatMessages([{
    id: 'command-user', sessionId: 's', timestamp: '2026-11-13T12:00:00Z',
    provider: 'claude', kind: 'text', role: 'user',
    content: wrapCommandContext('/review', '審查模板：檢查登入流程', userText),
  }]);
  assert.equal(message.content, userText);
  assert.equal(message.injectedContext, '審查模板：檢查登入流程');
});

test('帶縮圖且無額外文字的命令訊息回放時，剝除圖片路徑說明後仍回退顯示命令名', () => {
  const rawContent = `${wrapCommandContext('/review', '審查模板', '')}\n\n[Images provided at the following paths:]\n1. /tmp/img.png`;
  const [message] = normalizedToChatMessages([{
    id: 'command-image-user', sessionId: 's', timestamp: '2026-11-13T12:00:00Z',
    provider: 'claude', kind: 'text', role: 'user',
    content: rawContent,
    images: [{ data: 'data:image/png;base64,AAAA', name: 'img.png' }],
  }]);
  assert.equal(message.content, '/review');
  assert.equal(message.injectedContext, '審查模板');
});
