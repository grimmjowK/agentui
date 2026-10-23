import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import { WebSocket, type RawData } from 'ws';

import {
  buildCodexChildEnv,
  CodexAppServer,
  codexTerminalFailure,
  codexOwnership,
  prepareCodexTerminalThread,
} from '@/modules/codex-runtime/index.js';
import { getCodexRuntimeInfo, resolveCodexExecutablePath } from '@/shared/codex-cli-path.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

type ShellIncomingMessage = {
  type?: string;
  data?: string;
  cols?: number;
  rows?: number;
  projectPath?: string;
  sessionId?: string;
  hasSession?: boolean;
  provider?: string;
  initialCommand?: string;
  isPlainShell?: boolean;
};

type PtySessionEntry = {
  pty: IPty;
  ws: WebSocket | null;
  buffer: string[];
  timeoutId: NodeJS.Timeout | null;
  projectPath: string;
  sessionId: string | null;
  /**
   * 聊天页在本 pty 启动之后又往同一份 transcript 追加过内容，说明这个 CLI
   * 进程内存里的历史已经落后。见 `markShellSessionStale`。
   */
  stale: boolean;
  released?: Promise<void>;
};

const ptySessionsMap = new Map<string, PtySessionEntry>();
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;

const WARN_COLOR = '\x1b[33m';
const COLOR_RESET = '\x1b[0m';

/**
 * 同一个 sessionId 可以同时被两个 writer 打开：终端页 `claude --resume` 起的
 * 真实 CLI 进程，和聊天页走 SDK 的另一个进程。两者各自持有一份内存历史、
 * 各自往同一个 transcript jsonl 追加，谁都不会感知对方的写入 —— 结果就是
 * 终端页停留在启动那一刻的历史，而且 transcript 会分叉。
 *
 * 这里不做拦截（在终端里查看历史会话是正常用法），只让两边互相知情。
 */
function sendShellWarning(ws: WebSocket | null, text: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify({ type: 'output', data: `\r\n${WARN_COLOR}${text}${COLOR_RESET}\r\n` }));
}

/**
 * 返回该 sessionId 是否有存活的终端 pty。聊天页在发起请求前调用，用于提示
 * 用户"终端页还开着同一个会话，那边的内容会过期"。
 */
export function hasLiveShellSession(sessionId: string): boolean {
  if (!sessionId) {
    return false;
  }
  for (const entry of ptySessionsMap.values()) {
    if (entry.sessionId === sessionId) {
      return true;
    }
  }
  return false;
}

/**
 * 聊天页向某个 sessionId 写入后调用：把对应的终端 pty 标记为陈旧，并立刻
 * 往终端里打一行警告（终端已断开时留到下次重连再提示）。
 */
export function markShellSessionStale(sessionId: string): void {
  if (!sessionId) {
    return;
  }
  for (const entry of ptySessionsMap.values()) {
    if (entry.sessionId !== sessionId || entry.stale) {
      continue;
    }
    entry.stale = true;
    sendShellWarning(
      entry.ws,
      `[警告] 聊天页正在向同一个会话 ${sessionId} 写入。该 CLI 进程的历史停留在启动时刻，不会自动同步；继续在此输入会导致会话记录分叉。断开并重连终端可重新加载最新历史。`,
    );
  }
}

/**
 * 终止指定 sessionId 的所有存活终端 PTY 进程并等待其完全退出（用于 Codex 聊天与终端无缝切换）。
 */
export async function terminateShellSessionsBySessionId(sessionId: string): Promise<boolean> {
  if (!sessionId) {
    return false;
  }
  const matchingEntries: PtySessionEntry[] = [];
  for (const entry of ptySessionsMap.values()) {
    if (entry.sessionId === sessionId) {
      matchingEntries.push(entry);
    }
  }
  if (matchingEntries.length === 0) {
    return false;
  }
  await Promise.all(
    matchingEntries.map(async (session) => {
      if (session.timeoutId) {
        clearTimeout(session.timeoutId);
      }
      try {
        session.pty.kill();
      } catch { /* already exited */ }
      const forceKillTimer = setTimeout(() => {
        try {
          session.pty.kill('SIGTERM');
        } catch { /* already exited */ }
      }, 200);
      const sigkillTimer = setTimeout(() => {
        try {
          session.pty.kill('SIGKILL');
        } catch { /* already exited */ }
      }, 1000);
      try {
        await session.released;
      } finally {
        clearTimeout(forceKillTimer);
        clearTimeout(sigkillTimer);
      }
    }),
  );
  return true;
}

type ShellCommandResult = {
  command: string;
  mode: 'plain' | 'new' | 'resume';
  executable?: string;
  args?: string[];
};

type ShellWebSocketDependencies = {
  getSessionById: (sessionId: string) => { cliSessionId?: string } | null | undefined;
  stripAnsiSequences: (content: string) => string;
  normalizeDetectedUrl: (url: string) => string | null;
  extractUrlsFromText: (content: string) => string[];
  shouldAutoOpenUrlFromOutput: (content: string) => boolean;
  /** 该 sessionId 当前是否有聊天页的 SDK 会话在跑。 */
  isChatSessionActive: (sessionId: string, provider: string) => boolean;
  /** 停止该 sessionId 正在运行的聊天会话并等待释放锁。 */
  stopChatSession?: (sessionId: string, provider: string, userId?: string | number | null) => Promise<boolean>;
};

/**
 * Reads a string field from untyped payloads and falls back when absent.
 */
function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Reads a boolean field from untyped payloads and falls back when absent.
 */
function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Reads a finite number field from untyped payloads and falls back when absent.
 */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Parses incoming websocket shell messages and keeps processing safe when
 * malformed payloads are received.
 */
function parseShellMessage(rawMessage: RawData): ShellIncomingMessage | null {
  const payload = parseIncomingJsonObject(rawMessage);
  if (!payload) {
    return null;
  }

  return payload as ShellIncomingMessage;
}

/**
 * Resolves provider command line for plain shell and agent-backed shell modes.
 */
function buildShellCommand(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies
): ShellCommandResult {
  const hasSession = readBoolean(message.hasSession);
  const sessionId = readString(message.sessionId);
  const initialCommand = readString(message.initialCommand);
  const provider = readString(message.provider, 'claude');
  const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
  const isPlainShell =
    readBoolean(message.isPlainShell) ||
    (!!initialCommand && !hasSession) ||
    provider === 'plain-shell';

  if (isPlainShell) {
    return { command: initialCommand, mode: 'plain' };
  }

  if (provider === 'cursor') {
    if (hasSession && sessionId) {
      return { command: `cursor-agent --resume="${sessionId}"`, mode: 'resume' };
    }
    return { command: 'cursor-agent', mode: 'new' };
  }

  if (provider === 'codex') {
    const executable = resolveCodexExecutablePath();
    const args = ['-c', 'check_for_update_on_startup=false'];
    if (hasSession && sessionId) args.push('resume', sessionId);
    return { command: executable, executable, args, mode: hasSession && sessionId ? 'resume' : 'new' };
  }

  if (provider === 'gemini') {
    const command = initialCommand || 'gemini';
    let resumeId = '';
    if (hasSession && sessionId) {
      try {
        const existingSession = dependencies.getSessionById(sessionId);
        if (existingSession && existingSession.cliSessionId) {
          resumeId = existingSession.cliSessionId;
          if (!safeSessionIdPattern.test(resumeId)) {
            resumeId = '';
          }
        }
      } catch (error) {
        console.error('Failed to get Gemini CLI session ID:', error);
      }
    }

    if (hasSession && resumeId) {
      return { command: `${command} --resume "${resumeId}"`, mode: 'resume' };
    }
    return { command, mode: 'new' };
  }

  const command = initialCommand || 'claude';
  if (hasSession && sessionId) {
    if (os.platform() === 'win32') {
      return {
        command: `claude --resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { claude }`,
        mode: 'resume',
      };
    }
    return { command: `claude --resume "${sessionId}" || claude`, mode: 'resume' };
  }
  return { command, mode: 'new' };
}

/**
 * Handles websocket connections used by the standalone shell terminal UI.
 */
export function handleShellConnection(
  ws: WebSocket,
  dependencies: ShellWebSocketDependencies,
  userId: string | number | null = null
): void {
  console.log('[INFO] Shell websocket connected');

  let shellProcess: IPty | null = null;
  let ptySessionKey: string | null = null;
  let urlDetectionBuffer = '';
  const announcedAuthUrls = new Set<string>();
  let initializing = false;

  ws.on('message', async (rawMessage) => {
    try {
      const data = parseShellMessage(rawMessage);
      if (!data?.type) {
        throw new Error('Invalid websocket payload');
      }

      if (data.type === 'init') {
        if (initializing || shellProcess) return;
        initializing = true;
        try {
        const projectPath = readString(data.projectPath, process.cwd());
        let sessionId = readString(data.sessionId) || null;
        const hasSession = readBoolean(data.hasSession);
        const provider = readString(data.provider, 'claude');
        const initialCommand = readString(data.initialCommand);
        const isPlainShell =
          readBoolean(data.isPlainShell) ||
          (!!initialCommand && !hasSession) ||
          provider === 'plain-shell';

        urlDetectionBuffer = '';
        announcedAuthUrls.clear();

        const isLoginCommand =
          !!initialCommand &&
          (initialCommand.includes('setup-token') ||
            initialCommand.includes('cursor-agent login') ||
            initialCommand.includes('auth login'));

        const commandSuffix =
          isPlainShell && initialCommand
            ? `_cmd_${Buffer.from(initialCommand).toString('base64').slice(0, 16)}`
            : '';
        const runtime = provider === 'codex' && !isPlainShell ? getCodexRuntimeInfo() : null;
        ptySessionKey = JSON.stringify([userId, provider, path.resolve(projectPath), sessionId, runtime, commandSuffix]);

        if (isLoginCommand) {
          const oldSession = ptySessionsMap.get(ptySessionKey);
          if (oldSession) {
            if (oldSession.timeoutId) {
              clearTimeout(oldSession.timeoutId);
            }
            oldSession.pty.kill();
            ptySessionsMap.delete(ptySessionKey);
          }
        }

        const existingSession = isLoginCommand ? null : ptySessionsMap.get(ptySessionKey);
        if (existingSession) {
          if (existingSession.ws && existingSession.ws !== ws && existingSession.ws.readyState === WebSocket.OPEN) {
            throw new Error('This terminal is connected in another tab. Disconnect that tab first.');
          }
          shellProcess = existingSession.pty;
          if (existingSession.timeoutId) {
            clearTimeout(existingSession.timeoutId);
          }

          ws.send(
            JSON.stringify({
              type: 'output',
              data: '\x1b[36m[Reconnected to existing session]\x1b[0m\r\n',
            })
          );

          if (existingSession.buffer.length > 0) {
            ws.send(
              JSON.stringify({
                type: 'output',
                data: existingSession.buffer.join(''),
              })
            );
          }

          existingSession.ws = ws;
          // 复用的是同一个 CLI 进程，不会重新读 transcript。断线期间聊天页写过
          // 东西的话，这里回放的缓冲区就是过期内容，必须说清楚。
          if (existingSession.stale) {
            sendShellWarning(
              ws,
              `[警告] 期间聊天页向会话 ${sessionId} 写入过内容。这里复用的是原有 CLI 进程，历史未刷新；需要最新记录请点"断开"后重新连接。`,
            );
          }
          return;
        }

        const resolvedProjectPath = path.resolve(projectPath);
        try {
          const stats = fs.statSync(resolvedProjectPath);
          if (!stats.isDirectory()) {
            throw new Error('Not a directory');
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid project path' }));
          return;
        }

        const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
        if (sessionId && !safeSessionIdPattern.test(sessionId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID' }));
          return;
        }

        let lease: ReturnType<typeof codexOwnership.acquire> | undefined;
        if (runtime) {
          if (sessionId) {
            if (dependencies.isChatSessionActive(sessionId, 'codex') && dependencies.stopChatSession) {
              await dependencies.stopChatSession(sessionId, 'codex', userId);
            }
            if (hasLiveShellSession(sessionId)) {
              await terminateShellSessionsBySessionId(sessionId);
            }
          }
          lease = codexOwnership.acquire({ configRoot: runtime.configRoot, threadId: sessionId,
            projectPath: resolvedProjectPath, userId, owner: 'terminal' });
          const probe = new CodexAppServer(runtime.executablePath, resolvedProjectPath, runtime.configRoot);
          try {
            codexOwnership.attach(lease, probe.child.pid);
            await probe.initialize();
            sessionId = await prepareCodexTerminalThread(probe, sessionId, resolvedProjectPath);
            codexOwnership.bind(lease, sessionId!);
            data.sessionId = sessionId!;
            data.hasSession = true;
          } catch (error) {
            await probe.close();
            codexOwnership.release(lease);
            throw error;
          }
          await probe.close();
          if (ws.readyState !== WebSocket.OPEN) {
            codexOwnership.release(lease);
            return;
          }
          ws.send(JSON.stringify({ type: 'runtime', ...runtime, sessionId }));
        }
        const shellCommandResult = buildShellCommand(data, dependencies);
        const shellCommand = shellCommandResult.command;
        const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
        const shellArgs =
          os.platform() === 'win32' ? ['-Command', shellCommand] : ['-c', shellCommand];
        const termCols = readNumber(data.cols, 80);
        const termRows = readNumber(data.rows, 24);

        try {
        shellProcess = pty.spawn(shellCommandResult.executable ?? shell, shellCommandResult.args ?? shellArgs, {
          name: 'xterm-256color',
          cols: termCols,
          rows: termRows,
          cwd: resolvedProjectPath,
          env: {
            ...(runtime ? buildCodexChildEnv(runtime.configRoot) : process.env),
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            FORCE_COLOR: '3',
          },
        });

        } catch (error) {
          if (lease) codexOwnership.release(lease);
          throw error;
        }
        if (lease) codexOwnership.attach(lease, shellProcess.pid);
        const ownedKey = ptySessionKey;
        let releaseProcess!: () => void;
        const released = new Promise<void>((resolve) => { releaseProcess = resolve; });
        ptySessionsMap.set(ownedKey, {
          pty: shellProcess,
          ws,
          buffer: [],
          timeoutId: null,
          projectPath,
          sessionId,
          stale: false,
          released,
        });

        let terminalDiagnostic = '';
        shellProcess.onData((chunk) => {
          if (runtime) terminalDiagnostic = (terminalDiagnostic + dependencies.stripAnsiSequences(chunk)).slice(-16384);
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ownedKey);
          if (!session) {
            return;
          }

          if (session.buffer.length < 5000) {
            session.buffer.push(chunk);
          } else {
            session.buffer.shift();
            session.buffer.push(chunk);
          }

          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            let outputData = chunk;
            const cleanChunk = dependencies.stripAnsiSequences(chunk);
            urlDetectionBuffer = `${urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);

            outputData = outputData.replace(
              /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
              '[INFO] Opening in browser: $1'
            );

            const emitAuthUrl = (detectedUrl: string, autoOpen = false) => {
              const normalizedUrl = dependencies.normalizeDetectedUrl(detectedUrl);
              if (!normalizedUrl) {
                return;
              }

              const isNewUrl = !announcedAuthUrls.has(normalizedUrl);
              if (isNewUrl) {
                announcedAuthUrls.add(normalizedUrl);
                session.ws?.send(
                  JSON.stringify({
                    type: 'auth_url',
                    url: normalizedUrl,
                    autoOpen,
                  })
                );
              }
            };

            const normalizedDetectedUrls = dependencies.extractUrlsFromText(urlDetectionBuffer)
              .map((url) => dependencies.normalizeDetectedUrl(url))
              .filter((url): url is string => Boolean(url));

            const dedupedDetectedUrls = Array.from(new Set(normalizedDetectedUrls)).filter(
              (url, _, urls) =>
                !urls.some((otherUrl) => otherUrl !== url && otherUrl.startsWith(url))
            );

            dedupedDetectedUrls.forEach((url) => emitAuthUrl(url, false));

            if (
              dependencies.shouldAutoOpenUrlFromOutput(cleanChunk) &&
              dedupedDetectedUrls.length > 0
            ) {
              const bestUrl = dedupedDetectedUrls.reduce((longest, current) =>
                current.length > longest.length ? current : longest
              );
              emitAuthUrl(bestUrl, true);
            }

            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: outputData,
              })
            );
          }
        });

        shellProcess.onExit((exitCode) => {
          if (lease) codexOwnership.release(lease);
          releaseProcess();
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ownedKey);
          if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${
                  exitCode.signal != null ? ` (${exitCode.signal})` : ''
                }\x1b[0m\r\n`,
              })
            );
          }

          if (session?.timeoutId) {
            clearTimeout(session.timeoutId);
          }

          ptySessionsMap.delete(ownedKey);
          const failure = runtime ? codexTerminalFailure(terminalDiagnostic) : null;
          if (failure && session?.ws?.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify({ type: 'error', message: failure, startupFailed: true }));
          }
          if (session?.ws?.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify({ type: 'session_released', provider, sessionId, exitCode: exitCode.exitCode }));
          shellProcess = null;
        });

        let welcomeMsg = `\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`;
        if (!isPlainShell) {
          const providerName =
            provider === 'cursor'
              ? 'Cursor'
              : provider === 'codex'
                ? 'Codex'
                : provider === 'gemini'
                  ? 'Gemini'
                  : 'Claude';
          welcomeMsg = shellCommandResult.mode === 'resume'
            ? `\x1b[36mResuming ${providerName} session ${sessionId} in: ${projectPath}\x1b[0m\r\n`
            : `\x1b[36mStarting new ${providerName} session in: ${projectPath}\x1b[0m\r\n`;
        }

        ws.send(
          JSON.stringify({
            type: 'output',
            data: welcomeMsg,
          })
        );

        // 反向检测：聊天页此刻正在跑同一个会话，两个进程会各自往同一份
        // transcript 追加，历史会分叉。
        if (sessionId && !isPlainShell && dependencies.isChatSessionActive(sessionId, provider)) {
          sendShellWarning(
            ws,
            `[警告] 聊天页当前正在运行同一个会话 ${sessionId}。两边是各自独立的进程，会往同一份记录里写入并造成分叉；建议先在聊天页结束该会话再在此继续。`,
          );
        }
        return;
        } finally { initializing = false; }
      }

      if (data.type === 'input') {
        if (shellProcess && ptySessionKey && ptySessionsMap.get(ptySessionKey)?.ws === ws) {
          shellProcess.write(readString(data.data));
        }
        return;
      }

      if (data.type === 'resize') {
        if (shellProcess) {
          shellProcess.resize(readNumber(data.cols, 80), readNumber(data.rows, 24));
        }
        return;
      }

      if (data.type === 'terminate') {
        if (ptySessionKey) {
          const session = ptySessionsMap.get(ptySessionKey);
          if (session?.ws === ws) {
            session.pty.kill();
            const forceKillTimer = setTimeout(() => {
              try {
                session.pty.kill('SIGTERM');
              } catch { /* already exited */ }
            }, 300);
            const sigkillTimer = setTimeout(() => {
              try {
                session.pty.kill('SIGKILL');
              } catch { /* already exited */ }
            }, 1500);
            try {
              await session.released;
            } finally {
              clearTimeout(forceKillTimer);
              clearTimeout(sigkillTimer);
            }
          } else if (!session) {
            ws.send(JSON.stringify({ type: 'session_released', provider: data.provider }));
          }
        }
        shellProcess = null;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Shell WebSocket error:', message);
      if (ws.readyState === WebSocket.OPEN && !shellProcess) {
        ws.send(JSON.stringify({ type: 'error', message, startupFailed: true }));
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'output',
            data: `\r\n\x1b[31mError: ${message}\x1b[0m\r\n`,
          })
        );
      }
    }
  });

  ws.on('close', () => {
    if (!ptySessionKey) {
      return;
    }

    const session = ptySessionsMap.get(ptySessionKey);
    if (!session || session.ws !== ws) {
      return;
    }

    session.ws = null;
    let isCodexSession = false;
    try {
      const parsedKey = JSON.parse(ptySessionKey);
      isCodexSession = Array.isArray(parsedKey) && parsedKey[1] === 'codex';
    } catch { /* ignore */ }

    if (isCodexSession) {
      if (session.timeoutId) {
        clearTimeout(session.timeoutId);
      }
      try {
        session.pty.kill();
      } catch { /* already exited */ }
      setTimeout(() => {
        try {
          session.pty.kill('SIGTERM');
        } catch { /* already exited */ }
      }, 200);
      return;
    }

    session.timeoutId = setTimeout(() => {
      session.pty.kill();
      // onExit confirms release and removes the entry.
    }, PTY_SESSION_TIMEOUT);
  });

  ws.on('error', (error) => {
    console.error('[ERROR] Shell WebSocket error:', error);
  });
}

export async function shutdownShellSessions(): Promise<void> {
  await Promise.all([...ptySessionsMap.values()].map(async (session) => {
    if (session.timeoutId) clearTimeout(session.timeoutId);
    session.pty.kill();
    await session.released;
  }));
}
