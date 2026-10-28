import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

import os from 'node:os';
import path from 'node:path';

import { buildCodexChildEnv } from './child-env.js';

export type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code?: number; message: string };
};

/** Owns a bidirectional app-server connection. Never treats stderr as protocol data. */
export class CodexAppServer extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private stopped = false;
  private pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private closing = false;
  private exited: Promise<void>;

  constructor(executable: string, cwd: string, configRoot?: string, profile?: string) {
    super();
    const args = ['app-server', '--listen', 'stdio://'];
    const childEnv = configRoot ? buildCodexChildEnv(configRoot) : { ...process.env };
    if (profile) {
      childEnv.CODEX_CONFIG_PROFILE = profile;
      if (profile.startsWith('deepseek')) {
        const modelSlug = profile === 'deepseek-flash' ? 'deepseek-flash' : 'deepseek-v4-pro';
        const modelsJson = path.join(configRoot || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models.json');
        args.push(
          '-c', 'model_provider=deepseek',
          '-c', `model=${modelSlug}`,
          '-c', `model_catalog_json=${modelsJson}`
        );
      }
    }
    this.child = spawn(executable, args, {
      cwd,
      env: childEnv,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    });
    this.exited = new Promise((resolve) => this.child.once('close', () => resolve()));
    this.child.once('error', (error) => this.fail(error));
    let stderrBuffer = '';
    this.child.stderr.on('data', (data) => {
      const text = String(data);
      stderrBuffer += text;
      if (stderrBuffer.length > 8192) {
        stderrBuffer = stderrBuffer.slice(-8192);
      }
      this.emit('diagnostic', text);
    });
    this.child.once('close', (code, signal) => {
      if (this.closing) {
        this.emit('closed');
        return;
      }
      const detail = stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : '';
      console.error(`[CodexAppServer] process closed (${signal || code})${detail}`);
      this.fail(new Error(`Codex app-server exited (${signal || code})${detail}`));
      this.emit('closed');
    });
    this.child.stdin.on('error', (error) => this.fail(error));
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      let message: RpcMessage;
      try { message = JSON.parse(line); }
      catch { this.fail(new Error('Invalid Codex app-server JSON')); void this.close(); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        this.fail(new Error('Invalid Codex app-server message')); void this.close(); return;
      }
      this.receive(message);
    });
    this.child.stderr.on('data', (data) => this.emit('diagnostic', String(data)));
  }

  private fail(error: Error) {
    if (this.stopped) return;
    this.stopped = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.emit('failure', error);
  }

  receive(message: RpcMessage) {
    if (message.method) {
      this.emit(message.id !== undefined ? 'request' : 'notification', message);
      return;
    }
    if (typeof message.id !== 'number') return;
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  }

  send(message: RpcMessage) {
    if (this.stopped || !this.child.stdin.writable) throw new Error('Codex connection is closed');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 45000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }

  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'agentui', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
    return result;
  }

  async close() {
    this.closing = true;
    this.stopped = true;
    this.child.stdin.end();
    const wait = (ms: number) => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void this.exited.then(() => { clearTimeout(timer); resolve(true); });
    });
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal);
        else this.child.kill(signal);
      } catch { /* The process already exited. */ }
    };
    if (await wait(50)) return;
    kill('SIGTERM');
    if (await wait(2000)) return;
    kill('SIGKILL');
    await this.exited;
  }
}
