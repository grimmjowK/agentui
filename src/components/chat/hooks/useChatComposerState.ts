import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';
import { useTranslation } from 'react-i18next';

import { PROVIDER_INFO } from '../../../../shared/providers';
import { NEW_SESSION_KEY, queuedMessages, useQueuedMessages, type QueuedMessage } from '../../../stores/queuedMessagesStore';
import { authenticatedFetch } from '../../../utils/api';
import { EFFORT_STORAGE_KEY, resolveEffort } from '../constants/thinkingModes';
import { grantClaudeToolPermission } from '../utils/chatPermissions';
import { safeLocalStorage, saveSessionModel } from '../utils/chatStorage';
import type {
  ChatMessage,
  PendingPermissionRequest,
  PermissionMode,
} from '../types/types';
import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import { escapeRegExp } from '../utils/chatFormatting';

import { useFileMentions } from './useFileMentions';
import { type SlashCommand, useSlashCommands } from './useSlashCommands';
import type { TurnOutcome } from './useChatRealtimeHandlers';

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

interface UseChatComposerStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  modelByProvider: Record<LLMProvider, string>;
  setModelFor: (provider: LLMProvider, model: string) => void;
  isLoading: boolean;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => boolean;
  sendByCtrlEnter?: boolean;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  pendingViewSessionRef: { current: PendingViewSession | null };
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage) => void;
  clearMessages: () => void;
  rewindMessages: (count: number) => void;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setClaudeStatus: (status: { text: string; tokens: number; can_interrupt: boolean } | null) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  onRunInShell?: (command: string) => void;
}

interface MentionableFile {
  name: string;
  path: string;
}

interface CommandExecutionResult {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
}

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
};

export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  cyclePermissionMode,
  modelByProvider,
  setModelFor,
  isLoading,
  canAbortSession,
  tokenBudget,
  sendMessage,
  sendByCtrlEnter,
  onSessionActive,
  onSessionProcessing,
  onSessionNotProcessing,
  onInputFocusChange,
  onFileOpen,
  onShowSettings,
  pendingViewSessionRef,
  scrollToBottom,
  addMessage,
  clearMessages,
  rewindMessages,
  setIsLoading,
  setCanAbortSession,
  setClaudeStatus,
  setIsUserScrolledUp,
  setPendingPermissionRequests,
  pendingPermissionRequests,
  onRunInShell,
}: UseChatComposerStateArgs) {
  const [input, setInput] = useState(() => {
    if (typeof window !== 'undefined' && selectedProject) {
      // Draft inputs are keyed by the DB projectId so per-project drafts
      // survive display-name changes.
      return safeLocalStorage.getItem(`draft_input_${selectedProject.projectId}`) || '';
    }
    return '';
  });
  const [attachedImages, setAttachedImages] = useState<File[]>([]);
  const [uploadingImages, setUploadingImages] = useState<Map<string, number>>(new Map());
  const [imageErrors, setImageErrors] = useState<Map<string, string>>(new Map());
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const { t } = useTranslation('chat');
  // 執行中插話（design D9）：等待後端回覆期間不能再送第二則
  const pendingSteerRef = useRef<{
    itemId: string;
    queueKey: string;
    text: string;
    sessionId: string;
    provider: LLMProvider;
  } | null>(null);
  const steerSessionId = currentSessionId || selectedSession?.id || null;
  const canSteer = isLoading && PROVIDER_INFO[provider].capabilities.midTurnSteer && Boolean(steerSessionId);
  // 生成中送出的待送佇列（chat-queued-steer-composer）
  const queueKey = steerSessionId || NEW_SESSION_KEY;
  const queuedItems = useQueuedMessages(queueKey);
  // 這一輪正常結束、且是畫面上的會話時，由 effect 自動送出佇列第一則
  const [autoSendTick, setAutoSendTick] = useState(0);
  // 推理强度（effort）。跨消息、跨会话保持，不再每次发送后重置
  const [thinkingMode, setThinkingMode] = useState(() => safeLocalStorage.getItem(EFFORT_STORAGE_KEY) || 'default');
  useEffect(() => {
    safeLocalStorage.setItem(EFFORT_STORAGE_KEY, thinkingMode);
  }, [thinkingMode]);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);

  const [pendingCommand, setPendingCommand] = useState<SlashCommand | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const handleSubmitRef = useRef<
    ((
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queued?: QueuedMessage,
    ) => Promise<void>) | null
  >(null);
  const inputValueRef = useRef(input);
  const selectedProjectId = selectedProject?.projectId;
  const displayTextOverrideRef = useRef<string | null>(null);
  const pendingCommandAppendedTextRef = useRef<string>('');

  // 从已有会话导航到新会话时，同步清除输入框内容，
  // 防止旧会话的草稿文本残留
  const prevSessionIdForInputRef = useRef(selectedSession?.id);
  if (prevSessionIdForInputRef.current && !selectedSession) {
    setInput('');
    inputValueRef.current = '';
  }
  prevSessionIdForInputRef.current = selectedSession?.id;

  const handleModelSwitch = useCallback((modelValue: string) => {
    // 已有 session 只記到該 session；新 session 才更新全域預設
    const sessionId = selectedSession?.id;
    setModelFor(provider, modelValue);
    if (sessionId) saveSessionModel(sessionId, modelValue);
    else localStorage.setItem(`${provider}-model`, modelValue);
    setInput('');
    inputValueRef.current = '';
    addMessage({
      type: 'assistant',
      content: `Model switched to: **${modelValue}**`,
      timestamp: Date.now(),
    });
  }, [provider, selectedSession?.id, setModelFor, addMessage]);

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'clear':
          clearMessages();
          break;

        case 'help':
          addMessage({
            type: 'assistant',
            content: data.content,
            timestamp: Date.now(),
          });
          break;

        case 'model': {
          if (data.message && data.message.startsWith('Switching to model:')) {
            const targetModel = data.message.replace('Switching to model: ', '').trim();
            handleModelSwitch(targetModel);
          } else {
            // 不带参数的 /model 直接拉起输入框右下角的选择器，
            // 而不是在消息流里塞一份一次性的列表
            setIsModelMenuOpen(true);
          }
          break;
        }

        case 'cost': {
          const costMessage = `**Token Usage**: ${data.tokenUsage.used.toLocaleString()} / ${data.tokenUsage.total.toLocaleString()} (${data.tokenUsage.percentage}%)\n\n**Estimated Cost**:\n- Input: $${data.cost.input}\n- Output: $${data.cost.output}\n- **Total**: $${data.cost.total}\n\n**Model**: ${data.model}`;
          addMessage({ type: 'assistant', content: costMessage, timestamp: Date.now() });
          break;
        }

        case 'status': {
          const statusMessage = `**System Status**\n\n- Version: ${data.version}\n- Uptime: ${data.uptime}\n- Model: ${data.model}\n- Provider: ${data.provider}\n- Node.js: ${data.nodeVersion}\n- Platform: ${data.platform}`;
          addMessage({ type: 'assistant', content: statusMessage, timestamp: Date.now() });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        case 'rewind':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            rewindMessages(data.steps * 2);
            addMessage({
              type: 'assistant',
              content: `Rewound ${data.steps} step(s). ${data.message}`,
              timestamp: Date.now(),
            });
          }
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage, clearMessages, rewindMessages, handleModelSwitch],
  );

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        'This command contains bash commands that will be executed. Do you want to proceed?',
      );
      if (!confirmed) {
        addMessage({
          type: 'assistant',
          content: 'Command execution cancelled',
          timestamp: Date.now(),
        });
        return;
      }
    }

    const commandContent = content || '';
    // Append the user's original text so the AI has the full context even when
    // the template has no $ARGUMENTS placeholder.
    const appendedText = pendingCommandAppendedTextRef.current;
    pendingCommandAppendedTextRef.current = '';
    const finalContent = appendedText
      ? `${commandContent}\n\n${appendedText}`
      : commandContent;
    setInput(finalContent);
    inputValueRef.current = finalContent;

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent());
      }
    }, 0);
  }, [addMessage]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string) => {
      if (!command || !selectedProject) {
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        // 使用 `s`（dotAll）标志，使追加文本中的换行也能被捕获，
        // 否则换行后的内容会被丢弃、无法作为参数发送给 CLI。
        const commandMatch = effectiveInput.match(new RegExp(`${escapeRegExp(command.name)}\\s*([\\s\\S]*)`));
        const args =
          commandMatch && commandMatch[1] ? commandMatch[1].trim().split(/\s+/) : [];

        // The `/api/commands/execute` context sends `projectId` now instead of
        // a folder-derived project name; the path is still included verbatim.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: currentSessionId,
          provider,
          model: modelByProvider[provider],
          tokenUsage: tokenBudget,
        };

        const response = await authenticatedFetch('/api/commands/execute', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            commandName: command.name,
            commandPath: command.path,
            commandType: command.type,
            args,
            context,
          }),
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          setInput('');
          inputValueRef.current = '';
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      modelByProvider,
      currentSessionId,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      addMessage,
      tokenBudget,
    ],
  );

  const handleSelectCommand = useCallback((command: SlashCommand) => {
    setPendingCommand(command);
    setInput('');
    inputValueRef.current = '';
  }, []);

  const currentModel = modelByProvider[provider];

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    submenuMode,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
    onSelectCommand: handleSelectCommand,
    onModelSwitch: handleModelSwitch,
    onRunInShell,
    currentModel,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const handleImageFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        if (!file.type || !file.type.startsWith('image/')) {
          return false;
        }

        if (!file.size || file.size > 5 * 1024 * 1024) {
          const fileName = file.name || 'Unknown file';
          setImageErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, 'File too large (max 5MB)');
            return next;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedImages((previous) => [...previous, ...validFiles].slice(0, 5));
    }
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleImageFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleImageFiles(imageFiles);
        }
      }
    },
    [handleImageFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    accept: {
      'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
    },
    maxSize: 5 * 1024 * 1024,
    maxFiles: 5,
    onDrop: handleImageFiles,
    noClick: true,
    noKeyboard: true,
  });

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queued?: QueuedMessage,
    ) => {
      event.preventDefault();
      // queued：送出佇列項目，用它的內容，不動輸入框（使用者可能正在寫下一則）
      const currentInput = queued ? queued.text : inputValueRef.current;
      const images = queued ? queued.images : attachedImages;
      // ponytail: 送出失敗時放回佇列尾端，多則排隊時順序會變；失敗很少見，需要時改成插回原位
      const requeue = () => {
        if (queued) queuedMessages.enqueue(queueKey, queued.text, queued.images);
      };
      const clearComposer = () => {
        if (queued) return;
        setInput('');
        inputValueRef.current = '';
        setAttachedImages([]);
        setUploadingImages(new Map());
        setImageErrors(new Map());
        resetCommandMenuState();
        setIsTextareaExpanded(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
      };

      // 生成中送出：先進佇列，這一輪結束後再送（或由使用者按立即引導）
      if (!queued && isLoading) {
        if (pendingCommand || (!currentInput.trim() && attachedImages.length === 0)) return;
        queuedMessages.enqueue(queueKey, currentInput, attachedImages);
        clearComposer();
        return;
      }

      // Handle pending command chip: execute command with appended text
      if (!queued && pendingCommand && !isLoading && selectedProject) {
        const appendedText = currentInput.trim();
        const rawInput = appendedText
          ? `${pendingCommand.name} ${appendedText}`
          : pendingCommand.name;
        displayTextOverrideRef.current = appendedText || pendingCommand.name;
        pendingCommandAppendedTextRef.current = appendedText;
        setPendingCommand(null);
        setInput('');
        inputValueRef.current = '';
        setAttachedImages([]);
        setUploadingImages(new Map());
        setImageErrors(new Map());
        resetCommandMenuState();
        setIsTextareaExpanded(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        executeCommand(pendingCommand, rawInput);
        return;
      }

      if ((!currentInput.trim() && images.length === 0) || isLoading || !selectedProject) {
        requeue();
        return;
      }

      // Intercept slash commands only when "/" is the first input character.
      const commandInput = currentInput.trimEnd();
      if (commandInput.startsWith('/')) {
        const firstSpace = commandInput.indexOf(' ');
        const commandName = firstSpace > 0 ? commandInput.slice(0, firstSpace) : commandInput;
        const matchedCommand = slashCommands.find((cmd: SlashCommand) => cmd.name === commandName);
        if (matchedCommand && matchedCommand.type !== 'skill') {
          executeCommand(matchedCommand, commandInput);
          clearComposer();
          return;
        }
      }

      const messageContent = currentInput;
      const effort = resolveEffort(provider, thinkingMode);
      const effortOption = effort === 'default' ? {} : { effort };

      let uploadedImages: unknown[] = [];
      if (images.length > 0) {
        const formData = new FormData();
        images.forEach((file) => {
          formData.append('images', file);
        });

        try {
          const response = await authenticatedFetch(`/api/projects/${selectedProject.projectId}/upload-images`, {
            method: 'POST',
            headers: {},
            body: formData,
          });

          if (!response.ok) {
            throw new Error('Failed to upload images');
          }

          const result = await response.json();
          uploadedImages = result.images;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Image upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload images: ${message}`,
            timestamp: new Date(),
          });
          requeue();
          return;
        }
      }

      const effectiveSessionId =
        currentSessionId || selectedSession?.id || sessionStorage.getItem('cursorSessionId');
      const clientId = crypto.randomUUID();

      const userMessage: ChatMessage = {
        id: `user:${clientId}`,
        type: 'user',
        content: displayTextOverrideRef.current ?? currentInput,
        images: uploadedImages as any,
        timestamp: new Date(),
      };
      displayTextOverrideRef.current = null;

      addMessage(userMessage);
      setIsLoading(true); // Processing banner starts
      setCanAbortSession(true);
      setClaudeStatus({
        text: 'Processing',
        tokens: 0,
        can_interrupt: true,
      });

      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), 100);

      const savedDraft = currentInput;
      clearComposer();

      const restoreDraft = () => {
        if (queued) {
          requeue();
          return;
        }
        setInput(savedDraft);
        inputValueRef.current = savedDraft;
      };

      if (!effectiveSessionId && !selectedSession?.id) {
        if (typeof window !== 'undefined') {
          // Reset stale pending IDs from previous interrupted runs before creating a new one.
          sessionStorage.removeItem('pendingSessionId');
        }
        // For new sessions we intentionally keep this as `null` until the backend
        // emits `session_created` with the canonical provider session id.
        pendingViewSessionRef.current = { sessionId: null, startedAt: Date.now() };
        // 新 session 尚無 id，先暫存所用模型，待 `session_created` 時綁定
        sessionStorage.setItem('pendingSessionModel', currentModel);
      }
      if (effectiveSessionId) {
        onSessionActive?.(effectiveSessionId);
        onSessionProcessing?.(effectiveSessionId);
      }

      const getToolsSettings = () => {
        try {
          const savedSettings = safeLocalStorage.getItem(PROVIDER_INFO[provider].settingsStorageKey);
          if (savedSettings) {
            return JSON.parse(savedSettings);
          }
        } catch (error) {
          console.error('Error loading tools settings:', error);
        }

        return {
          allowedTools: [],
          disallowedTools: [],
          skipPermissions: false,
        };
      };

      const toolsSettings = getToolsSettings();
      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, currentInput);

      // 單一送出路徑：各家參數差異由 provider 資訊表決定（design D10/D12）。
      // runtime 只讀自己認得的欄位：Cursor 讀 skipPermissions，其餘讀 permissionMode。
      const info = PROVIDER_INFO[provider];
      const sent = sendMessage({
        type: 'chat-command',
        provider,
        command: messageContent,
        sessionId: effectiveSessionId,
        clientId,
        options: {
          cwd: resolvedProjectPath,
          projectPath: resolvedProjectPath,
          sessionId: effectiveSessionId,
          resume: Boolean(effectiveSessionId),
          model: modelByProvider[provider],
          sessionSummary,
          toolsSettings,
          skipPermissions: toolsSettings?.skipPermissions || false,
          permissionMode: info.mapPermissionMode ? info.mapPermissionMode(permissionMode as PermissionMode) : permissionMode,
          ...(info.capabilities.effort ? effortOption : {}),
          ...(info.capabilities.images ? { images: uploadedImages } : {}),
        },
      });

      if (!sent) {
        restoreDraft();
        setIsLoading(false);
        setCanAbortSession(false);
        setClaudeStatus(null);
        if (effectiveSessionId) {
          onSessionNotProcessing?.(effectiveSessionId);
        }
        addMessage({
          type: 'error',
          content: '网络连接已断开，请稍后重试',
          timestamp: new Date(),
        });
        return;
      }

      safeLocalStorage.removeItem(`draft_input_${selectedProject.projectId}`);
      // 綁定該 session 實際使用的模型，供下次打開時還原
      if (effectiveSessionId) {
        saveSessionModel(effectiveSessionId, currentModel);
      }
    },
    [
      selectedSession,
      attachedImages,
      currentModel,
      currentSessionId,
      executeCommand,
      modelByProvider,
      isLoading,
      onSessionActive,
      onSessionProcessing,
      onSessionNotProcessing,
      pendingViewSessionRef,
      permissionMode,
      provider,
      resetCommandMenuState,
      scrollToBottom,
      selectedProject,
      sendMessage,
      setCanAbortSession,
      addMessage,
      setClaudeStatus,
      setIsLoading,
      setIsUserScrolledUp,
      slashCommands,
      thinkingMode,
      pendingCommand,
      queueKey,
    ],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    const savedInput = safeLocalStorage.getItem(`draft_input_${selectedProjectId}`) || '';
    setInput((previous) => {
      const next = previous === savedInput ? previous : savedInput;
      inputValueRef.current = next;
      return next;
    });
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    if (input !== '') {
      safeLocalStorage.setItem(`draft_input_${selectedProjectId}`, input);
    } else {
      safeLocalStorage.removeItem(`draft_input_${selectedProjectId}`);
    }
  }, [input, selectedProjectId]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    // Re-run when input changes so restored drafts get the same autosize behavior as typed text.
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${Math.max(22, textareaRef.current.scrollHeight)}px`;
    const lineHeight = parseInt(window.getComputedStyle(textareaRef.current).lineHeight);
    const expanded = textareaRef.current.scrollHeight > lineHeight * 2;
    setIsTextareaExpanded(expanded);
  }, [input]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        if (event.nativeEvent.isComposing) {
          return;
        }

        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event);
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleSubmit,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      target.style.height = 'auto';
      target.style.height = `${Math.max(22, target.scrollHeight)}px`;
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);

      const lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      setIsTextareaExpanded(target.scrollHeight > lineHeight * 2);
    },
    [setCursorPosition, syncInputOverlayScroll],
  );

  const clearPendingCommand = useCallback(() => {
    setPendingCommand(null);
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, []);

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState]);

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const pendingSessionId =
      typeof window !== 'undefined' ? sessionStorage.getItem('pendingSessionId') : null;
    const cursorSessionId =
      typeof window !== 'undefined' ? sessionStorage.getItem('cursorSessionId') : null;

    const candidateSessionIds = [
      currentSessionId,
      pendingViewSessionRef.current?.sessionId || null,
      pendingSessionId,
      provider === 'cursor' ? cursorSessionId : null,
      selectedSession?.id || null,
    ];

    const targetSessionId =
      candidateSessionIds.find((sessionId) => Boolean(sessionId)) || null;

    if (!targetSessionId) {
      console.warn('Abort requested but no concrete session ID is available yet.');
      return;
    }

    sendMessage({
      type: 'abort-session',
      sessionId: targetSessionId,
      provider,
    });
  }, [canAbortSession, currentSessionId, pendingViewSessionRef, provider, selectedSession?.id, sendMessage]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        const request = pendingPermissionRequests.find((entry) => entry.requestId === requestId);
        if (request?.provider === 'codex') {
          sendMessage({ type: 'codex-permission-response', requestId, sessionId: request.sessionId,
            decision: decision.updatedInput || (decision.allow ? 'accept' : 'decline') });
          return;
        }
        sendMessage({
          type: 'claude-permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) => {
        const next = previous.filter((request) => request.provider === 'codex' || !validIds.includes(request.requestId));
        if (next.length === 0) {
          setClaudeStatus(null);
        }
        return next;
      });
    },
    [sendMessage, setClaudeStatus, setPendingPermissionRequests, pendingPermissionRequests, provider],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
      onInputFocusChange?.(focused);
    },
    [onInputFocusChange],
  );

  /** 立即引導：把佇列項目以 chat-steer 插進正在執行的這一輪；同時只允許一則等待回覆。 */
  const steerQueuedMessage = useCallback(
    (item: QueuedMessage) => {
      if (!canSteer || !steerSessionId || pendingSteerRef.current || item.steering || item.images.length > 0) return;
      pendingSteerRef.current = { itemId: item.id, queueKey, text: item.text, sessionId: steerSessionId, provider };
      queuedMessages.setSteering(queueKey, item.id, true);
      const sent = sendMessage({ type: 'chat-steer', provider, sessionId: steerSessionId, text: item.text, clientId: item.id });
      if (!sent) {
        pendingSteerRef.current = null;
        queuedMessages.setSteering(queueKey, item.id, false);
        addMessage({ type: 'error', content: t('steer.rejected', { reason: 'disconnected' }), timestamp: new Date() });
      }
    },
    [addMessage, canSteer, provider, queueKey, sendMessage, steerSessionId, t],
  );

  /** 不在生成中時手動送出佇列項目（中斷、出錯或在背景結束後）。 */
  const sendQueuedMessage = useCallback(
    (item: QueuedMessage) => {
      if (isLoading || item.steering) return;
      queuedMessages.remove(queueKey, item.id);
      void handleSubmitRef.current?.(createFakeSubmitEvent(), item);
    },
    [isLoading, queueKey],
  );

  const removeQueuedMessage = useCallback(
    (id: string) => queuedMessages.remove(queueKey, id),
    [queueKey],
  );

  /**
   * 後端回覆 steer-accepted / steer-rejected：接受才從佇列移到對話中，拒絕則留在佇列。
   * 這一輪結束時不主動放掉引導狀態：後端對每個 chat-steer 一定回覆，提早放掉會讓自動送出重送同一則。
   */
  const handleSteerResult = useCallback(
    (result: { type: string; clientId?: string | null; reason?: string }) => {
      const pending = pendingSteerRef.current;
      if (!pending || result.clientId !== pending.itemId) return;
      pendingSteerRef.current = null;

      if (result.type !== 'steer-accepted') {
        queuedMessages.setSteering(pending.queueKey, pending.itemId, false);
        if (result.reason === 'not_running') {
          // 以後端狀態校正殘留的 Processing。使用送出時的 session/provider，避免等待期間切換會話後查錯對象。
          sendMessage({ type: 'check-session-status', sessionId: pending.sessionId, provider: pending.provider });
        }
        addMessage({ type: 'error', content: t('steer.rejected', { reason: result.reason ?? 'rejected' }), timestamp: new Date() });
        return;
      }

      queuedMessages.remove(pending.queueKey, pending.itemId);
      // 等待期間切到別的會話時不加到目前畫面；後端已記錄這則訊息，切回去時會從歷史載入
      if (pending.queueKey === queueKey) {
        addMessage({ id: `user:${pending.itemId}`, type: 'user', content: pending.text, timestamp: new Date() });
        setTimeout(() => scrollToBottom(), 100);
      }
    },
    [addMessage, queueKey, scrollToBottom, sendMessage, t],
  );

  /** realtime handler 通知這一輪結束；只有畫面上的會話正常結束才自動送出佇列第一則。 */
  const handleTurnEnded = useCallback((outcome: TurnOutcome, isCurrentSession: boolean) => {
    if (outcome === 'completed' && isCurrentSession) setAutoSendTick((tick) => tick + 1);
  }, []);

  // 等 isLoading 也已更新為 false（同一批狀態更新）後才送，否則 handleSubmit 會把它當成生成中又排回佇列
  const handledAutoSendTickRef = useRef(0);
  useEffect(() => {
    if (autoSendTick === handledAutoSendTickRef.current || isLoading) return;
    handledAutoSendTickRef.current = autoSendTick;
    const next = queuedMessages.takeNext(queueKey);
    if (next) void handleSubmitRef.current?.(createFakeSubmitEvent(), next);
  }, [autoSendTick, isLoading, queueKey]);

  return {
    input,
    setInput,
    canSteer,
    queuedItems,
    steerQueuedMessage,
    sendQueuedMessage,
    removeQueuedMessage,
    handleSteerResult,
    handleTurnEnded,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    thinkingMode,
    setThinkingMode,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    submenuMode,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker: open,
    handleSubmit,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    pendingCommand,
    clearPendingCommand,
    handleModelSwitch,
    currentModel,
    isModelMenuOpen,
    setIsModelMenuOpen,
  };
}
