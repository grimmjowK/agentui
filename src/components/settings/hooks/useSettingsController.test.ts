import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  computeAntigravityStoragePayload,
  normalizeMainTab,
} from './useSettingsController';

test('normalizeMainTab 支援 about 分頁並保留 tools 相容回退', () => {
  assert.equal(normalizeMainTab('about'), 'about');
  assert.equal(normalizeMainTab('agents'), 'agents');
  assert.equal(normalizeMainTab('tools'), 'agents');
  assert.equal(normalizeMainTab('unknown-tab'), 'agents');
});

test('computeAntigravityStoragePayload：未選 bypassPermissions 時不擅自將 explicitConsent 改為 true', () => {
  const fromEmpty = computeAntigravityStoragePayload('default', {}, '2026-11-24T00:00:00Z');
  assert.equal(fromEmpty.explicitConsent, false);
  assert.equal(fromEmpty.skipPermissions, false);

  const chooseBypass = computeAntigravityStoragePayload('bypassPermissions', {}, '2026-11-24T00:00:00Z');
  assert.equal(chooseBypass.explicitConsent, true);
  assert.equal(chooseBypass.skipPermissions, true);

  const switchBack = computeAntigravityStoragePayload('auto', { explicitConsent: true }, '2026-11-24T00:00:00Z');
  assert.equal(switchBack.explicitConsent, true, '先前已同意過則保留既有記錄');
  assert.equal(switchBack.skipPermissions, false);
});

test('i18n 翻譯檔完整性：en 與 zh-CN settings.json 包含重構新增的所有導覽、權限與 MCP/Skills 鍵，且 ja/sidebar.json 保留 modeProjects', () => {
  const root = path.resolve(import.meta.dirname, '../../../..');
  const enSettings = JSON.parse(readFileSync(path.join(root, 'src/i18n/locales/en/settings.json'), 'utf8'));
  const zhSettings = JSON.parse(readFileSync(path.join(root, 'src/i18n/locales/zh-CN/settings.json'), 'utf8'));
  const jaSidebar = JSON.parse(readFileSync(path.join(root, 'src/i18n/locales/ja/sidebar.json'), 'utf8'));

  for (const locale of [enSettings, zhSettings]) {
    assert.ok(locale.searchPlaceholder);
    assert.ok(locale.navGroups?.general);
    assert.ok(locale.navGroups?.coding);
    assert.ok(locale.navGroups?.integrations);
    assert.ok(locale.permissions?.defaultMode?.label);
    assert.ok(locale.permissions?.defaultMode?.claudeDescription);
    assert.ok(locale.permissions?.defaultMode?.cursorDescription);
    assert.ok(locale.mcpServers?.description?.antigravity);
    assert.ok(locale.mcpServers?.addGlobalButton);
    assert.ok(locale.mcpServers?.addProviderButton);
    assert.ok(locale.mcpServers?.globalAddDescription);
    assert.ok(locale.mcpServers?.providerAddDescription);
    assert.ok(locale.mcpServers?.globalModalDescription);
    assert.ok(locale.mcpServers?.syncingProjectScopes);
    assert.ok(locale.mcpServers?.loading);
    assert.ok(locale.skills?.loading);
    assert.ok(locale.about?.description);
    assert.ok(locale.about?.license);
    assert.ok(locale.about?.starOnGithub);
  }

  // 英文語系不得混入中文
  assert.doesNotMatch(JSON.stringify(enSettings.navGroups), /[\u4e00-\u9fff]/);
  assert.doesNotMatch(enSettings.searchPlaceholder, /[\u4e00-\u9fff]/);
  assert.ok(jaSidebar.search?.modeProjects);
});
