import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSessionMentionLabel,
  extractKnownSessionMentionLabels,
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

    // 同一 session 改名後釋放舊標籤，新 session 可沿用原本的標題而不必加序號
    const renamed = createSessionMentionLabel('新標題', '@session:first');
    assert.equal(renamed, '@session["新標題"]');
    const reused = createSessionMentionLabel(title, '@session:third');
    assert.equal(reused, first);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
