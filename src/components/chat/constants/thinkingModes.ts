import { Atom, Brain, Gauge, Sparkles, Zap } from 'lucide-react';

/**
 * 推理强度（effort）档位。直接作为 SDK / app-server 参数传给后端，不再往消息里拼
 * `think hard:` 之类的关键字前缀 —— 新版 Claude Code 已用 effort 取代关键字触发。
 * `default` 表示不传参数，沿用 CLI 自身默认（Claude 为 high）。
 */
export const thinkingModes = [
  { id: 'default', icon: null, color: 'text-gray-600' },
  { id: 'low', icon: Gauge, color: 'text-gray-500' },
  { id: 'medium', icon: Brain, color: 'text-blue-600' },
  { id: 'high', icon: Zap, color: 'text-purple-600' },
  { id: 'xhigh', icon: Sparkles, color: 'text-indigo-600' },
  { id: 'max', icon: Atom, color: 'text-red-600' },
];

/** Codex 没有 max 档 */
export function thinkingModesFor(provider: string) {
  return provider === 'codex' ? thinkingModes.filter((mode) => mode.id !== 'max') : thinkingModes;
}

/** 当前 provider 实际生效的档位：在 Claude 选的 max 切到 Codex 时按 xhigh 处理 */
export function resolveEffort(provider: string, mode: string): string {
  return provider === 'codex' && mode === 'max' ? 'xhigh' : mode;
}

export const EFFORT_STORAGE_KEY = 'reasoningEffort';
