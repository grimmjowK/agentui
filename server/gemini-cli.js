import pty from 'node-pty';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import crossSpawn from 'cross-spawn';

import sessionManager from './sessionManager.js';
import GeminiResponseHandler from './gemini-response-handler.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createNormalizedMessage } from './shared/utils.js';
import { stripAnsiSequences } from './utils/url-detection.js';

// Use cross-spawn on Windows for correct .cmd resolution (same pattern as cursor-cli.js)
const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

let activeGeminiProcesses = new Map(); // Track active processes by session ID

function mapGeminiExitCodeToMessage(exitCode) {
    switch (exitCode) {
        case 42:
            return 'Gemini rejected the request input (exit code 42).';
        case 44:
            return 'Gemini sandbox error (exit code 44). Check local sandbox/container settings.';
        case 52:
            return 'Gemini configuration error (exit code 52). Check your Gemini settings files for invalid JSON/config.';
        case 53:
            return 'Gemini conversation turn limit reached (exit code 53). Start a new Gemini session.';
        default:
            return null;
    }
}

const GEMINI_AUTH_ENV_KEYS = [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_PROJECT_ID',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_APPLICATION_CREDENTIALS'
];

function parseEnvFileContent(content) {
    const parsed = {};

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        const exportPrefix = 'export ';
        const normalizedLine = line.startsWith(exportPrefix) ? line.slice(exportPrefix.length).trim() : line;
        const separatorIndex = normalizedLine.indexOf('=');

        if (separatorIndex <= 0) {
            continue;
        }

        const key = normalizedLine.slice(0, separatorIndex).trim();
        if (!key) {
            continue;
        }

        let value = normalizedLine.slice(separatorIndex + 1).trim();
        const hasDoubleQuotes = value.startsWith('"') && value.endsWith('"');
        const hasSingleQuotes = value.startsWith('\'') && value.endsWith('\'');

        if (hasDoubleQuotes || hasSingleQuotes) {
            value = value.slice(1, -1);
        } else {
            // Support inline comments in unquoted values: KEY=value # comment
            value = value.replace(/\s+#.*$/, '').trim();
        }

        parsed[key] = value;
    }

    return parsed;
}

async function loadGeminiUserLevelEnv() {
    const geminiCliHome = (process.env.GEMINI_CLI_HOME || '').trim() || os.homedir();
    const envCandidates = [
        path.join(geminiCliHome, '.gemini', '.env'),
        path.join(geminiCliHome, '.env')
    ];

    for (const envPath of envCandidates) {
        try {
            await fs.access(envPath);
            const content = await fs.readFile(envPath, 'utf8');
            return parseEnvFileContent(content);
        } catch {
            // Keep scanning for the next candidate.
        }
    }

    return {};
}

async function buildGeminiProcessEnv() {
    const processEnv = { ...process.env };
    if (processEnv.GEMINI_API_KEY || processEnv.GOOGLE_API_KEY || processEnv.GOOGLE_APPLICATION_CREDENTIALS) {
        return processEnv;
    }

    // Gemini CLI docs recommend ~/.gemini/.env for persistent headless auth settings.
    // When the server process was launched without shell profile variables, we still
    // want the spawned CLI process to inherit those user-level credentials.
    const userEnv = await loadGeminiUserLevelEnv();
    for (const key of GEMINI_AUTH_ENV_KEYS) {
        if (!processEnv[key] && userEnv[key]) {
            processEnv[key] = userEnv[key];
        }
    }

    return processEnv;
}

async function spawnGemini(command, options = {}, ws) {
    const { sessionId, projectPath, cwd, toolsSettings, permissionMode, images, sessionSummary } = options;
    let capturedSessionId = sessionId;
    let sessionCreatedSent = false;
    let assistantBlocks = [];

    const settings = toolsSettings || {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false
    };

    const args = [];
    let promptCommand = (command && command.trim()) ? command : null;

    if (sessionId) {
        const session = sessionManager.getSession(sessionId);
        if (session && session.cliSessionId && isValidGeminiResumeId(session.cliSessionId)) {
            args.push('--resume', session.cliSessionId);
        }
    }

    const cleanPath = (cwd || projectPath || process.cwd()).replace(/[^\x20-\x7E]/g, '').trim();
    const workingDir = cleanPath;

    // 处理图片
    const tempImagePaths = [];
    let tempDir = null;
    if (images && images.length > 0) {
        try {
            tempDir = path.join(workingDir, '.tmp', 'images', Date.now().toString());
            await fs.mkdir(tempDir, { recursive: true });

            for (const [index, image] of images.entries()) {
                const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
                if (!matches) continue;

                const [, mimeType, base64Data] = matches;
                const extension = mimeType.split('/')[1] || 'png';
                const filename = `image_${index}.${extension}`;
                const filepath = path.join(tempDir, filename);
                await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
                tempImagePaths.push(filepath);
            }

            if (tempImagePaths.length > 0 && promptCommand) {
                const imageNote = `\n\n[Images given: ${tempImagePaths.length} images are located at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
                promptCommand = promptCommand + imageNote;
            }
        } catch (error) {
            console.error('Error processing images for Gemini:', error);
        }
    }

    if (options.debug) {
        args.push('--debug');
    }

    // This integration runs Gemini in headless mode and cannot answer trust prompts.
    // Skip folder-trust interactivity so authenticated runs don't fail with
    // FatalUntrustedWorkspaceError in previously unseen directories.
    args.push('--skip-trust');

    // Add MCP config flag only if MCP servers are configured
    try {
        const geminiConfigPath = path.join(os.homedir(), '.gemini.json');
        let hasMcpServers = false;

        try {
            await fs.access(geminiConfigPath);
            const geminiConfigRaw = await fs.readFile(geminiConfigPath, 'utf8');
            const geminiConfig = JSON.parse(geminiConfigRaw);

            if (geminiConfig.mcpServers && Object.keys(geminiConfig.mcpServers).length > 0) {
                hasMcpServers = true;
            }

            if (!hasMcpServers && geminiConfig.geminiProjects) {
                const currentProjectPath = process.cwd();
                const projectConfig = geminiConfig.geminiProjects[currentProjectPath];
                if (projectConfig && projectConfig.mcpServers && Object.keys(projectConfig.mcpServers).length > 0) {
                    hasMcpServers = true;
                }
            }
        } catch (e) {
            // Ignore
        }

        if (hasMcpServers) {
            args.push('--mcp-config', geminiConfigPath);
        }
    } catch (error) {
        // Ignore
    }

    let modelToUse = options.model || 'gemini-2.5-flash';
    args.push('--model', modelToUse);
    args.push('--output-format', 'stream-json');

    // headless 模式（--prompt + --output-format stream-json）下，Gemini CLI 禁用需要用户确认的工具
    // （如 run_shell_command、write_file），只有 --yolo 能让所有工具可用
    args.push('--yolo');

    // 不再传递 --allowed-tools：该参数已被 Gemini CLI 官方废弃（v0.42+），
    // 且传入不匹配的工具名会意外限制可用工具，导致 "Tool not found" 错误

    const geminiPath = process.env.GEMINI_PATH || 'gemini';
    let spawnCmd = geminiPath;
    let spawnArgs = args;

    // On non-Windows platforms, wrap the execution in a shell to avoid ENOEXEC
    // which happens when the target is a script lacking a shebang.
    if (os.platform() !== 'win32') {
        spawnCmd = 'sh';
        // Use exec to replace the shell process, ensuring signals hit gemini directly
        spawnArgs = ['-c', 'exec "$0" "$@"', geminiPath, ...args];
    }

    const spawnEnv = await buildGeminiProcessEnv();

    return new Promise((resolve, reject) => {
        const geminiProcess = spawnFunction(spawnCmd, spawnArgs, {
            cwd: workingDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: spawnEnv
        });
        let terminalNotificationSent = false;
        let terminalFailureReason = null;

        // 统一使用 --prompt（headless 模式），配合 --approval-mode auto_edit 允许文件编辑
        const spawnArgs = [...args];
        if (promptCommand) {
            spawnArgs.push('--prompt', promptCommand);
        }

        try {
            geminiProcess = pty.spawn(geminiPath, spawnArgs, {
                name: 'xterm-256color',
                cols: 250,
                rows: 50,
                cwd: workingDir,
                env: { ...process.env }
            });
            isPty = true;
        } catch (ptyError) {
            console.warn('PTY spawn failed, falling back to child_process.spawn:', ptyError.message);
            isPty = false;

            let spawnCmd = geminiPath;
            let finalArgs = spawnArgs;
            if (os.platform() !== 'win32') {
                spawnCmd = 'sh';
                finalArgs = ['-c', 'exec "$0" "$@"', geminiPath, ...spawnArgs];
            }

            geminiProcess = spawnFunction(spawnCmd, finalArgs, {
                cwd: workingDir,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env }
            });
            geminiProcess.stdin.end();
        }

        let terminalNotificationSent = false;
        let terminalFailureReason = null;
        const permissionDetector = new GeminiPermissionDetector();

        const notifyTerminalState = ({ code = null, error = null } = {}) => {
            if (terminalNotificationSent) return;
            terminalNotificationSent = true;

            const finalSessionId = capturedSessionId || sessionId || processKey;
            if (code === 0 && !error) {
                notifyRunStopped({
                    userId: ws?.userId || null,
                    provider: 'gemini',
                    sessionId: finalSessionId,
                    sessionName: sessionSummary,
                    stopReason: 'completed'
                });
                return;
            }

            notifyRunFailed({
                userId: ws?.userId || null,
                provider: 'gemini',
                sessionId: finalSessionId,
                sessionName: sessionSummary,
                error: error || terminalFailureReason || `Gemini CLI exited with code ${code}`
            });
        };

        geminiProcess.tempImagePaths = tempImagePaths;
        geminiProcess.tempDir = tempDir;

        const processKey = capturedSessionId || sessionId || Date.now().toString();
        activeGeminiProcesses.set(processKey, geminiProcess);
        geminiProcess._sessionId = processKey;
        geminiProcess._isPty = isPty;

        const timeoutMs = 120000;
        let timeout;

        const startTimeout = () => {
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(() => {
                const socketSessionId = capturedSessionId || sessionId || processKey;
                terminalFailureReason = `Gemini CLI timeout - no response received for ${timeoutMs / 1000} seconds`;
                ws.send(createNormalizedMessage({ kind: 'error', content: terminalFailureReason, sessionId: socketSessionId, provider: 'gemini' }));
                try {
                    if (isPty) {
                        geminiProcess.kill();
                    } else {
                        geminiProcess.kill('SIGTERM');
                    }
                } catch (e) { }
            }, timeoutMs);
        };

        startTimeout();

        const ensureSessionCreated = () => {
            if (sessionId || sessionCreatedSent || capturedSessionId) return;
            capturedSessionId = `gemini_${Date.now()}`;
            sessionCreatedSent = true;
            sessionManager.createSession(capturedSessionId, cwd || process.cwd());
            if (command) {
                sessionManager.addMessage(capturedSessionId, 'user', command);
            }
            if (processKey !== capturedSessionId) {
                activeGeminiProcesses.delete(processKey);
                activeGeminiProcesses.set(capturedSessionId, geminiProcess);
            }
            ws.setSessionId && typeof ws.setSessionId === 'function' && ws.setSessionId(capturedSessionId);
            if (responseHandler) {
                responseHandler.setSessionId(capturedSessionId);
            }
            ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'gemini' }));
        };

        if (command && capturedSessionId) {
            sessionManager.addMessage(capturedSessionId, 'user', command);
        }

        // 权限提示处理
        async function handlePermissionPrompt(prompt) {
            const requestId = createRequestId();
            const socketSessionId = capturedSessionId || sessionId || processKey;

            ws.send(createNormalizedMessage({
                kind: 'permission_request',
                requestId,
                toolName: prompt.toolName,
                input: {},
                sessionId: socketSessionId,
                provider: 'gemini'
            }));

            const decision = await waitForGeminiApproval(requestId);

            if (!decision) {
                // 超时拒绝
                if (isPty) {
                    geminiProcess.write('\x1b');
                }
                ws.send(createNormalizedMessage({
                    kind: 'permission_cancelled',
                    requestId,
                    reason: 'timeout',
                    sessionId: socketSessionId,
                    provider: 'gemini'
                }));
                return;
            }

            if (isPty) {
                if (decision.allow) {
                    geminiProcess.write('2\n');
                } else {
                    geminiProcess.write('\x1b');
                }
            }
        }

        // 处理非 JSON 行（仅用于权限提示检测）
        function handleNonJsonLine(line) {
            if (isStderrNoise(line)) return;

            const cleanLine = stripAnsiSequences(line).trim();
            if (!cleanLine) return;

            // 检测权限提示
            const permissionPrompt = permissionDetector.feed(cleanLine);
            if (permissionPrompt) {
                handlePermissionPrompt(permissionPrompt);
            }
        }

        let responseHandler;
        if (ws) {
            responseHandler = new GeminiResponseHandler(ws, {
                sessionId: capturedSessionId || sessionId || processKey,
                onContentFragment: (content) => {
                    if (assistantBlocks.length > 0 && assistantBlocks[assistantBlocks.length - 1].type === 'text') {
                        assistantBlocks[assistantBlocks.length - 1].text += content;
                    } else {
                        assistantBlocks.push({ type: 'text', text: content });
                    }
                },
                onToolUse: (event) => {
                    assistantBlocks.push({
                        type: 'tool_use',
                        id: event.tool_id,
                        name: event.tool_name,
                        input: event.parameters
                    });
                },
                onToolResult: (event) => {
                    if (capturedSessionId) {
                        if (assistantBlocks.length > 0) {
                            sessionManager.addMessage(capturedSessionId, 'assistant', [...assistantBlocks]);
                            assistantBlocks = [];
                        }
                        sessionManager.addMessage(capturedSessionId, 'user', [{
                            type: 'tool_result',
                            tool_use_id: event.tool_id,
                            content: event.output === undefined ? null : event.output,
                            is_error: event.status === 'error'
                        }]);
                    }
                },
                onInit: (event) => {
                    const discoveredSessionId = event?.session_id;
                    if (!discoveredSessionId) {
                        return;
                    }

                    // New Gemini sessions announce their canonical ID asynchronously via the
                    // initial `init` stream event. Avoid synthetic IDs and only register
                    // the session once that real ID is known (same model used by Claude/Codex).
                    if (!capturedSessionId) {
                        capturedSessionId = discoveredSessionId;

                        sessionManager.createSession(capturedSessionId, cwd || process.cwd());
                        if (command) {
                            sessionManager.addMessage(capturedSessionId, 'user', command);
                        }

                        if (processKey !== capturedSessionId) {
                            activeGeminiProcesses.delete(processKey);
                            activeGeminiProcesses.set(capturedSessionId, geminiProcess);
                        }

                        geminiProcess.sessionId = capturedSessionId;

                        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
                            ws.setSessionId(capturedSessionId);
                        }

                        if (!sessionId && !sessionCreatedSent) {
                            sessionCreatedSent = true;
                            ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'gemini' }));
                        }
                    }

                    const sess = sessionManager.getSession(capturedSessionId);
                    if (sess && !sess.cliSessionId) {
                        sess.cliSessionId = discoveredSessionId;
                        sessionManager.saveSession(capturedSessionId);
                    }
                },
                onNonJsonLine: handleNonJsonLine
            });
        }

        // 数据处理 — 适配 PTY 和普通 spawn 两种模式
        const onDataHandler = (data) => {
            const rawOutput = typeof data === 'string' ? data : data.toString();
            startTimeout();

            if (responseHandler) {
                responseHandler.processData(rawOutput);
            } else if (rawOutput) {
                const cleanOutput = stripAnsiSequences(rawOutput);
                if (isStderrNoise(cleanOutput)) return;

                if (assistantBlocks.length > 0 && assistantBlocks[assistantBlocks.length - 1].type === 'text') {
                    assistantBlocks[assistantBlocks.length - 1].text += cleanOutput;
                } else {
                    assistantBlocks.push({ type: 'text', text: cleanOutput });
                }
                const socketSessionId = capturedSessionId || sessionId || processKey;
                ws.send(createNormalizedMessage({ kind: 'stream_delta', content: cleanOutput, sessionId: socketSessionId, provider: 'gemini' }));
            }
        };

        // 进程退出处理
        const onExitHandler = async (codeOrObj) => {
            const code = typeof codeOrObj === 'object' ? codeOrObj.exitCode : codeOrObj;
            clearTimeout(timeout);

            if (responseHandler) {
                responseHandler.forceFlush();
                responseHandler.destroy();
            }

            ensureSessionCreated();

            const finalSessionId = capturedSessionId || sessionId || processKey;
            activeGeminiProcesses.delete(finalSessionId);

            if (finalSessionId && assistantBlocks.length > 0) {
                sessionManager.addMessage(finalSessionId, 'assistant', assistantBlocks);
            }

            // 非 0 退出码时发送错误信息
            if (code !== 0 && code !== null) {
                let errorMsg;
                if (code === 127) {
                    const installed = await providerAuthService.isProviderInstalled('gemini');
                    errorMsg = !installed
                        ? 'Gemini CLI is not installed. Please install it first: https://github.com/google-gemini/gemini-cli'
                        : `Gemini CLI exited with code ${code}`;
                } else if (code === 42) {
                    errorMsg = 'Gemini CLI input error (invalid arguments or session). Please start a new conversation.';
                } else {
                    errorMsg = `Gemini CLI exited with code ${code}`;
                }
                ws.send(createNormalizedMessage({ kind: 'error', content: errorMsg, sessionId: finalSessionId, provider: 'gemini' }));
            }

            ws.send(createNormalizedMessage({ kind: 'complete', exitCode: code, isNewSession: !sessionId && !!command, sessionId: finalSessionId, provider: 'gemini' }));

            // 清理临时图片
            const imgPaths = geminiProcess.tempImagePaths || geminiProcess._tempImagePaths;
            const imgDir = geminiProcess.tempDir || geminiProcess._tempDir;
            if (imgPaths && imgPaths.length > 0) {
                for (const imagePath of imgPaths) {
                    await fs.unlink(imagePath).catch(() => { });
                }
                if (imgDir) {
                    await fs.rm(imgDir, { recursive: true, force: true }).catch(() => { });
                }
            }

            if (code === 0) {
                notifyTerminalState({ code });
                resolve();
            } else {
                const socketSessionId = typeof ws.getSessionId === 'function' ? ws.getSessionId() : finalSessionId;

                // code 127 = shell "command not found" - check installation
                if (code === 127) {
                    const installed = await providerAuthService.isProviderInstalled('gemini');
                    if (!installed) {
                        terminalFailureReason = 'Gemini CLI is not installed. Please install it first: https://github.com/google-gemini/gemini-cli';
                        ws.send(createNormalizedMessage({ kind: 'error', content: terminalFailureReason, sessionId: socketSessionId, provider: 'gemini' }));
                    }
                } else if (code === 41) {
                    // Gemini CLI documents exit code 41 as FatalAuthenticationError.
                    // Surface an actionable auth error instead of a generic exit-code message.
                    let authErrorSuffix = '';
                    try {
                        const authStatus = await providerAuthService.getProviderAuthStatus('gemini');
                        if (!authStatus?.authenticated && authStatus?.error) {
                            authErrorSuffix = ` Details: ${authStatus.error}`;
                        }
                    } catch {
                        // Keep base remediation text when auth status lookup fails.
                    }

                    terminalFailureReason =
                        'Gemini authentication failed (exit code 41). '
                        + 'Run `gemini` in a terminal to choose an auth method, or configure a valid `GEMINI_API_KEY`.'
                        + authErrorSuffix;
                    ws.send(createNormalizedMessage({ kind: 'error', content: terminalFailureReason, sessionId: socketSessionId, provider: 'gemini' }));
                } else {
                    const mappedError = mapGeminiExitCodeToMessage(code);
                    if (mappedError) {
                        terminalFailureReason = mappedError;
                        ws.send(createNormalizedMessage({ kind: 'error', content: terminalFailureReason, sessionId: socketSessionId, provider: 'gemini' }));
                    }
                }

                notifyTerminalState({
                    code,
                    error: code === null ? 'Gemini CLI process was terminated or timed out' : null
                });
                reject(
                    new Error(
                        terminalFailureReason
                        || (code === null
                            ? 'Gemini CLI process was terminated or timed out'
                            : `Gemini CLI exited with code ${code}`)
                    )
                );
            }
        };

        if (isPty) {
            // PTY 模式
            geminiProcess.onData(onDataHandler);
            geminiProcess.onExit(onExitHandler);
        } else {
            // 普通 spawn 回退模式
            geminiProcess.stdout.on('data', onDataHandler);

            geminiProcess.stderr.on('data', (data) => {
                const errorMsg = data.toString();
                if (isStderrNoise(errorMsg)) return;

                const parsedError = parseGeminiErrorMessage(errorMsg);
                const socketSessionId = capturedSessionId || sessionId || processKey;
                ws.send(createNormalizedMessage({ kind: 'error', content: parsedError, sessionId: socketSessionId, provider: 'gemini' }));
            });

            geminiProcess.on('close', onExitHandler);

            geminiProcess.on('error', async (error) => {
                ensureSessionCreated();

                const finalSessionId = capturedSessionId || sessionId || processKey;
                activeGeminiProcesses.delete(finalSessionId);

                const installed = await providerAuthService.isProviderInstalled('gemini');
                const errorContent = !installed
                    ? 'Gemini CLI is not installed. Please install it first: https://github.com/google-gemini/gemini-cli'
                    : error.message;

                const errorSessionId = capturedSessionId || sessionId || processKey;
                ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: errorSessionId, provider: 'gemini' }));
                notifyTerminalState({ error });

                reject(error);
            });
        }
    });
}

function abortGeminiSession(sessionId) {
    let geminiProc = activeGeminiProcesses.get(sessionId);
    let processKey = sessionId;

    if (!geminiProc) {
        for (const [key, proc] of activeGeminiProcesses.entries()) {
            if (proc._sessionId === sessionId || proc.sessionId === sessionId) {
                geminiProc = proc;
                processKey = key;
                break;
            }
        }
    }

    if (geminiProc) {
        try {
            if (geminiProc._isPty) {
                geminiProc.kill();
                setTimeout(() => {
                    if (activeGeminiProcesses.has(processKey)) {
                        try { geminiProc.kill(9); } catch (e) { }
                    }
                }, 2000);
            } else {
                geminiProc.kill('SIGTERM');
                setTimeout(() => {
                    if (activeGeminiProcesses.has(processKey)) {
                        try { geminiProc.kill('SIGKILL'); } catch (e) { }
                    }
                }, 2000);
            }
            return true;
        } catch (error) {
            return false;
        }
    }
    return false;
}

function isGeminiSessionActive(sessionId) {
    return activeGeminiProcesses.has(sessionId);
}

function getActiveGeminiSessions() {
    return Array.from(activeGeminiProcesses.keys());
}

export {
    spawnGemini,
    abortGeminiSession,
    isGeminiSessionActive,
    getActiveGeminiSessions,
    resolveGeminiApproval
};
