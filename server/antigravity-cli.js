import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { createNormalizedMessage, extractTitleFromModelReply, generateMessageId } from './shared/utils.js';
import { resolveAntigravityExecutablePath } from './shared/antigravity-cli-path.js';
import { ensureAntigravitySessionInCliStore } from './shared/antigravity-session-store.js';
import { cleanupTempFiles, handleImages } from './shared/image-temp-files.js';
import { agyTextId, mapAgyStepUpdate, notifySessionsChanged, providerRegistry } from './modules/providers/index.js';
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

export function createReconnectableWriter(writer) {
  return {
    isWebSocketWriter: true,
    userId: writer?.userId,
    send(message) {
      writer?.send(message);
    },
    setSessionId(sessionId) { writer?.setSessionId?.(sessionId); },
    reconnect(nextWriter) {
      if (this.userId !== nextWriter?.userId || !nextWriter?.ws) return false;
      if (typeof writer?.updateWebSocket === 'function') writer.updateWebSocket(nextWriter.ws);
      else writer = nextWriter;
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
    this.errorEmitted = false;
    this.aborted = false;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.hasStreamed = false;
    // 目前串流段落：每個 agent_response 步驟各自一段，遇到換步驟、工具或結束就收尾
    this.streamStep = null;
    this.segmentText = '';
    this.lastAssistantText = '';
    this.hasStreamedAny = false;
    this.lastStepCompletedAgentResponse = false;
    this.ignoredResultError = null;
    this.sessionCreatedEmitted = false;
  }

  clearTransientError() {
    this.error = null;
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

  /**
   * @param {string} text
   * @param {number|null} [stepIndex]
   */
  appendStream(text, stepIndex = null) {
    if (this.hasStreamed && stepIndex !== this.streamStep) this.endStream();
    this.hasStreamed = true;
    this.streamStep = stepIndex;
    this.segmentText += text;
    send(this.writer, { sessionId: this.sessionId, kind: 'stream_delta', content: text });
  }

  recordAssistantText(text) {
    if (typeof text !== 'string' || !text.trim()) return;
    this.lastAssistantText = text;
  }

  /**
   * 收尾目前段落：stream_end 帶上與歷史相同的 id（transcript 的 step_index），再送完整文字。
   * 前端把串流氣泡改成這個 id，隨後的 text 以同 id 覆蓋；歷史拉取時也能按 id 去重。
   */
  endStream() {
    if (!this.hasStreamed) return;
    const messageId = this.streamStep !== null && this.sessionId
      ? agyTextId(this.sessionId, this.streamStep)
      : generateMessageId('agy_msg');
    send(this.writer, { sessionId: this.sessionId, kind: 'stream_end', messageId });
    send(this.writer, { sessionId: this.sessionId, id: messageId, kind: 'text', role: 'assistant', content: this.segmentText });
    this.recordAssistantText(this.segmentText);
    this.hasStreamedAny = true;
    this.hasStreamed = false;
    this.streamStep = null;
    this.segmentText = '';
  }

  handleLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      if (/^API error \(attempt \d+\):/i.test(line)) {
        if (!this.aborted) {
          this.error = line;
          this.lastStepCompletedAgentResponse = false;
        }
        return;
      }
      // Plain text streaming fallback
      this.clearTransientError();
      this.appendStream(line + '\n');
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
      this.ignoredResultError = null;
      const step = event.step_update;
      this.adoptSessionId(step.conversation_id);

      const stepIndex = typeof step.step_index === 'number' ? step.step_index : null;
      // 換到別的步驟（含 system_message 這類不帶文字也不是工具的步驟）就收尾上一段，
      // 否則上一段會停在串流佔位裡，期間拉到的歷史無法按 id 認領它
      if (this.hasStreamed && stepIndex !== this.streamStep) this.endStream();

      // Text delta
      if (typeof step.text_delta === 'string' && step.text_delta) {
        this.clearTransientError();
        this.appendStream(step.text_delta, stepIndex);
      }
      if (step.step_type === 'agent_response') {
        const isDone = step.state === 'DONE';
        if (isDone) this.endStream();
        this.lastStepCompletedAgentResponse = isDone && this.hasStreamedAny;
        return;
      }

      this.lastStepCompletedAgentResponse = false;

      // Tool use / result：與歷史解析共用 antigravity-tool-mapper
      const mapped = mapAgyStepUpdate(step);
      if (mapped) {
        this.clearTransientError();
        this.endStream();
        send(this.writer, { sessionId: this.sessionId, ...mapped });
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
        // agy --conversation 續接含有歷史錯誤步驟的會話時，printmode 在 stream-json 下因
        // initialStepIndex=0 與 streamJSONEmitter.HasResponse()=false 的競態，會把舊輪次的
        // 錯誤塞進本輪結尾的 result.error。若本輪最後一步已是正常 DONE 的 agent_response，忽略該陳舊錯誤。
        if (this.lastStepCompletedAgentResponse) {
          this.ignoredResultError = typeof res.error === 'string' ? res.error : null;
          this.clearTransientError();
          this.endStream();
          return;
        }
        this.error = res.error || 'Antigravity execution failed';
        this.errorEmitted = true;
        send(this.writer, {
          sessionId: this.sessionId,
          kind: 'error',
          content: this.error,
        });
        return;
      }

      this.clearTransientError();
      this.endStream();
      // response 是最後一段回覆，串流時已逐字送出過；只有完全沒有串流（result-only）才用它補上
      // ponytail: 假設最後一段回覆一定有 text_delta（agy 1.5.0 實測如此），否則該段會缺
      const responseText = res.response || '';
      if (responseText.trim()) {
        this.recordAssistantText(responseText);
        if (!this.hasStreamedAny) {
          send(this.writer, { sessionId: this.sessionId, kind: 'text', role: 'assistant', content: responseText });
        }
      }
      return;
    }

    // D. Generic/Mock event fallbacks for backward-compat and unit tests
    // 1. Text delta
    if (event.delta || event.type === 'delta') {
      const delta = typeof event.delta === 'string' ? event.delta : (event.text || '');
      if (delta) {
        this.clearTransientError();
        this.appendStream(delta);
      }
      return;
    }

    // 2. Tool use
    if (event.type === 'tool_use' || event.tool_use) {
      this.clearTransientError();
      this.endStream();
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
      this.clearTransientError();
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
        this.clearTransientError();
        if (this.hasStreamed) {
          // 完整訊息以它為準，取代串流累積的內容
          this.segmentText = content;
          this.endStream();
        } else {
          this.recordAssistantText(content);
          send(this.writer, { sessionId: this.sessionId, kind: 'text', role: 'assistant', content });
        }
      }
      return;
    }

    // 5. Error event (may be a transient mid-stream retry such as "API error (attempt 2): ...";
    // hold until flush/result unless unrecovered when the stream finishes)
    if (event.type === 'error' || event.error) {
      if (this.aborted) return;
      const errMsg = typeof event.error === 'string' ? event.error : (event.error?.message || event.message || 'Unknown error');
      this.error = errMsg;
      this.lastStepCompletedAgentResponse = false;
    }
  }

  flush() {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) {
      this.handleLine(this.buffer.trim());
      this.buffer = '';
    }

    this.endStream();

    if (this.error && !this.errorEmitted && !this.aborted) {
      this.errorEmitted = true;
      send(this.writer, {
        sessionId: this.sessionId,
        kind: 'error',
        content: this.error,
      });
    }
  }
}

/** 從 stderr 找出 headless 模式自動拒絕審批的說明（agy 1.5.0 實測文字）。 */
export function findPermissionDeniedNotice(stderr) {
  const line = String(stderr || '').split('\n').find((text) => /auto-denied|cannot prompt for/i.test(text));
  return line ? line.trim() : null;
}

const ANTIGRAVITY_TITLE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 },
  },
  required: ['title'],
  additionalProperties: false,
});

/** 新會話首輪只要有文字或圖片，就值得在完成後生成標題。 */
export function shouldGenerateAntigravityTitle(options = {}, message) {
  if (options.sessionId) return false;
  if (typeof message === 'string' && message.trim()) return true;
  return Array.isArray(options.images) && options.images.length > 0;
}

/**
 * 新會話第一輪結束後在背景另起一個 agy 短暫執行緒生成標題。
 * 使用獨立的臨時 ANTIGRAVITY_HOME 避免污染使用者的會話記錄。
 * 只寫入 DB（auto 名稱，不覆蓋使用者自定義命名），失敗靜默放棄。
 */
export async function generateAntigravityTitle(job) {
  let tempHome;
  try {
    tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agy-title-'));
    const executablePath = resolveAntigravityExecutablePath();
    const instruction = [
      'Write a short title (at most 8 words) for the conversation below.',
      'Use the same language as the user\'s message. Do not use any tools.',
      'The response must satisfy the provided JSON schema and contain only the title value.',
      '',
      '<user>',
      (job.prompt || '').slice(0, 2000),
      '</user>',
      '<assistant>',
      (job.reply || '').slice(0, 1000),
      '</assistant>',
    ].join('\n');

    const args = [
      '-p', instruction,
      '--output-format', 'text',
      '--json-schema', ANTIGRAVITY_TITLE_SCHEMA,
      '--disable-slash-commands',
      '--sandbox',
    ];
    if (job.model) {
      args.push('--model', job.model);
    }

    const output = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch {}
        reject(new Error('Antigravity title generation timed out'));
      }, 60000);

      const proc = spawnFunction(executablePath, args, {
        cwd: job.cwd || process.cwd(),
        env: {
          ...process.env,
          ANTIGRAVITY_HOME: tempHome,
          PAGER: 'cat',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || `Exited with code ${code}`));
      });
    });

    const title = extractTitleFromModelReply(output);
    if (!title) return;
    sessionsDb.updateSessionCustomName(job.sessionId, title, false);
    notifySessionsChanged('antigravity', job.sessionId);
  } catch (error) {
    console.warn('Antigravity title generation failed:', error.message);
  } finally {
    if (tempHome) {
      await fs.promises.rm(tempHome, { recursive: true, force: true }).catch(() => {});
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

  const { modifiedCommand, tempImagePaths, tempDir } = await handleImages(message, options.images, cwd);

  // Construct CLI arguments array
  const args = [];

  // Prompt / Non-interactive argument
  args.push('--prompt', modifiedCommand);

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
      void cleanupTempFiles(tempImagePaths, tempDir);
      send(liveWriter, { sessionId, kind: 'error', content: err.message });
      return reject(err);
    }

    activeAntigravityProcesses.set(sessionId, childProcess);
    // 推送通知按 userId 查订阅，缺了它 notifyUserIfEnabled 会直接跳过
    childProcess.notifyContext = { userId: ws?.userId || null, provider: 'antigravity', sessionName: options.sessionSummary };
    const handler = new AntigravityResponseHandler(options.sessionId || null, liveWriter, (nativeId) => {
      activeAntigravityProcesses.delete(sessionId);
      sessionId = nativeId;
      activeAntigravityProcesses.set(sessionId, childProcess);
      // Index before session_created triggers navigation/history loading. The
      // transcript can arrive later; preserve the request's actual workspace.
      const existing = sessionsDb.getSessionById(nativeId);
      sessionsDb.createSession(nativeId, 'antigravity', cwd,
        existing?.custom_name || options.sessionSummary || String(message || '').slice(0, 50),
        existing?.created_at, undefined, existing?.jsonl_path);
    });

    childProcess.responseHandler = handler;

    childProcess.stdout.on('data', (chunk) => {
      try {
        handler.handleChunk(chunk);
      } catch (error) {
        handler.error = error.message;
        handler.errorEmitted = true;
        send(liveWriter, { sessionId: handler.sessionId, kind: 'error', content: error.message });
        childProcess.kill('SIGTERM');
      }
    });

    let stderrOutput = '';
    childProcess.stderr.on('data', (chunk) => {
      stderrOutput += chunk.toString();
    });

    let spawnFailed = false;
    let titleJob;
    childProcess.on('close', async (code) => {
      await cleanupTempFiles(tempImagePaths, tempDir);
      if (spawnFailed) return;
      try {
        handler.flush();
      } catch (error) {
        handler.error = error.message;
        handler.errorEmitted = true;
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
      } else if (!handler.error && (code === 0 || (
        code === 1 && handler.lastStepCompletedAgentResponse && handler.ignoredResultError
        // CLI 的同一個歷史 result.error 也可能寫入 stderr 並導致 exit 1。
        // 只消除已辨識的同一個錯誤；其他退出碼、signal 或不同 stderr 仍視為失敗。
        && (!stderrOutput.trim() || stderrOutput.trim() === handler.ignoredResultError.trim())
      ))) {
        // headless 模式無法詢問審批，CLI 會自動拒絕需要權限的工具，結果仍是 SUCCESS、
        // 說明只寫在 stderr。轉成警告讓頁面看得到，否則使用者只會看到空回覆。
        const deniedNotice = findPermissionDeniedNotice(stderrOutput);
        if (deniedNotice) {
          send(liveWriter, {
            sessionId: handler.sessionId,
            kind: 'task_notification',
            status: 'warning',
            summary: `Antigravity 目前以非互動模式執行，需要審批的工具已被自動拒絕。可在設定中切換為跳過權限（bypassPermissions），或在 settings.json 的 permissions.allow 加入允許規則。\n${deniedNotice}`,
          });
        }
        if (shouldGenerateAntigravityTitle(options, message)) {
          titleJob = {
            sessionId: handler.sessionId,
            cwd,
            model,
            prompt: typeof message === 'string' ? message : '',
            reply: handler.lastAssistantText || '',
          };
        }
        send(liveWriter, { sessionId: handler.sessionId, kind: 'complete', exitCode: 0, success: true });
        notifyRunStopped({ ...childProcess.notifyContext, sessionId: handler.sessionId, stopReason: 'completed' });
        resolve();
      } else {
        const errorContent = handler.error || stderrOutput.trim() || `Antigravity CLI exited with code ${code}`;
        if (!handler.errorEmitted) {
          handler.errorEmitted = true;
          send(liveWriter, { sessionId: handler.sessionId, kind: 'error', content: errorContent });
        }
        notifyRunFailed({ ...childProcess.notifyContext, sessionId: handler.sessionId, error: errorContent });
        reject(new Error(errorContent));
      }
      // 主流程（含事件通知、即時同步）完成後在背景生成標題，不拖慢這一輪
      if (titleJob) void generateAntigravityTitle(titleJob);
    });

    childProcess.on('error', async (err) => {
      spawnFailed = true;
      await cleanupTempFiles(tempImagePaths, tempDir);
      activeAntigravityProcesses.delete(sessionId);
      if (handler.sessionId && handler.sessionId !== sessionId) {
        activeAntigravityProcesses.delete(handler.sessionId);
      }
      const errorMsg = `Failed to start Antigravity process: ${err.message}`;
      send(liveWriter, { sessionId: handler.sessionId, kind: 'error', content: errorMsg });
      notifyRunFailed({ ...childProcess.notifyContext, sessionId: handler.sessionId, error: errorMsg });
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

    notifyRunStopped({ ...childProcess.notifyContext, sessionId, stopReason: 'aborted' });
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
