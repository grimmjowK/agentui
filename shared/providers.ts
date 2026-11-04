/**
 * Provider 資訊表（design D10）：前後端共用的 provider 清單、能力與權限模式。
 *
 * 新增 provider 時在這裡加一列；`LLMProvider` 由此推導，漏加的地方會在 typecheck 報錯。
 * 名稱、圖示由前端 i18n 與資源處理，不放進這張表。
 */

export const PROVIDER_IDS = ['claude', 'cursor', 'codex', 'antigravity'] as const;

export type LLMProvider = (typeof PROVIDER_IDS)[number];

export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan';

export type ProviderCapabilities = {
  /** 執行中可追加指令而不中斷（turn/steer）。 */
  midTurnSteer: boolean;
  /** 送出時附帶上傳的圖片。 */
  images: boolean;
  /** 支援推理強度選擇。 */
  effort: boolean;
  /** 提供會話產物（Session Artifacts）側邊欄。 */
  artifacts: boolean;
};

export type ProviderInfo = {
  capabilities: ProviderCapabilities;
  /** 輸入區可循環切換的權限模式，依顯示順序。 */
  permissionModes: PermissionMode[];
  /** 沒有記錄時的預設權限模式。 */
  defaultPermissionMode: PermissionMode | (() => PermissionMode);
  /** 送出前把 UI 權限模式轉成 runtime 接受的值。 */
  mapPermissionMode?: (mode: PermissionMode) => PermissionMode;
  /** 前端工具設定在 localStorage 的鍵。 */
  settingsStorageKey: string;
};

/** Antigravity headless 模式無法互動審批：使用者明確同意跳過權限時預設 bypass。 */
function antigravityDefaultPermissionMode(): PermissionMode {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem('antigravity-settings');
    const settings = JSON.parse(raw || '{}');
    return settings.explicitConsent === true && settings.skipPermissions === true ? 'bypassPermissions' : 'default';
  } catch {
    return 'default';
  }
}

export const PROVIDER_INFO: Record<LLMProvider, ProviderInfo> = {
  claude: {
    capabilities: { midTurnSteer: false, images: true, effort: true, artifacts: false },
    permissionModes: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    settingsStorageKey: 'claude-settings',
  },
  cursor: {
    capabilities: { midTurnSteer: false, images: false, effort: false, artifacts: false },
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    settingsStorageKey: 'cursor-tools-settings',
  },
  codex: {
    capabilities: { midTurnSteer: true, images: false, effort: true, artifacts: false },
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
    defaultPermissionMode: 'default',
    mapPermissionMode: (mode) => (mode === 'plan' ? 'default' : mode),
    settingsStorageKey: 'codex-settings',
  },
  antigravity: {
    capabilities: { midTurnSteer: false, images: false, effort: false, artifacts: false },
    permissionModes: ['default', 'bypassPermissions'],
    defaultPermissionMode: antigravityDefaultPermissionMode,
    settingsStorageKey: 'antigravity-settings',
  },
};

export function isLLMProvider(value: unknown): value is LLMProvider {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function getDefaultPermissionMode(provider: LLMProvider): PermissionMode {
  const mode = PROVIDER_INFO[provider].defaultPermissionMode;
  return typeof mode === 'function' ? mode() : mode;
}
