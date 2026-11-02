#!/usr/bin/env node
/**
 * Codex app-server 协议最小 demo
 * ================================
 *
 * 演示 `codex app-server --listen stdio://` 的 JSON-RPC 2.0 长驻进程模式：
 * 一个进程、一次 initialize、一个 thread/start、一个 turn/start，
 * 监听服务端推送的增量通知直到本轮结束。
 *
 * 协议字段来自本仓库已安装的官方 CLI 自带命令：
 *   codex app-server generate-json-schema --out <dir>
 * 不是逆向猜测，也不涉及 ChatGPT.app 或任何私有协议。
 *
 * 用法：
 *   node scripts/demo/codex-app-server-client.mjs "你的 prompt"
 *
 * 依赖：本仓库 node_modules 下已安装的 @openai/codex-darwin-arm64（或对应平台包）。
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

/** 解析本仓库已安装的 codex 二进制路径（平台特定的 npm optional dependency）。 */
function resolveCodexBinary() {
  const candidates = [
    'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
    'node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex',
    'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-gnu/bin/codex',
  ];
  for (const rel of candidates) {
    const abs = path.join(repoRoot, rel);
    if (fs.existsSync(abs)) return abs;
  }
  throw new Error(
    '未找到已安装的 codex 二进制，请确认 @openai/codex-darwin-arm64 等平台包已随 npm install 落地。',
  );
}

/**
 * 最小 JSON-RPC 2.0 客户端，驱动一个长驻的 `codex app-server` 子进程。
 * 这个类是本次改造建议里提到的、可以直接抽到 server/ 下复用的部分。
 */
class AppServerClient {
  #child;
  #rl;
  #nextId = 1;
  #pending = new Map();
  #onNotification;

  constructor(codexBinary, { onNotification } = {}) {
    this.#onNotification = onNotification ?? (() => {});
    this.#child = spawn(codexBinary, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stderr.on('data', (chunk) => {
      // app-server 的日志走 stderr，demo 里原样打到自己的 stderr 方便调试。
      process.stderr.write(`[codex app-server stderr] ${chunk}`);
    });
    this.#rl = readline.createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    this.#rl.on('line', (line) => this.#handleLine(line));
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // 非 JSON 行（不应该出现在 stdout，忽略即可）
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      // 这是对某个请求的响应
      const pending = this.#pending.get(message.id);
      if (pending) {
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      // 服务端推送的通知（没有 id）或服务端发起的请求（有 id，demo 暂不处理 approval 类回调）
      this.#onNotification(message.method, message.params);
    }
  }

  /** 发一个 JSON-RPC 请求，返回 Promise<result>。 */
  request(method, params) {
    const id = this.#nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  close() {
    this.#rl.close();
    this.#child.kill();
  }
}

async function main() {
  const prompt = process.argv.slice(2).join(' ') || '用一句话介绍你自己';
  const codexBinary = resolveCodexBinary();
  console.log(`[demo] 使用 codex 二进制: ${codexBinary}`);
  console.log(`[demo] prompt: ${prompt}\n`);

  let turnDone = false;

  const client = new AppServerClient(codexBinary, {
    onNotification(method, params) {
      switch (method) {
        case 'item/agentMessage/delta':
          // 真实字段名来自 AgentMessageDeltaNotification schema: delta/itemId/threadId/turnId
          process.stdout.write(params.delta);
          break;
        case 'turn/completed':
          turnDone = true;
          console.log('\n\n[demo] 本轮对话结束 (turn/completed)');
          break;
        case 'item/completed':
          // item 可能是 command_execution / file_change / agent_message 等，demo 只打印类型
          console.log(`\n[demo] item 完成: ${params.item?.type ?? '(未知类型)'}`);
          break;
        default:
          // 其他通知（reasoning、mcp 工具调用进度等）demo 里不展开处理
          break;
      }
    },
  });

  try {
    // 1) initialize 握手 —— 字段来自 v1/InitializeParams.json: 必须有 clientInfo.name/version
    await client.request('initialize', {
      clientInfo: { name: 'cloudcli-ui-demo', version: '0.0.1' },
    });

    // 2) 开一个会话线程 —— ThreadStartParams 所有字段可选，这里用默认值
    // 响应结构是 { thread: Thread }，线程 id 在 thread.id 下（ThreadStartResponse schema 确认）
    const { thread } = await client.request('thread/start', {});
    const threadId = thread.id;
    console.log(`[demo] threadId = ${threadId}`);

    // 3) 发一轮对话 —— TurnStartParams 必填 threadId + input（UserInput[]）
    // 响应结构是 { turn: Turn }，turn id 在 turn.id 下（TurnStartResponse schema 确认）
    const { turn } = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
    });
    console.log(`[demo] turnId = ${turn.id}\n[demo] --- 流式输出开始 ---\n`);

    // 等待 turn/completed 通知（没有现成的 await，demo 用简单轮询）
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (turnDone) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error('[demo] 失败:', err);
  process.exitCode = 1;
});
