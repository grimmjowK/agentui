/**
 * 模型清单服务。
 *
 * Claude 与 Codex 都能实时给出当前账号可用的模型（含第三方/代理模型），
 * 这里把它们统一成 `{ value, label, description }`，取不到时回落到
 * `shared/modelConstants.js` 的静态清单，保证 UI 永远有东西可选。
 *
 * Cursor / Gemini 目前没有可用的列举接口，直接走静态清单。
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import { resolveCodexExecutablePath } from '@/shared/codex-cli-path.js';
import type { LLMProvider } from '@/shared/types.js';

import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  CURSOR_MODELS,
  GEMINI_MODELS,
} from '../../../../shared/modelConstants.js';

export interface ProviderModel {
  value: string;
  label: string;
  description?: string;
}

export interface ProviderModelList {
  provider: LLMProvider;
  /** live = 从 CLI 实时取到；fallback = 回落到静态清单 */
  source: 'live' | 'fallback';
  models: ProviderModel[];
  /** source 为 fallback 且确实发生过错误时带上原因，便于前端/日志排查 */
  error?: string;
}

/** 实时查询超时。codex app-server 冷启动 + 网络请求，给足余量 */
const LOOKUP_TIMEOUT_MS = 20_000;
/** 缓存时长。模型清单变动极少，但用户换账号/改配置后不该等太久 */
const CACHE_TTL_MS = 5 * 60_000;

const FALLBACKS: Record<LLMProvider, { OPTIONS: ProviderModel[] }> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
  cursor: CURSOR_MODELS,
  gemini: GEMINI_MODELS,
};

const cache = new Map<LLMProvider, { expiresAt: number; value: ProviderModelList }>();

const withTimeout = async <T>(task: Promise<T>, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 查询超时（${LOOKUP_TIMEOUT_MS / 1000}s）`)), LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Claude：借 SDK 的控制通道调 supportedModels()。
 * prompt 传一个不产出任何消息的异步生成器 —— 只要控制请求，不要真的跑一轮对话。
 */
const listClaudeModels = async (): Promise<ProviderModel[]> => {
  async function* noPrompt(): AsyncGenerator<never> {
    // 故意不产出任何消息
  }

  const instance = query({
    prompt: noPrompt(),
    options: { pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH) },
  });

  try {
    const models = await instance.supportedModels();
    return models.map((model) => ({
      value: model.value,
      label: model.displayName || model.value,
      description: model.description || undefined,
    }));
  } finally {
    // 不 await：CLI 子进程收到中断后自行退出，不该拖住这次请求
    void Promise.resolve(instance.interrupt?.()).catch(() => {});
  }
};

interface CodexModelRow {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
}

/**
 * Codex：npm 包 @openai/codex-sdk 没有列举接口，走 `codex app-server` 的 JSON-RPC。
 */
const listCodexModels = (): Promise<ProviderModel[]> =>
  new Promise((resolve, reject) => {
    const codexCliPath = resolveCodexExecutablePath(process.env.CODEX_CLI_PATH);
    const child = spawn(codexCliPath, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false;

    const done = (err: Error | null, models?: ProviderModel[]) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已退出 */ }
      if (err) reject(err);
      else resolve(models ?? []);
    };

    const send = (payload: unknown) => {
      try { child.stdin.write(`${JSON.stringify(payload)}\n`); } catch { /* 进程已退出，交给 error/close */ }
    };

    child.once('error', (err) => done(err));
    child.once('close', (code) => done(new Error(`codex app-server 退出 (code=${code})，无法获取模型列表`)));

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let message: { id?: number; result?: { data?: CodexModelRow[] }; error?: { message?: string } };
      try {
        message = JSON.parse(line);
      } catch {
        return; // app-server 也会打印非 JSON 的日志行
      }

      if (message.id === 0) {
        send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        send({ jsonrpc: '2.0', id: 1, method: 'model/list', params: {} });
        return;
      }

      if (message.id !== 1) return;

      if (message.error) {
        done(new Error(message.error.message || 'model/list 返回错误'));
        return;
      }

      const rows = Array.isArray(message.result?.data) ? message.result.data : [];
      done(
        null,
        rows
          .filter((row) => row.hidden !== true)
          .map((row) => {
            const value = row.id || row.model || '';
            return { value, label: row.displayName || value, description: row.description || undefined };
          })
          .filter((model) => model.value),
      );
    });

    send({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { clientInfo: { name: 'cloudcli', title: 'CloudCLI UI', version: '1.0.0' } },
    });
  });

const fallbackFor = (provider: LLMProvider, error?: string): ProviderModelList => ({
  provider,
  source: 'fallback',
  models: FALLBACKS[provider].OPTIONS,
  ...(error ? { error } : {}),
});

export const providerModelsService = {
  /**
   * 取某个 provider 的可选模型。默认走 5 分钟缓存，`refresh` 为 true 时强制重查。
   * 任何失败都回落到静态清单而不是抛错 —— 选不到模型比选到旧模型严重得多。
   */
  async listProviderModels(provider: LLMProvider, { refresh = false } = {}): Promise<ProviderModelList> {
    const cached = cache.get(provider);
    if (!refresh && cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    if (provider !== 'claude' && provider !== 'codex') {
      return fallbackFor(provider);
    }

    let result: ProviderModelList;
    try {
      const models = await withTimeout(
        provider === 'claude' ? listClaudeModels() : listCodexModels(),
        provider,
      );
      result = models.length > 0
        ? { provider, source: 'live', models }
        : fallbackFor(provider, '实时清单为空');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[models] ${provider} 实时模型清单获取失败，回落到内置清单:`, reason);
      result = fallbackFor(provider, reason);
    }

    cache.set(provider, { expiresAt: Date.now() + CACHE_TTL_MS, value: result });
    return result;
  },
};
