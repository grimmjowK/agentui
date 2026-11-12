import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitCommandContext, wrapCommandContext } from './commandContext';

test('信封往返：拆出注入正文与用户输入，空输入回退命令名', () => {
  const body = '### 前置约束\n1. 不要臆测\n</branch>';
  assert.deepEqual(splitCommandContext(wrapCommandContext('/dm-pm', body, '19843: 接入 workflow')), {
    text: '19843: 接入 workflow',
    injectedContext: body,
  });
  assert.deepEqual(splitCommandContext(wrapCommandContext('/dm-pm', body, '')), { text: '/dm-pm', injectedContext: body });
  assert.equal(splitCommandContext('普通消息 <command-context name="x">'), null);
});
