import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  mapPlanUpdate,
  mapRolloutEntry,
  mapThreadItem,
  unwrapShellCommand,
  type MappedMessage,
} from '@/modules/providers/list/codex/codex-item-mapper.js';
import type { ThreadItem } from '@/modules/codex-runtime/index.js';

/** 測試只給出與映射相關的欄位，其餘協議欄位省略。 */
const item = (fields: Record<string, unknown>) => fields as unknown as ThreadItem;

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function mapFixture(name: string): MappedMessage[] {
  const splitIds = new Map<string, string[]>();
  return fs.readFileSync(path.join(fixturesDir, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => mapRolloutEntry(JSON.parse(line), splitIds));
}

const toolUses = (messages: MappedMessage[]) => messages.filter((m) => m.kind === 'tool_use');
const resultsById = (messages: MappedMessage[]) =>
  new Map(messages.filter((m) => m.kind === 'tool_result').map((m) => [m.toolId, m]));

test('即時 fileChange 與歷史 apply_patch 映射同構（新增/改名/刪除）', () => {
  const live = mapThreadItem(item({
    type: 'fileChange',
    id: 'item1',
    status: 'completed',
    changes: [
      { path: 'src/new.ts', kind: { type: 'add' }, diff: 'export const a = 1;\n' },
      { path: 'src/old.ts', kind: { type: 'update', move_path: 'src/renamed.ts' }, diff: '@@\n-const x = 1;\n+const x = 2;\n' },
      { path: 'src/gone.ts', kind: { type: 'delete' }, diff: '' },
    ],
  }), 'completed');
  const history = toolUses(mapFixture('rollout-0.163.jsonl')).filter((m) => ['Write', 'Edit'].includes(m.toolName));

  const shape = (m: MappedMessage) => [m.toolName, m.toolInput.file_path, m.toolInput.changeKind ?? null, m.toolInput.move_path ?? null];
  assert.deepEqual(live.map(shape), history.map(shape));
  assert.deepEqual(live.map(shape), [
    ['Write', 'src/new.ts', null, null],
    ['Edit', 'src/old.ts', 'move', 'src/renamed.ts'],
    ['Edit', 'src/gone.ts', 'delete', null],
  ]);
  assert.equal(live[1].toolInput.old_string, 'const x = 1;');
  assert.equal(live[1].toolInput.new_string, 'const x = 2;');
  assert.equal(history[0].toolInput.content, 'export const a = 1;');
});

test('即時多檔案拆分：id 與 toolId 皆為 ${itemId}:${index}，不互相覆蓋', () => {
  const started = mapThreadItem(item({
    type: 'fileChange', id: 'it', status: 'inProgress',
    changes: [{ path: 'a', kind: { type: 'add' }, diff: '+a' }, { path: 'b', kind: { type: 'add' }, diff: '+b' }],
  }), 'started');
  assert.deepEqual(started.map((m) => [m.id, m.toolId]), [['it:0', 'it:0'], ['it:1', 'it:1']]);
  assert.equal(started[0].toolResult, undefined);
});

test('歷史 apply_patch 的輸出展開配對到每一則拆分訊息', () => {
  const messages = mapFixture('rollout-0.163.jsonl');
  const results = resultsById(messages);
  for (const id of ['call_patch_1:0', 'call_patch_1:1', 'call_patch_1:2']) {
    assert.ok(results.has(id), `missing result for ${id}`);
    assert.equal(results.get(id)?.isError, false);
  }
  assert.equal(results.has('call_patch_1'), false);
});

test('0.163 指令類工具：exec_command/write_stdin/js/update_plan/web_search', () => {
  const messages = mapFixture('rollout-0.163.jsonl');
  const byId = new Map(toolUses(messages).map((m) => [m.toolId, m]));
  const results = resultsById(messages);

  assert.equal(byId.get('call_cmd_1')?.toolName, 'Bash');
  assert.deepEqual(byId.get('call_cmd_1')?.toolInput, { command: 'ls -la', cwd: '/repo' });
  assert.equal(results.get('call_cmd_1')?.isError, false);
  assert.equal(results.get('call_cmd_2')?.isError, true, 'Process exited with code 1 應標為錯誤');

  assert.equal(byId.get('call_stdin_1')?.toolName, 'TerminalInput');
  assert.deepEqual(byId.get('call_stdin_1')?.toolInput, { session_id: 42, chars: '' });

  assert.equal(byId.get('call_js_1')?.toolName, 'CodeRun');
  assert.equal(byId.get('call_js_1')?.toolInput.title, '統計');

  assert.deepEqual(byId.get('call_plan_1')?.toolInput, {
    todos: [{ content: '讀碼', status: 'completed' }, { content: '改碼', status: 'in_progress' }],
  });
  assert.deepEqual(byId.get('call_plan_2')?.toolInput, { todos: [{ content: '驗證', status: 'pending' }] });

  const search = toolUses(messages).find((m) => m.toolName === 'WebSearch');
  assert.equal(search?.toolInput.query, 'codex app-server');
});

test('0.143 舊版：exec 為 code mode、reasoning、壓縮邊界、未登記工具保留原名', () => {
  const messages = mapFixture('rollout-0.143.jsonl');
  const tools = toolUses(messages);
  assert.equal(tools.find((m) => m.toolId === 'call_exec_1')?.toolName, 'CodeRun');
  assert.equal(tools.find((m) => m.toolId === 'call_wait_1')?.toolName, 'wait');
  assert.equal(messages.find((m) => m.kind === 'thinking')?.content, '先看目錄');
  assert.ok(messages.some((m) => m.isCompactBoundary === true));
  assert.ok(resultsById(messages).has('call_exec_1'));
});

test('即時 commandExecution / reasoning / plan / 壓縮 / 未知項目', () => {
  const [cmd] = mapThreadItem(item({ type: 'commandExecution', id: 'c', command: 'ls', cwd: '/r', status: 'failed', exitCode: 2, aggregatedOutput: '' }), 'completed');
  assert.equal(cmd.toolName, 'Bash');
  assert.deepEqual(cmd.toolResult, { content: 'Exit code 2', isError: true });

  assert.deepEqual(mapThreadItem(item({ type: 'reasoning', id: 'r', summary: [], content: [] }), 'started'), []);
  assert.equal(mapThreadItem(item({ type: 'reasoning', id: 'r', summary: ['想'], content: [] }), 'completed')[0].kind, 'thinking');
  assert.equal(mapThreadItem(item({ type: 'contextCompaction', id: 'cc' }), 'completed')[0].isCompactBoundary, true);
  assert.equal(mapThreadItem(item({ type: 'webSearch', id: 'w', query: 'q', action: null }), 'completed')[0].toolName, 'WebSearch');
  assert.equal(mapThreadItem(item({ type: 'imageView', id: 'i', path: '/a.png' }), 'completed')[0].toolName, 'imageView');

  const [plan] = mapPlanUpdate({ turnId: 't1', plan: [{ step: 's', status: 'inProgress' }] });
  assert.equal(plan.id, 'plan:t1');
  assert.deepEqual(plan.toolInput.todos, [{ content: 's', status: 'in_progress' }]);
});

test('拆掉 app-server 指令的 shell 包裝，與歷史 exec_command 一致', () => {
  assert.equal(unwrapShellCommand('/bin/zsh -lc false'), 'false');
  assert.equal(unwrapShellCommand("/bin/zsh -lc 'ls src'"), 'ls src');
  assert.equal(unwrapShellCommand("bash -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
  assert.equal(unwrapShellCommand('ls -la'), 'ls -la');
  const [cmd] = mapThreadItem(item({ type: 'commandExecution', id: 'c', command: "/bin/zsh -lc 'ls src'", cwd: '/r', status: 'completed', exitCode: 0, aggregatedOutput: '' }), 'completed');
  assert.equal(cmd.toolInput.command, 'ls src');
});
