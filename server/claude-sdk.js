/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { CLAUDE_MODELS } from '../shared/modelConstants.js';
import { resolveClaudeCodeExecutablePath } from './shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import { providerAuthService, sessionsService } from './modules/providers/index.js';
import { createNormalizedMessage } from './shared/utils.js';
import { cleanupTempFiles, handleImages } from './shared/image-temp-files.js';

const activeSessions = new Map();
// 被使用者中斷的 query：中斷的終止事件由 dispatcher 立即送出，這裡的 complete/error 必須略過，
// 否則一次中斷會出現兩個終止事件（晚到的那個還可能把同會話新開的一輪誤判為結束）
const abortedQueries = new WeakSet();
const pendingToolApprovals = new Map();

export function shouldSuppressClaudeWrappedError(assistantText, errorMessage) {
  const visible = typeof assistantText === 'string' ? assistantText.trim() : '';
  const error = typeof errorMessage === 'string' ? errorMessage.trim() : '';
  if (!visible || !error) return false;
  const assistantLooksLikeError = /^(?:API error|Error:|\[Request interrupted)/i.test(visible);
  if (!assistantLooksLikeError) return false;
  const probe = visible.slice(0, 160);
  return error.includes(probe) || visible.includes(error.slice(0, 160));
}

// 預設 10 分鐘，與 Codex 審批一致；0 以外的無效值回退預設
const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 600000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);
const CLAUDE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovals lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

/**
 * 只有發起這個 run 的使用者能審批（與 codexApprovals.decide 相同的嚴格比對）：
 * 呼叫者缺少 userId、或與請求記錄的 userId 不一致時拒絕。回傳是否已處理。
 */
function resolveToolApproval(requestId, userId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (!resolver || userId === null || userId === undefined
    || resolver._userId === null || resolver._userId === undefined
    || String(resolver._userId) !== String(userId)) {
    return false;
  }
  resolver(decision);
  return true;
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

/**
 * Maps CLI options to SDK-compatible options format
 * @param {Object} options - CLI options
 * @returns {Object} SDK-compatible options
 */
function mapCliOptionsToSDK(options = {}) {
  const { sessionId, cwd, toolsSettings, permissionMode } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env };

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);

  // Map working directory
  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  // Map permission mode
  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  // Map tool settings
  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  // Handle tool permissions
  if (settings.skipPermissions && permissionMode !== 'plan') {
    // When skipping permissions, use bypassPermissions mode
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  // Add plan mode default tools
  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  // Map model (default to sonnet)
  // Valid models: sonnet, opus, haiku, opusplan, sonnet[1m]
  sdkOptions.model = options.model || CLAUDE_MODELS.DEFAULT;

  // 推理强度：未指定则用 CLI 默认（high）；模型不支持的档位由 CLI 自动降级
  if (CLAUDE_EFFORT_LEVELS.has(options.effort)) {
    sdkOptions.effort = options.effort;
  }
  // Model logged at query start below

  // Map system prompt configuration
  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'  // Required to use CLAUDE.md
  };

  // Map setting sources for CLAUDE.md loading
  // This loads CLAUDE.md from project, user (~/.config/claude/CLAUDE.md), and local directories
  sdkOptions.settingSources = ['project', 'user', 'local'];

  // Map resume session
  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Array<string>} tempImagePaths - Temp image file paths for cleanup
 * @param {string} tempDir - Temp directory for cleanup
 */
function addSession(sessionId, queryInstance, tempImagePaths = [], tempDir = null, writer = null, input = null) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    input,
    startTime: Date.now(),
    status: 'active',
    tempImagePaths,
    tempDir,
    writer
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * 串流輸入佇列：讓同一個 query 在生成中能追加 user message（插話）。
 * 每則訊息帶 uuid；result 的 user_message_uuids 列出已消化的訊息，全部消化完才關閉輸入，
 * 否則關太早會丟掉剛插入、還沒被讀進去的訊息。
 */
function createInputQueue() {
  const buffer = [];
  const pending = new Set();
  let wake = null;
  let closed = false;

  const notify = () => { wake?.(); wake = null; };

  return {
    get closed() { return closed; },
    push(text) {
      if (closed) return false;
      const uuid = createRequestId();
      pending.add(uuid);
      buffer.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        uuid,
      });
      notify();
      return true;
    },
    /** 收到 result 時呼叫；回傳是否已關閉（沒有待處理的插話）。 */
    onResult(result) {
      const consumed = result.user_message_uuids;
      if (Array.isArray(consumed)) {
        for (const id of consumed) pending.delete(id);
        if (result.user_message_uuid) pending.delete(result.user_message_uuid);
      } else if (!result.queued_turn_count) {
        // 舊版 CLI 不回報 uuid：退回用 queued_turn_count 判斷，避免永遠不關閉
        pending.clear();
      }
      if (pending.size === 0) this.close();
      return closed;
    },
    /**
     * 結束輸入。正常收尾時 buffer 必然已空（pending 歸零代表都被讀走並消化）；
     * 中斷或出錯時丟掉尚未交給 CLI 的插話，避免停止後還被送進模型。
     */
    close() {
      closed = true;
      buffer.length = 0;
      pending.clear();
      notify();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (buffer.length) { yield buffer.shift(); continue; }
        if (closed) return;
        await new Promise(resolve => { wake = resolve; });
      }
    },
  };
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * Extracts token usage from SDK result messages
 * @param {Object} resultMessage - SDK result message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(resultMessage, lastUsage, lastModel) {
  if (resultMessage.type !== 'result' || !lastUsage) {
    return null;
  }

  // 上下文占用 = 最后一次 API 调用送出的输入（含缓存读写）+ 它的输出（下一轮会成为输入）。
  // 不能用 modelUsage 的累计值：每轮都会重复计入同一份缓存上下文，长会话会虚高数倍。
  const used = (lastUsage.input_tokens || 0)
    + (lastUsage.cache_read_input_tokens || 0)
    + (lastUsage.cache_creation_input_tokens || 0)
    + (lastUsage.output_tokens || 0);

  // 分母取 SDK 报告的模型上下文窗口（1M 模型即为 1000000）；拿不到才退回 CONTEXT_WINDOW
  const modelUsage = resultMessage.modelUsage || {};
  const contextWindow = modelUsage[lastModel]?.contextWindow
    || Math.max(0, ...Object.values(modelUsage).map((entry) => entry?.contextWindow || 0))
    || parseInt(process.env.CONTEXT_WINDOW, 10) || 200000;

  return { used, total: contextWindow };
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws) {
  const { sessionId, sessionSummary } = options;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;
  let tempImagePaths = [];
  let tempDir = null;
  let queryInstance;
  let input = null;
  let lastVisibleAssistantText = '';
  // 最後一個 result 若是錯誤（error_during_execution、error_max_turns 等），收尾時回報為失敗。
  // SDK 對這類 result 不會拋錯，迴圈照常結束。
  let lastResultError = null;

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  try {
    // Map CLI options to SDK format
    const sdkOptions = mapCliOptionsToSDK(options);

    // Load MCP configuration
    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Handle images - save to temp files and modify prompt
    const imageResult = await handleImages(command, options.images, options.cwd);
    const finalCommand = imageResult.modifiedCommand;
    tempImagePaths = imageResult.tempImagePaths;
    tempDir = imageResult.tempDir;

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: capturedSessionId || sessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${capturedSessionId || sessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: capturedSessionId || sessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${capturedSessionId || sessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          _userId: ws?.userId ?? null,
          _sessionId: capturedSessionId || sessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // Set stream-close timeout for interactive tools (Query constructor reads it synchronously). Claude Agent SDK has a default of 5s and this overrides it
    const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

    input = createInputQueue();
    input.push(finalCommand);
    try {
      queryInstance = query({
        prompt: input,
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      queryInstance = query({
        prompt: input,
        options: sdkOptions
      });
    }

    // Restore immediately — Query constructor already captured the value
    if (prevStreamTimeout !== undefined) {
      process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
    } else {
      delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    }

    // Track the query instance for abort capability
    if (capturedSessionId) {
      addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, input);
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    let lastMainUsage = null;
    let lastMainModel = null;
    for await (const message of queryInstance) {
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, input);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for new sessions
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        if (msg.kind === 'text' && msg.role === 'assistant' && typeof msg.content === 'string') {
          lastVisibleAssistantText = msg.content;
        }
        ws.send(msg);
      }

      // 只记主线程（非 subagent）的最后一次调用，subagent 的上下文与主会话无关
      if (message.type === 'assistant' && !message.parent_tool_use_id && message.message?.usage) {
        lastMainUsage = message.message.usage;
        lastMainModel = message.message.model;
      }

      // Extract and send token budget updates from result messages
      if (message.type === 'result') {
        input.onResult(message);
        lastResultError = message.is_error ? message : null;
        const tokenBudgetData = extractTokenBudget(message, lastMainUsage, lastMainModel);
        if (tokenBudgetData) {
          ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      }
    }

    // Clean up session on completion
    // 只刪自己的登記：中斷後使用者可能已在同一會話開了新一輪
    if (capturedSessionId && getSession(capturedSessionId)?.instance === queryInstance) {
      removeSession(capturedSessionId);
    }

    // Clean up temporary image files
    await cleanupTempFiles(tempImagePaths, tempDir);

    if (abortedQueries.has(queryInstance)) return;

    if (lastResultError) {
      const errorContent = (Array.isArray(lastResultError.errors) && lastResultError.errors.filter(Boolean).join('\n'))
        || (typeof lastResultError.result === 'string' && lastResultError.result.trim())
        || `Claude run failed (${lastResultError.subtype || 'error'})`;
      // 錯誤已以助理文字顯示過時不再重複一個錯誤泡泡，改送失敗的 complete；兩者前端都視為出錯
      ws.send(createNormalizedMessage(shouldSuppressClaudeWrappedError(lastVisibleAssistantText, errorContent)
        ? { kind: 'complete', exitCode: 1, isNewSession: !sessionId && !!command, sessionId: capturedSessionId, provider: 'claude' }
        : { kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: capturedSessionId || sessionId || null,
        sessionName: sessionSummary,
        error: new Error(errorContent)
      });
      return;
    }

    // Send completion event
    ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 0, isNewSession: !sessionId && !!command, sessionId: capturedSessionId, provider: 'claude' }));
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      stopReason: 'completed'
    });
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);
    input?.close();

    // Clean up session on error
    // 只刪自己的登記：中斷後使用者可能已在同一會話開了新一輪
    if (capturedSessionId && getSession(capturedSessionId)?.instance === queryInstance) {
      removeSession(capturedSessionId);
    }

    // Clean up temporary image files on error
    await cleanupTempFiles(tempImagePaths, tempDir);

    if (queryInstance && abortedQueries.has(queryInstance)) return;

    // Check if this is a session resume failure (exit code 1 during resume)
    const isResumeFailure = sessionId && error.message && (
      error.message.includes('exited with code 1') ||
      error.message.includes('session not found') ||
      error.message.includes('invalid session') ||
      error.message.includes('No conversation found')
    );

    if (isResumeFailure) {
      console.log(`[SDK] Session resume failed for ${sessionId}, notifying client to start new session`);
      // Send specific error for session resume failure so frontend can handle it
      ws.send(createNormalizedMessage({
        kind: 'error',
        content: `Session "${sessionId}" has expired or is no longer available. Please start a new conversation.`,
        code: 'SESSION_RESUME_FAILED',
        sessionId: sessionId,
        provider: 'claude'
      }));
    } else {
      // Check if Claude CLI is installed for a clearer error message
      const installed = await providerAuthService.isProviderInstalled('claude');
      const errorContent = !installed
        ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code' + providerAuthService.cliLookupPathHint()
        : error.message;

      // The SDK can first emit the API error as assistant text and then throw a
      // wrapper for the same failure. The text is already durable, so do not
      // create a second error bubble.
      if (!shouldSuppressClaudeWrappedError(lastVisibleAssistantText, errorContent)) {
        ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }
    }


    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      error
    });
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // 先標記再 interrupt：interrupt 期間迴圈就可能結束並走到收尾
    abortedQueries.add(session.instance);
    // 中斷後不再接受插話，並結束輸入串流讓 query 迴圈收尾
    session.input?.close();
    await session.instance.interrupt();

    // Update session status
    session.status = 'aborted';

    // Clean up temporary image files
    await cleanupTempFiles(session.tempImagePaths, session.tempDir);

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // 中斷失敗代表這一輪仍在跑，讓它照常送出自己的終止事件
    abortedQueries.delete(session.instance);
    return false;
  }
}

/**
 * 生成中插話：把訊息推進該會話的串流輸入，CLI 會在工具回合之間併入目前這一輪，來不及則排成下一輪。
 */
async function steerClaudeSDKSession(sessionId, userId, text) {
  const session = getSession(sessionId);
  if (!session || session.status !== 'active') return { ok: false, reason: 'not_running' };
  const ownerId = session.writer?.userId;
  if (userId === null || userId === undefined || ownerId === null || ownerId === undefined
    || String(ownerId) !== String(userId)) {
    return { ok: false, reason: 'not_owner' };
  }
  if (!text.trim()) return { ok: false, reason: 'empty' };
  if (!session.input?.push(text)) return { ok: false, reason: 'not_running' };
  return { ok: true };
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active';
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * 列出某使用者的待審批項目；帶 sessionId 時只列該會話，不帶則跨所有會話。
 * @param {string|number|null} userId
 * @param {string} [sessionId]
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovals(userId, sessionId) {
  const pending = [];
  if (userId === null || userId === undefined) return pending;
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (String(resolver._userId) !== String(userId)) continue;
    if (!sessionId || resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId: resolver._sessionId,
        provider: 'claude',
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  steerClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovals,
  waitForToolApproval,
  reconnectSessionWriter,
  extractTokenBudget,
  createInputQueue
};
