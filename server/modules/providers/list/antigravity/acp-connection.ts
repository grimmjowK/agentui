/**
 * `agy acp` 的 JSON-RPC over stdio 連線（node-live-session-and-agy-acp design D7 / ACP D2）。
 *
 * - 一行一則 JSON；行可能被切成多段，以緩衝區組回。
 * - agent → client 的請求 id 可能是字串（agy 1.5.11 的 session/request_permission 用 "1"），不可假設數字。
 * - stderr 只當診斷；行程結束時未完成的請求一律 reject。
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

type JsonRpcId = string | number;
type JsonRpcMessage = {
  jsonrpc?: '2.0';
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class AcpRequestError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = 'AcpRequestError';
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  method: string;
};

export type AcpConnectionHandlers = {
  /** agent 發出的通知（session/update 等） */
  onNotification?: (method: string, params: unknown) => void;
  /** agent 發出的請求；回傳值作為 result，拋錯則回覆 JSON-RPC error */
  onRequest?: (method: string, params: unknown, id: JsonRpcId) => Promise<unknown> | unknown;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
};

export class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private stderrTail = '';
  private exited = false;
  exitCode: number | null = null;

  constructor(
    private readonly child: Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr' | 'on' | 'kill'>,
    private readonly handlers: AcpConnectionHandlers = {},
    private readonly requestTimeoutMs = 60_000,
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => this.onExit(code, signal));
    child.on('error', (error: Error) => this.failAll(error));
    // 對方關閉 stdin 後寫入會 EPIPE，視為行程結束處理即可
    child.stdin.on('error', () => {});
  }

  get stderr(): string {
    return this.stderrTail;
  }

  get isClosed(): boolean {
    return this.exited;
  }

  /** 送出請求。timeoutMs 為 0 表示不限時（session/prompt 由使用者中斷控制）。 */
  request<T = unknown>(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.exited) return Promise.reject(new Error(`ACP connection closed before ${method}`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP request ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs)
        : null;
      timer?.unref?.();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.exited) this.write({ jsonrpc: '2.0', method, params });
  }

  /** 關閉 stdin 讓 agent 自行結束；graceMs 後仍未結束就強制結束。 */
  close(graceMs = 2000): void {
    if (this.exited) return;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    const timer = setTimeout(() => {
      if (!this.exited) this.child.kill('SIGTERM');
    }, graceMs);
    timer.unref?.();
  }

  kill(): void {
    if (!this.exited) this.child.kill('SIGTERM');
  }

  private write(message: JsonRpcMessage): void {
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // 行程已關閉 stdin；exit 事件會處理未完成請求
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) this.onLine(trimmed);
    }
  }

  private onLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // 非協議輸出，忽略
    }
    if (message.method && message.id !== undefined) {
      void this.answer(message.id, message.method, message.params);
      return;
    }
    if (message.method) {
      this.handlers.onNotification?.(message.method, message.params);
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error) pending.reject(new AcpRequestError(message.error.code, message.error.message, message.error.data));
    else pending.resolve(message.result);
  }

  private async answer(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    if (!this.handlers.onRequest) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not supported: ${method}` } });
      return;
    }
    try {
      const result = await this.handlers.onRequest(method, params, id);
      this.write({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (error) {
      const err = error as { code?: number; message?: string };
      this.write({ jsonrpc: '2.0', id, error: { code: err.code ?? -32603, message: err.message ?? String(error) } });
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    const tail = this.buffer.trim();
    if (tail) this.onLine(tail);
    this.failAll(new Error(`agy acp exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})${this.stderrTail ? `: ${this.stderrTail.trim().slice(-500)}` : ''}`));
    this.handlers.onExit?.(code, signal);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}
