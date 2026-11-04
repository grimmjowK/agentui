import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  McpScope,
  NormalizedMessage,
  ProviderSkill,
  ProviderSkillListOptions,
  ProviderAuthStatus,
  ProviderMcpServer,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';

//----------------- PROVIDER CONTRACT INTERFACES ------------
/**
 * Main provider contract for CLI and SDK integrations.
 *
 * Each concrete provider owns its MCP/auth handlers plus the provider-specific
 * logic for converting native events/history into the app's normalized shape.
 */
export interface IProvider {
  readonly id: LLMProvider;
  readonly mcp: IProviderMcp;
  readonly auth: IProviderAuth;
  readonly skills: IProviderSkills;
  readonly sessions: IProviderSessions;
  readonly sessionSynchronizer: IProviderSessionSynchronizer;
  readonly runtime: IProviderRuntime;
}

// ---------------------------
//----------------- PROVIDER RUNTIME INTERFACE ------------
/**
 * Transport accepted by provider runtimes: WebSocket writers (chat panel) and
 * SSE writers (external agent API) share this structural shape.
 */
export type ProviderRuntimeWriter = {
  send(data: unknown): void;
  userId?: string | number | null;
  /** Raw socket, present on WebSocket writers only. */
  ws?: unknown;
  setSessionId?(sessionId: string): void;
};

/** One pending tool-approval request awaiting a user decision. */
export type PendingApprovalItem = {
  requestId: string;
  toolName: string;
  input?: unknown;
  context?: unknown;
  sessionId: string;
  receivedAt: Date | string;
};

/**
 * Execution contract for one provider (design D11).
 *
 * Adapters wrap the existing root-level runtime functions without changing
 * their internal behavior; provider-specific quirks are absorbed here.
 */
export interface IProviderRuntime {
  /** Starts (or resumes, via `options.sessionId` / `options.resume`) one chat run. */
  start(command: string, options: Record<string, unknown>, writer: ProviderRuntimeWriter): Promise<void>;
  /**
   * Interrupts a run. `emitsTerminal` tells the dispatcher whether the runtime
   * itself sends the terminal `complete` event, so every abort yields exactly one.
   */
  abort(sessionId: string, writer: ProviderRuntimeWriter): Promise<{ ok: boolean; emitsTerminal: boolean }>;
  isActive(sessionId: string): boolean;
  /** Re-attaches a running session to a new writer; returns whether it is still running. */
  reconnect(sessionId: string, writer: ProviderRuntimeWriter): boolean;
  listActive(): unknown;
  /**
   * 執行中追加指令，不中斷這一輪（design D9）。前置條件不成立或 provider 拒絕時回傳
   * `{ ok: false, reason }`，這一輪照常執行。
   */
  steer?(sessionId: string, userId: string | number | null, text: string): Promise<{ ok: boolean; reason?: string }>;
  getPendingApprovals?(userId: string | number | null, sessionId?: string): PendingApprovalItem[];
}

// ---------------------------
//----------------- PROVIDER AUTH INTERFACE ------------
/**
 * Auth contract for one provider.
 *
 * Implementations should return a complete installation/authentication status
 * without throwing for normal "not installed" or "not authenticated" states.
 */
export interface IProviderAuth {
  /**
   * Checks whether the provider is installed and has usable credentials.
   */
  getStatus(): Promise<ProviderAuthStatus>;
}

// ---------------------------
//----------------- PROVIDER SKILLS INTERFACE ------------
/**
 * Skills contract for one provider.
 *
 * Implementations discover provider-native skill markdown locations and return
 * normalized skill records with the exact command syntax expected by that
 * provider. Each skill is read from a `SKILL.md` file under its skill directory.
 */
export interface IProviderSkills {
  /**
   * Lists all skills visible to this provider for the optional workspace.
   */
  listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]>;
}

// ---------------------------
//----------------- PROVIDER MCP INTERFACE ------------
/**
 * MCP contract for one provider.
 *
 * Implementations must map provider-native MCP config formats to shared
 * `ProviderMcpServer` records used by routes and frontend state.
 */
export interface IProviderMcp {
  listServers(options?: { workspacePath?: string }): Promise<Record<McpScope, ProviderMcpServer[]>>;
  listServersForScope(scope: McpScope, options?: { workspacePath?: string }): Promise<ProviderMcpServer[]>;
  upsertServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer>;
  removeServer(
    input: { name: string; scope?: McpScope; workspacePath?: string },
  ): Promise<{ removed: boolean; provider: LLMProvider; name: string; scope: McpScope }>;
}

// ---------------------------
//----------------- PROVIDER SESSION INTERFACE ------------
/**
 * Session/history contract for one provider.
 *
 * Implementations normalize provider-specific events and message history into
 * shared transport shapes consumed by API routes and realtime streams.
 */
export interface IProviderSessions {
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[];
  fetchHistory(sessionId: string, options?: FetchHistoryOptions): Promise<FetchHistoryResult>;
  /**
   * 從會話檔案提取可搜尋的訊息（design D5）。未實作的 provider 不在全文檢索範圍內，
   * 搜尋回應會以 `unsearchableProviders` 告知。
   */
  extractSearchableMessages?(filePath: string): AsyncIterable<SearchableMessage>;
  /** 會話產物（design D15）。sessionId 由呼叫端先驗證格式；實作仍須確認不越出產物根目錄。 */
  listArtifacts?(sessionId: string): Promise<SessionArtifact[]>;
}

/** 會話目錄中由 agent 寫出的 Markdown 產物。 */
export type SessionArtifact = {
  id: string;
  title: string;
  fileName: string;
  updatedAt: string;
  content: string;
};

/** 全文檢索用的一則訊息。 */
export type SearchableMessage = {
  /** 多個會話共用一個檔案時（Claude）標明所屬會話；省略則屬於該檔案對應的會話。 */
  sessionId?: string;
  /** `summary` 只用來產生結果的會話摘要（最後一則為準），不參與比對。 */
  role: 'user' | 'assistant' | 'summary';
  text: string;
  timestamp?: string | null;
  messageUuid?: string | null;
};

// ---------------------------
//----------------- PROVIDER SESSION SYNCHRONIZER INTERFACE ------------
/**
 * Session indexing contract for one provider.
 *
 * Implementations scan provider-specific session artifacts on disk and upsert
 * normalized session metadata into the database. The service layer uses this
 * interface for both full rescans and single-file incremental sync triggered
 * by filesystem watcher events.
 */
export interface IProviderSessionSynchronizer {
  /**
   * Scans provider session artifacts and upserts discovered sessions into DB.
   */
  synchronize(since?: Date): Promise<number>;

  /**
   * Parses and upserts one provider artifact file without running a full scan.
   */
  synchronizeFile(filePath: string): Promise<string | null>;
}
