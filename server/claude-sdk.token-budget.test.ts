import assert from 'node:assert/strict';
import test from 'node:test';

import { extractTokenBudget } from './claude-sdk.js';

test('extractTokenBudget 用最后一次主线程调用计算上下文占用，分母取 SDK 的 contextWindow', () => {
  const lastUsage = { input_tokens: 10, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 2_000, output_tokens: 500 };
  const result = {
    type: 'result',
    // 累计值远大于实际上下文，不能被采用
    modelUsage: {
      'claude-opus-4-8': { inputTokens: 900_000, cacheReadInputTokens: 5_000_000, contextWindow: 1_000_000 },
      'claude-haiku-4-5': { inputTokens: 1_000, contextWindow: 200_000 },
    },
  };

  assert.deepEqual(extractTokenBudget(result, lastUsage, 'claude-opus-4-8'), { used: 52_510, total: 1_000_000 });
  // 模型名对不上 modelUsage 的键时，退回最大的 contextWindow
  assert.deepEqual(extractTokenBudget(result, lastUsage, 'claude-opus-4-8[1m]'), { used: 52_510, total: 1_000_000 });
  // 本轮没有主线程调用（例如立即中断）时不发送
  assert.equal(extractTokenBudget(result, null, null), null);
});
