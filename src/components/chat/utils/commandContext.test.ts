import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getCommandUserText, splitCommandContext, wrapCommandContext } from './commandContext';

test('信封往返：拆出注入正文与用户输入，空输入回退命令名', () => {
  const body = '### 前置约束\n1. 不要臆测\n</branch>';
  assert.deepEqual(splitCommandContext(wrapCommandContext('/dm-pm', body, '19843: 接入 workflow')), {
    text: '19843: 接入 workflow',
    injectedContext: body,
  });
  assert.deepEqual(splitCommandContext(wrapCommandContext('/dm-pm', body, '')), { text: '/dm-pm', injectedContext: body });
  assert.equal(splitCommandContext('普通消息 <command-context name="x">'), null);
});

test('直接輸入命令的參數放在信封外，保留多行文字，無參數時顯示命令名', () => {
  const userText = getCommandUserText('/review', '/review 檢查登入流程\n  保留縮排');
  assert.equal(userText, '檢查登入流程\n  保留縮排');
  assert.deepEqual(splitCommandContext(wrapCommandContext('/review', '已展開的模板', userText)), {
    text: userText,
    injectedContext: '已展開的模板',
  });
  assert.equal(getCommandUserText('/review', '/review'), '');
  assert.equal(getCommandUserText('/review', '/review-other 參數'), '');
});
