import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { createNormalizedMessage, generateMessageId } from './shared/utils.js';
import { resolveAntigravityExecutablePath } from './shared/antigravity-cli-path.js';
import { ensureAntigravitySessionInCliStore } from './shared/antigravity-session-store.js';
import { providerRegistry } from './modules/providers/provider.registry.js';
import { sessionsDb } from './modules/database/index.js';

const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

// Active processes mapped by session ID
const activeAntigravityProcesses = new Map();

function send(writer, message) {
  if (!writer) return;
  const normalized = createNormalizedMessage({ provider: 'antigravity', ...message });
  if (writer.isWebSocketWriter || writer.isSSEStreamWriter) {
    writer.send(normalized);
  } else if (typeof writer.send === 'function') {
    if (writer.readyState === undefined || writer.readyState === 1) {
      try {
        writer.send(normalized);
      } catch {
        writer.send(JSON.stringify(normalized));
      }
    }
  } else if (typeof writer.write === 'function') {
    writer.write(`data: ${JSON.stringify(normalized)}\n\n`);
  }
}

function createReconnectableWriter(writer) {
  const pending = [];
  return {
    isWebSocketWriter: true,
    userId: writer?.userId,
    send(message) {
      if (typeof writer?.ws?.readyState === 'number' && writer.ws.readyState !== 1) {
        pending.push(message);
        if (pending.length > 1000) pending.shift();
        return;
      }
      writer?.send(message);
    },
    setSessionId(sessionId) { writer?.setSessionId?.(sessionId); },
    reconnect(nextWriter) {
      if (this.userId !== nextWriter?.userId || !nextWriter?.ws) return false;
      if (typeof writer?.updateWebSocket === 'function') writer.updateWebSocket(nextWriter.ws);
      else writer = nextWriter;
      for (const message of pending.splice(0)) this.send(message);
      return true;
    },
  };
}

/**
 * Parses stdout lines from `agy` non-interactive execution.
 */
export class AntigravityResponseHandler {
  /** @param {(sessionId: string) => void} [onSessionId] */
  constructor(sessionId, writer, onSessionId = () => {}) {
    this.sessionId = sessionId;
    this.writer = writer;
    this.onSessionId = onSessionId;
    this.error = null;
    this.aborted = false;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.accumulatedText = '';
    this.hasStreamed = false;
    this.sessionCreatedEmitted = false;
  }

  adoptSessionId(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return;
    if (!this.sessionCreatedEmitted || this.sessionId !== sessionId) {
      this.onSessionId(sessionId);
      this.sessionId = sessionId;
      this.writer?.setSessionId?.(sessionId);
      this.sessionCreatedEmitted = true;
      send(this.writer, { kind: 'session_created', newSessionId: sessionId, sessionId });
    }
  }

  handleChunk(chunk) {
    this.buffer += this.decoder.write(chunk);
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handleLine(trimmed);
    }
  }

  handleLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // Plain text streaming fallback
      this.hasStreamed = true;
      this.accumulatedText += (this.accumulatedText ? '\n' : '') + line;
      send(this.writer, {
        sessionId: this.sessionId,
        kind: 'stream_delta',
        content: line + '\n',
      });
      return;
    }
    this.handleJsonEvent(event);
  }

  handleJsonEvent(event) {
    if (!event || typeof event !== 'object') return;

    // A. Native agy stream-json format: init event
    if (event.event === 'init') {
      this.adoptSessionId(event.conversation_id);
      return;
    }

    // B. Native agy stream-json format: step_update event
    if (event.event === 'step_update' && event.step_update) {
      const step = event.step_update;
      this.adoptSessionId(step.conversation_id);

      // Text delta
      if (typeof step.text_delta === 'string' && step.text_delta) {
        this.hasStreamed = true;
        this.accumulatedText += step.text_delta;
        send(this.writer, {
          sessionId: this.sessionId,
          kind: 'stream_delta',
          content: step.text_delta,
        });
        return;
      }

      // Tool use
      if (step.step_type === 'tool' && step.state === 'ACTIVE') {
        const toolInfo = step.tool_info || {};
        const toolName = step.tool_name || toolInfo.name || 'tool';
        const toolId = `agy_tool_${step.step_index}`;
        send(this.writer, {
          sessionId: this.sessionId,
          kind: 'tool_use',
          toolName,
          toolInput: toolInfo.parameters || {},
          toolId,
        });
        return;
      }

      // Tool result
      if (step.step_type === 'tool' && step.state === 'DONE') {
        const toolInfo = step.tool_info || {};
        const toolId = `agy_tool_${step.step_index}`;
        send(this.writer, {
          sessionId: this.sessionId,
          kind: 'tool_result',
          toolId,
          content: typeof toolInfo.output === 'string' ? toolInfo.output : JSON.stringify(toolInfo.output ?? ''),
          isError: false,
        });
        return;
      }

      return;
    }

    // C. Native agy stream-json format: result event
    if (event.event === 'result' && event.result) {
      const res = event.result;
      this.adoptSessionId(res.conversation_id);

      if (res.status === 'ERROR') {
        if (this.aborted) return;
        this.error = res.error || 'Antigravity execution failed';
        send(this.writer, {
          sessionId: this.sessionId,
          kind: 'error',
          content: res.error || 'Antigravity execution failed',
        });
        return;
      }

      const responseText = res.response || this.accumulatedText || '';
      if (this.hasStreamed) {
        send(this.writer, { sessionId: this.sessionId, kind: 'stream_end' });
      }
      send(this.writer, {
        sessionId: this.sessionId,
        kind: 'text',
        role: 'assistant',
        content: responseText,
      });
      this.accumulatedText = responseText;
      this.hasStreamed = false;
      return;
    }

    // D. Generic/Mock event fallbacks for backward-compat and unit tests
    // 1. Text delta
    if (event.delta || event.type === 'delta') {
      const delta = typeof event.delta === 'string' ? event.delta : (event.text || '');
      if (delta) {
        this.hasStreamed = true;
        this.accumulatedText += delta;
        send(this.writer, {
          sessionId: this.sessionId,
          kind: 'stream_delta',
          content: delta,
        });
      }
      return;
    }

    // 2. Tool use
    if (event.type === 'tool_use' || event.tool_use) {
      const tool = event.tool_use || event;
      const toolId = tool.id || generateMessageId('agy_tool');
      send(this.writer, {
        sessionId: this.sessionId,
        kind: 'tool_use',
        toolName: tool.name || tool.toolName || 'tool',
        toolInput: tool.input || tool.args || {},
        toolId,
      });
      return;
    }

    // 3. Tool result
    if (event.type === 'tool_result' || event.tool_result) {
      const result = event.tool_result || event;
      send(this.writer, {
        sessionId: this.sessionId,
        kind: 'tool_result',
        toolId: result.tool_use_id || result.toolId || '',
        content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? ''),
        isError: Boolean(result.is_error || result.isError),
      });
      return;
    }

    // 4. Completed message
    if (event.type === 'message' || event.type === 'text') {
      const content = event.content || event.text || '';
      if (content && typeof content === 'string') {
        if (this.hasStreamed) {
          send(this.writer, { sessionId: this.sessionId, kind: 'stream_end' });
        }
        send(this.writer, {
          sessionId: this.sessionId,
          kind: 'text',
          role: 'assistant',
          content,
        });
        this.accumulatedText = content;
        this.hasStreamed = false;
      }
      return;
    }

    // 5. Error event
    if (event.type === 'error' || event.error) {
      if (this.aborted) return;
      const errMsg = typeof event.error === 'string' ? event.error : (event.error?.message || event.message || 'Unknown error');
      this.error = errMsg;
      send(this.writer, {
        sessionId: this.sessionId,
        kind: 'error',
        content: errMsg,
      });
    }
  }

  flush() {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) {
      this.handleLine(this.buffer.trim());
      this.buffer = '';
    }

    if (this.hasStreamed) {
      send(this.writer, { sessionId: this.sessionId, kind: 'stream_end' });
      send(this.writer, {
        sessionId: this.sessionId,
        kind: 'text',
        role: 'assistant',
        content: this.accumulatedText,
      });
      this.hasStreamed = false;
    }
  }
}

/**
 * Launches an Antigravity CLI process and pipes events to the provided writer.
 */
export async function spawnAntigravity(message, options = {}, ws) {
  let sessionId = options.sessionId || crypto.randomUUID();
  const cwd = options.cwd || options.projectPath || process.cwd();
  const model = options.model;

  if (options.sessionId) {
    try {
      await ensureAntigravitySessionInCliStore(options.sessionId);
    } catch (error) {
      const errorMsg = `Failed to prepare Antigravity conversation ${options.sessionId}: ${error.message}`;
      send(ws, { sessionId, kind: 'error', content: errorMsg });
      throw new Error(errorMsg);
    }
  }

  let executablePath;
  try {
    executablePath = resolveAntigravityExecutablePath();
  } catch (err) {
    const errorMsg = 'Antigravity CLI (agy) is not installed or not found on PATH. '
      + 'Please install it first: https://www.antigravity.google/docs/cli/';
    send(ws, { sessionId, kind: 'error', content: errorMsg });
    throw new Error(errorMsg);
  }

  // Construct CLI arguments array
  const args = [];

  // Prompt / Non-interactive argument
  args.push('--prompt', message);

  // Model selection
  if (model) {
    args.push('--model', model);
  }

  // Multi-turn session resume: agy uses --conversation <id>
  if (options.sessionId) {
    args.push('--conversation', options.sessionId);
  }

  // Stream format
  args.push('--output-format', 'stream-json');

  // Permission mode: agy uses --dangerously-skip-permissions
  if (options.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  }

  const liveWriter = createReconnectableWriter(ws);

  return new Promise((resolve, reject) => {
    let childProcess;
    try {
      childProcess = spawnFunction(executablePath, args, {
        cwd,
        env: {
          ...process.env,
          PAGER: 'cat',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      send(liveWriter, { sessionId, kind: 'error', content: err.message });
      return reject(err);
    }

    activeAntigravityProcesses.set(sessionId, childProcess);
    const handler = new AntigravityResponseHandler(options.sessionId || null, liveWriter, (nativeId) => {
      activeAntigravityProcesses.delete(sessionId);
      sessionId = nativeId;
      activeAntigravityProcesses.set(sessionId, childProcess);
      // Index before session_created triggers navigation/history loading. The
      // transcript can arrive later; preserve the request's actual workspace.
      const existing = sessionsDb.getSessionById(nativeId);
      sessionsDb.createSession(nativeId, 'antigravity', cwd,
        existing?.custom_name || options.sessionSummary || message.slice(0, 50),
        existing?.created_at, undefined, existing?.jsonl_path);
    });

    childProcess.responseHandler = handler;

    childProcess.stdout.on('data', (chunk) => {
      try {
        handler.handleChunk(chunk);
      } catch (error) {
        handler.error = error.message;
        send(liveWriter, { sessionId: handler.sessionId, kind: 'error', content: error.message });
        childProcess.kill('SIGTERM');
      }
    });

    let stderrOutput = '';
    childProcess.stderr.on('data', (chunk) => {
      stderrOutput += chunk.toString();
    });

    let spawnFailed = false;
    childProcess.on('close', async (code) => {
      if (spawnFailed) return;
      try {
        handler.flush();
      } catch (error) {
        handler.error = error.message;
        send(liveWriter, { sessionId: handler.sessionId, kind: 'error', content: error.message });
      }
      activeAntigravityProcesses.delete(sessionId);
      if (handler.sessionId && handler.sessionId !== sessionId) {
        activeAntigravityProcesses.delete(handler.sessionId);
      }

      // Trigger immediate sync for this session into sessionsDb
      try {
        const candidateRoots = [
          path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
          path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
        ];
        if (process.env.ANTIGRAVITY_HOME) {
          candidateRoots.unshift(path.join(process.env.ANTIGRAVITY_HOME, 'brain'));
        }
        for (const root of handler.sessionId ? candidateRoots : []) {
          let transcriptPath = path.join(root, handler.sessionId, '.system_generated', 'logs', 'transcript.jsonl');
          if (!fs.existsSync(transcriptPath)) {
            transcriptPath = path.join(root, handler.sessionId, 'transcript.jsonl');
          }
          if (fs.existsSync(transcriptPath)) {
            const synchronizer = providerRegistry.resolveProvider('antigravity')?.sessionSynchronizer;
            if (synchronizer) {
              await synchronizer.synchronizeFile(transcriptPath);
            }
            break;
          }
        }
      } catch (err) {
        console.warn('Antigravity session post-run sync warning:', err);
      }

      if (childProcess.aborted) {
        send(liveWriter, { sessionId: handler.sessionId, kind: 'complete', aborted: true, success: true, exitCode: 0 });
        resolve();
      } else if (code === 0 && !handler.error) {
        send(liveWriter, { sessionId: handler.sessionId, kind: 'complete', exitCode: 0, success: true });
        resolve();
      } else {
        const errorContent = handler.error || stderrOutput.trim() || `Antigravity CLI exited with code ${code}`;
        if (!handler.error) send(liveWriter, { sessionId: handler.sessionId, kind: 'error', content: errorContent });
        notifyRunFailed({ sessionId: handler.sessionId, error: errorContent });
        reject(new Error(errorContent));
      }
    });

    childProcess.on('error', (err) => {
      spawnFailed = true;
      activeAntigravityProcesses.delete(sessionId);
      if (handler.sessionId && handler.sessionId !== sessionId) {
        activeAntigravityProcesses.delete(handler.sessionId);
      }
      const errorMsg = `Failed to start Antigravity process: ${err.message}`;
      send(liveWriter, { sessionId: handler.sessionId, kind: 'error', content: errorMsg });
      notifyRunFailed({ sessionId: handler.sessionId, error: errorMsg });
      reject(err);
    });
  });
}

/**
 * Aborts an active Antigravity session process.
 */
export function abortAntigravitySession(sessionId) {
  const childProcess = activeAntigravityProcesses.get(sessionId);
  if (!childProcess) {
    return false;
  }

  try {
    childProcess.aborted = true;
    childProcess.responseHandler.aborted = true;
    childProcess.kill('SIGTERM');
    setTimeout(() => {
      if (activeAntigravityProcesses.get(sessionId) === childProcess) {
        try {
          childProcess.kill('SIGKILL');
        } catch {
          // Process already ended
        }
        activeAntigravityProcesses.delete(sessionId);
      }
    }, 2000).unref();

    notifyRunStopped({ sessionId });
    return true;
  } catch (err) {
    console.error(`Failed to abort Antigravity session ${sessionId}:`, err);
    return false;
  }
}

export function isAntigravitySessionActive(sessionId) {
  return activeAntigravityProcesses.has(sessionId);
}

export function reconnectAntigravitySession(sessionId, writer) {
  const process = activeAntigravityProcesses.get(sessionId);
  if (!process?.responseHandler || !writer?.ws) return false;
  const currentWriter = process.responseHandler.writer;
  return currentWriter?.reconnect?.(writer) === true;
}

export function getActiveAntigravitySessions() {
  return Array.from(activeAntigravityProcesses.keys());
}
