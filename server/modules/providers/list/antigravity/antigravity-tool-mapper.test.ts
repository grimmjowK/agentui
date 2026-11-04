import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { mapAgyStepUpdate } from '@/modules/providers/list/antigravity/antigravity-tool-mapper.js';
import { AntigravitySessionsProvider } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../docs/fixtures/antigravity');

function liveMessages(name: string) {
  return fs.readFileSync(path.join(fixturesDir, `${name}.stream.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .flatMap((event) => {
      const mapped = event.step_update ? mapAgyStepUpdate(event.step_update) : null;
      return mapped ? [mapped] : [];
    });
}

async function historyMessages(name: string) {
  // 把 fixture 放進暫存的 ANTIGRAVITY_HOME，讓 fetchHistory 走真實的檔案解析路徑
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fixture-'));
  const sessionId = `fixture-${name}`;
  const logs = path.join(home, 'brain', sessionId, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.copyFileSync(path.join(fixturesDir, `${name}.transcript.jsonl`), path.join(logs, 'transcript.jsonl'));
  const previous = process.env.ANTIGRAVITY_HOME;
  process.env.ANTIGRAVITY_HOME = home;
  try {
    const result = await new AntigravitySessionsProvider().fetchHistory(sessionId);
    return result.messages as any[];
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('即時與歷史：toolId、toolName、file_path/command 一致', async () => {
  const live = liveMessages('multistep').filter((m) => m.kind === 'tool_use');
  const history = (await historyMessages('multistep')).filter((m) => m.kind === 'tool_use');

  const key = (m: any) => [m.toolId, m.toolName, m.toolInput.file_path ?? m.toolInput.command];
  assert.deepEqual(history.map(key), live.map(key));
  assert.deepEqual(live.map((m) => m.toolName), ['Write', 'Bash', 'Read', 'Bash', 'Edit', 'Write', 'Bash', 'Bash', 'Bash', 'Edit']);
});

test('run_command 映射為 Bash，非零結束碼標為錯誤', async () => {
  const live = liveMessages('multistep');
  const bash = live.find((m) => m.kind === 'tool_use' && m.toolInput.command === 'ls /nonexistent_dir_xyz');
  assert.ok(bash);
  const result = live.find((m) => m.kind === 'tool_result' && m.toolId === bash.toolId);
  assert.equal(result?.isError, true);

  const history = await historyMessages('multistep');
  const historyBash = history.find((m) => m.toolId === bash.toolId);
  assert.equal(historyBash?.toolName, 'Bash');
  assert.equal(historyBash?.toolResult?.isError, true);
  assert.equal(history.find((m) => m.toolInput?.command === 'ls -la')?.toolResult?.isError, false);
});

test('歷史帶有完整參數：Edit 的 old/new 字串、Write 的內容', async () => {
  const history = await historyMessages('multistep');
  const edit = history.find((m) => m.toolName === 'Edit' && String(m.toolInput.file_path).endsWith('calc.py'));
  assert.match(String(edit?.toolInput.old_string), /a - b/);
  assert.match(String(edit?.toolInput.new_string), /a \+ b/);
  const readme = history.find((m) => m.toolName === 'Write' && String(m.toolInput.file_path).endsWith('README.md'));
  assert.match(String(readme?.toolInput.content), /calculator/);
});

test('工具錯誤（state ERROR / status ERROR）在兩條路徑都標為錯誤；search_web 映射為 WebSearch', async () => {
  const live = liveMessages('tool-error');
  const errorResult = live.find((m) => m.kind === 'tool_result' && m.isError);
  assert.equal(errorResult?.content, 'file does not exist');
  assert.equal(live.find((m) => m.kind === 'tool_use' && m.toolName === 'WebSearch')?.toolInput.query, 'python enumerate 用法');

  const history = await historyMessages('tool-error');
  const missing = history.find((m) => String(m.toolInput?.file_path).endsWith('missing.py'));
  assert.equal(missing?.toolId, errorResult?.toolId);
  assert.equal(missing?.toolResult?.isError, true);
});

test('未登記的工具保留原名與原參數', () => {
  const mapped = mapAgyStepUpdate({
    step_type: 'tool', state: 'ACTIVE', step_index: 9, tool_name: 'grep_search', tool_info: { parameters: { Query: 'x' } },
  });
  assert.deepEqual(mapped, { kind: 'tool_use', toolId: 'agy_tool_9', toolName: 'grep_search', toolInput: { Query: 'x' } });
});
