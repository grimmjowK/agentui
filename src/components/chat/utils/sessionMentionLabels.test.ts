import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSessionMentionLabel,
  extractKnownSessionMentionLabels,
  findUnresolvedSessionMentionLabels,
  formatSessionMentionsForDisplay,
  resolveSessionMentionLabels,
} from './sessionMentionLabels';

test('標題包含空白及特殊字元、同名引用仍對應各自的 ID', () => {
  const saved = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    },
  });
  try {
    const title = '修復 "聊天" [輸入] \\ 問題';
    const first = createSessionMentionLabel(title, '@session:first');
    const second = createSessionMentionLabel(title, '@session:second');
    assert.ok(first.includes('聊天'));
    assert.notEqual(first, second);
    assert.equal(createSessionMentionLabel(title, '@session:first'), first);
    assert.deepEqual(
      extractKnownSessionMentionLabels(`比較 ${first} 和 @session["未知"] 與 ${second}`),
      [first, second],
    );
    assert.equal(resolveSessionMentionLabels(`比較 ${first} 和 ${second} ${first}`),
      '比較 @session:first 和 @session:second @session:first');
    assert.equal(resolveSessionMentionLabels('@session:legacy @session["未知"]'),
      '@session:legacy @session["未知"]');
    assert.ok(saved.get('session_mention_labels')?.includes('@session:first'));

    assert.deepEqual(findUnresolvedSessionMentionLabels(`${first} @session["未知"]`), ['@session["未知"]']);
    assert.equal(formatSessionMentionsForDisplay('看 @session:first 和 @session:legacy'), `看 ${first} 和 @session:legacy`);

    // 改名後舊標籤仍指向原 ID，且不會被分給同名的其他會話（避免草稿/佇列中的舊標籤指錯）
    const renamed = createSessionMentionLabel('新標題', '@session:first');
    assert.equal(renamed, '@session["新標題"]');
    assert.equal(resolveSessionMentionLabels(first), '@session:first');
    const third = createSessionMentionLabel(title, '@session:third');
    assert.notEqual(third, first);
    assert.equal(resolveSessionMentionLabels(third), '@session:third');
    // 氣泡顯示使用最近一次的標題
    assert.equal(formatSessionMentionsForDisplay('@session:first'), renamed);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
