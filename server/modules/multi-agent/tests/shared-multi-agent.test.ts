import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultChatRules,
  extractDefinitionBlock,
  layerWorkflow,
  resolveMentions,
  validateDefinition,
  validateModels,
  type WorkflowDef,
} from '../../../../shared/multiAgent.js';

const node = (id: string, dependsOn: string[] = []) => ({
  id, title: id, instruction: `do ${id}`, provider: 'claude' as const, model: 'sonnet', dependsOn,
});
const wf = (...nodes: ReturnType<typeof node>[]): WorkflowDef => ({ nodes });

test('layerWorkflow: 線性、分叉、匯合', () => {
  assert.deepEqual(layerWorkflow(wf(node('a'), node('b', ['a']), node('c', ['b']))), [['a'], ['b'], ['c']]);
  assert.deepEqual(layerWorkflow(wf(node('a'), node('b', ['a']), node('c', ['a']))), [['a'], ['b', 'c']]);
  assert.deepEqual(layerWorkflow(wf(node('a'), node('b'), node('c', ['a', 'b']))), [['a', 'b'], ['c']]);
});

test('layerWorkflow: 環與缺失依賴回傳 null', () => {
  assert.equal(layerWorkflow(wf(node('a', ['b']), node('b', ['a']))), null);
  assert.equal(layerWorkflow(wf(node('a', ['x']))), null);
});

test('validateDefinition: 工作流', () => {
  assert.deepEqual(validateDefinition('workflow', wf(node('a'), node('b', ['a']))), []);
  assert.match(validateDefinition('workflow', wf(node('a', ['b']), node('b', ['a']))).join(), /環/);
  assert.match(validateDefinition('workflow', wf(node('a', ['x']))).join(), /不存在/);
  assert.match(validateDefinition('workflow', wf(node('a'), node('a'))).join(), /重複/);
  assert.match(validateDefinition('workflow', { nodes: [] }).join(), /節點數/);
  assert.match(validateDefinition('workflow', { nodes: [{ ...node('a'), permissionMode: 'plan', provider: 'codex' }] }).join(), /權限模式/);
});

test('validateDefinition: 聊天室', () => {
  const member = (id: string, name: string) => ({ id, name, persona: '', provider: 'claude' as const, model: 'sonnet' });
  const ok = { members: [member('a', '產品經理'), member('b', '審稿人')], rules: defaultChatRules(2) };
  assert.deepEqual(validateDefinition('chatroom', ok), []);
  assert.match(validateDefinition('chatroom', { ...ok, members: [member('a', '所有人')] }).join(), /保留字/);
  assert.match(validateDefinition('chatroom', { ...ok, members: [member('a', 'x'), member('b', 'X')] }).join(), /名稱重複/);
  assert.match(validateDefinition('chatroom', { ...ok, rules: { ...ok.rules, maxReplyChars: -1 } }).join(), /最大字數/);
  assert.match(validateDefinition('chatroom', { ...ok, rules: { ...ok.rules, maxAiRepliesPerTurn: 1.5 } }).join(), /回覆上限/);
});

test('validateModels: 清單外與無清單', () => {
  const def = wf(node('a'));
  assert.deepEqual(validateModels('workflow', def, { claude: ['sonnet'] }), []);
  assert.match(validateModels('workflow', def, { claude: ['opus'] }).join(), /不在/);
  assert.match(validateModels('workflow', def, {}).join(), /暫時無法驗證/);
});

test('extractDefinitionBlock: 合法、非法、多個取最後', () => {
  assert.equal(extractDefinitionBlock('no block'), null);
  assert.deepEqual(extractDefinitionBlock('```multi-agent-json\n{"a":1}\n```'), { value: { a: 1 } });
  assert.ok('error' in (extractDefinitionBlock('```multi-agent-json\n{bad}\n```') ?? {}));
  assert.deepEqual(
    extractDefinitionBlock('```multi-agent-json\n{"a":1}\n```\ntext\n```multi-agent-json\n{"a":2}\n```'),
    { value: { a: 2 } },
  );
});

test('resolveMentions', () => {
  const members = [{ id: 'pm', name: '產品經理' }, { id: 'rv', name: '審稿人' }];
  assert.deepEqual(resolveMentions('@產品經理 評估', members, 'all'), ['pm']);
  assert.deepEqual(resolveMentions('@所有人 各自說', members, 'none'), ['pm', 'rv']);
  assert.deepEqual(resolveMentions('沒有提及', members, 'all'), ['pm', 'rv']);
  assert.deepEqual(resolveMentions('沒有提及', members, 'none'), []);
  assert.deepEqual(resolveMentions('@審稿人，@產品經理 看看', members, 'none'), ['pm', 'rv']);
});

test('validateDefinition: 人工確認節點', () => {
  const gate = { id: 'g', title: 'g', instruction: 'x', type: 'approval', dependsOn: ['a'] };
  assert.deepEqual(validateDefinition('workflow', { nodes: [node('a'), gate] }), []);
  assert.match(validateDefinition('workflow', { nodes: [node('a'), { ...gate, provider: 'claude', model: 'sonnet' }] }).join(), /不需要/);
  assert.match(validateDefinition('workflow', { nodes: [{ ...gate, type: 'x', dependsOn: [] }] }).join(), /type/);
  assert.deepEqual(validateModels('workflow', { nodes: [node('a'), gate] } as WorkflowDef, { claude: ['sonnet'] }), []);
});
