import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import PermissionContext from '../../../contexts/PermissionContext';
import { QuickSettingsPanel } from '../../quick-settings-panel';
import type { ChatInterfaceProps, Provider  } from '../types/types';
import type { LLMProvider } from '../../../types/app';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { useSessionStore } from '../../../stores/useSessionStore';

import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatComposer from './subcomponents/ChatComposer';


type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

function ChatInterface({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  latestMessage,
  onFileOpen,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  processingSessions,
  onNavigateToSession,
  onShowSettings,
  autoExpandTools,
  showRawParameters,
  showThinking,
  autoScrollToBottom,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
  onRunInShell,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { t } = useTranslation('chat');

  const sessionStore = useSessionStore();
  const pendingViewSessionRef = useRef<PendingViewSession | null>(null);

  const {
    provider,
    setProvider,
    modelByProvider,
    setModelFor,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
  } = useChatProviderState({
    selectedSession,
  });

  const {
    chatMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    isLoading,
    setIsLoading,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    canAbortSession,
    setCanAbortSession,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    claudeStatus,
    setClaudeStatus,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
  } = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    autoScrollToBottom,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    pendingViewSessionRef,
    sessionStore,
  });

  const {
    input,
    setInput,
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
    filteredFiles,
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
    openImagePicker,
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
    canSteer,
    isSteerPending,
    handleSteerResult,
    handleModelSwitch,
    currentModel,
    isModelMenuOpen,
    setIsModelMenuOpen,
  } = useChatComposerState({
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
    pendingPermissionRequests,
    setPendingPermissionRequests,
    onRunInShell,
  });

  // On WebSocket reconnect, re-fetch the current session's messages from the server
  // so missed streaming events are shown. Also re-check session status to fix stuck loading.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    const providerVal = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const sessionProvider = selectedSession.__provider || providerVal;
    if (sessionProvider === 'antigravity') {
      sendMessage({ type: 'check-session-status', sessionId: selectedSession.id, provider: sessionProvider });
    }
    await sessionStore.refreshFromServer(selectedSession.id, {
      provider: sessionProvider as LLMProvider,
      // Use DB projectId; legacy folder-derived projectName is no longer accepted here.
      projectId: selectedProject.projectId,
      projectPath: selectedProject.fullPath || selectedProject.path || '',
    });
    if (sessionProvider !== 'antigravity') {
      setIsLoading(false);
      setCanAbortSession(false);
      onSessionNotProcessing?.(selectedSession.id);
      sendMessage({ type: 'check-session-status', sessionId: selectedSession.id, provider: sessionProvider });
    }
  }, [selectedProject, selectedSession, sessionStore, setIsLoading, setCanAbortSession, onSessionNotProcessing, sendMessage]);

  useChatRealtimeHandlers({
    latestMessage,
    provider,
    selectedSession,
    currentSessionId,
    setCurrentSessionId,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setTokenBudget,
    pendingViewSessionRef,
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    onNavigateToSession,
    onWebSocketReconnect: handleWebSocketReconnect,
    onSteerResult: handleSteerResult,
    sessionStore,
  });

  useEffect(() => {
    if (!isLoading || !canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession, isLoading]);

  // Safety net: if isLoading stays true for too long without any WebSocket
  // activity, re-check session status. This catches missed `complete` events.
  useEffect(() => {
    if (!isLoading || !selectedSession || !selectedProject) return;
    const timer = setTimeout(() => {
      const providerVal = (selectedSession.__provider || localStorage.getItem('selected-provider')) || 'claude';
      sendMessage({ type: 'check-session-status', sessionId: selectedSession.id, provider: providerVal });
    }, 30_000);
    return () => clearTimeout(timer);
  }, [isLoading, latestMessage, selectedSession, selectedProject, sendMessage]);

  // 全域池含所有會話的項目，這裡只渲染目前會話的（尚未取得 id 的新會話請求也算目前會話）
  const viewSessionId = selectedSession?.id || currentSessionId || null;
  const sessionPermissionRequests = useMemo(
    () => pendingPermissionRequests.filter((request) => (
      request.sessionId ? request.sessionId === viewSessionId : !selectedSession?.id
    )),
    [pendingPermissionRequests, selectedSession?.id, viewSessionId],
  );

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests: sessionPermissionRequests,
    handlePermissionDecision,
  }), [sessionPermissionRequests, handlePermissionDecision]);

  if (!selectedProject) {
    const selectedProviderLabel = t(`messageTypes.${provider}`, { defaultValue: provider });

    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full flex-col">
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={(nextProvider) => setProvider(nextProvider as Provider)}
          textareaRef={textareaRef}
          modelByProvider={modelByProvider}
          setModelFor={setModelFor}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          sessionMessagesCount={chatMessages.length}
          visibleMessageCount={visibleMessageCount}
          visibleMessages={visibleMessages}
          loadEarlierMessages={loadEarlierMessages}
          loadAllMessages={loadAllMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          showLoadAllOverlay={showLoadAllOverlay}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          autoExpandTools={autoExpandTools}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
        />

        <ChatComposer
          pendingPermissionRequests={sessionPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          claudeStatus={claudeStatus}
          isLoading={isLoading}
          canSteer={canSteer}
          isSteerPending={isSteerPending}
          onAbortSession={handleAbortSession}
          provider={provider}
          permissionMode={permissionMode}
          onModeSwitch={cyclePermissionMode}
          thinkingMode={thinkingMode}
          setThinkingMode={setThinkingMode}
          model={currentModel}
          onModelChange={handleModelSwitch}
          isModelMenuOpen={isModelMenuOpen}
          onModelMenuOpenChange={setIsModelMenuOpen}
          tokenBudget={tokenBudget}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          isUserScrolledUp={isUserScrolledUp}
          hasMessages={chatMessages.length > 0}
          onScrollToBottom={scrollToBottomAndReset}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          attachedImages={attachedImages}
          onRemoveImage={(index) =>
            setAttachedImages((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          uploadingImages={uploadingImages}
          imageErrors={imageErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          submenuMode={submenuMode}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openImagePicker={openImagePicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', {
            provider: t(`messageTypes.${provider}`, { defaultValue: provider }),
          })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
          pendingCommand={pendingCommand}
          onClearPendingCommand={clearPendingCommand}
        />
      </div>

      <QuickSettingsPanel />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
