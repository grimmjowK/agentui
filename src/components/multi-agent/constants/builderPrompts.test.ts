import assert from 'node:assert/strict';
import test from 'node:test';

import { splitCommandContext, wrapCommandContext } from '../../chat/utils/commandContext';

import { buildBuilderPrompt, DEFINITION_LANGUAGE } from './builderPrompts';

test('建立器說明以信封附加，氣泡只顯示使用者原文', () => {
  const prompt = buildBuilderPrompt('workflow', [{ provider: 'claude', models: ['sonnet'] }], null);
  const wrapped = wrapCommandContext('multi-agent-builder', prompt, '整理 issue 並寫摘要');
  const split = splitCommandContext(wrapped);
  assert.equal(split?.text, '整理 issue 並寫摘要');
  assert.match(split!.injectedContext, new RegExp(DEFINITION_LANGUAGE));
  assert.match(split!.injectedContext, /claude: sonnet/);
});

test('修改既有定義時附上目前定義', () => {
  const current = { members: [{ id: 'pm', name: '產品經理' }] };
  const prompt = buildBuilderPrompt('chatroom', [], current);
  assert.match(prompt, /目前的定義/);
  assert.match(prompt, /產品經理/);
  assert.doesNotMatch(buildBuilderPrompt('chatroom', [], null), /目前的定義/);
});
