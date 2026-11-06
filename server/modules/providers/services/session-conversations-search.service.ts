import fsSync from 'node:fs';
import path from 'node:path';

import { spawn } from 'cross-spawn';
import { rgPath } from '@vscode/ripgrep';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { SearchableMessage } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';


type SearchSnippetHighlight = {
  start: number;
  end: number;
};

type SessionConversationMatch = {
  role: string;
  snippet: string;
  highlights: SearchSnippetHighlight[];
  timestamp: string | null;
  provider: LLMProvider;
  messageUuid?: string | null;
};

type SessionConversationResult = {
  sessionId: string;
  provider: LLMProvider;
  sessionSummary: string;
  matches: SessionConversationMatch[];
};

type ProjectConversationResult = {
  projectId: string | null;
  projectName: string;
  projectDisplayName: string;
  sessions: SessionConversationResult[];
};

export type SessionConversationSearchProgressUpdate = {
  projectResult: ProjectConversationResult | null;
  totalMatches: number;
  scannedProjects: number;
  totalProjects: number;
};

type SearchSessionConversationsInput = {
  query: string;
  limit: number;
  signal?: AbortSignal;
  onProgress?: (update: SessionConversationSearchProgressUpdate) => void;
};

type SessionRepositoryRow = ReturnType<typeof sessionsDb.getAllSessions>[number];
type SearchableSessionRow = SessionRepositoryRow & {
  provider: LLMProvider;
  jsonl_path: string;
};

type SearchRuntime = {
  matchesQuery: (text: string) => boolean;
  buildSnippet: (text: string) => { snippet: string; highlights: SearchSnippetHighlight[] };
  limit: number;
  totalMatches: number;
  isAborted: () => boolean;
  extractors: Map<LLMProvider, MessageExtractor>;
  sessionsByFileKey: Map<string, SearchableSessionRow[]>;
  fileResultsCache: Map<string, Map<string, SessionConversationResult>>;
};

type MessageExtractor = (filePath: string) => AsyncIterable<SearchableMessage>;

type SearchablePathEntry = {
  normalizedPath: string;
  absolutePath: string;
};

type ProjectBucket = {
  key: string;
  projectId: string | null;
  projectName: string;
  projectDisplayName: string;
  sessions: SearchableSessionRow[];
};

const MAX_MATCHES_PER_SESSION = 2;
const RIPGREP_FILE_CHUNK_SIZE = 40;
const RIPGREP_CHUNK_CONCURRENCY = 6;
const UNKNOWN_PROJECT_KEY = '__unknown_project__';

function normalizeComparablePath(inputPath: string): string {
  if (!inputPath || typeof inputPath !== 'string') {
    return '';
  }

  const withoutLongPathPrefix = inputPath.startsWith('\\\\?\\')
    ? inputPath.slice(4)
    : inputPath;
  const normalized = path.normalize(withoutLongPathPrefix.trim());
  if (!normalized) {
    return '';
  }

  const resolved = path.resolve(normalized);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function chunkArray<TItem>(items: TItem[], size: number): TItem[][] {
  if (size <= 0) {
    return [items];
  }

  const chunks: TItem[][] = [];
  for (let idx = 0; idx < items.length; idx += size) {
    chunks.push(items.slice(idx, idx + size));
  }
  return chunks;
}

function getSessionKey(session: Pick<SessionRepositoryRow, 'provider' | 'session_id'>): string {
  return `${session.provider}:${session.session_id}`;
}

function makeProjectKey(projectPath: string | null): string {
  const normalized = typeof projectPath === 'string' ? projectPath.trim() : '';
  return normalized.length > 0 ? normalized : UNKNOWN_PROJECT_KEY;
}

function toSummaryText(customName: string | null, fallback: string | null | undefined, emptyLabel: string): string {
  const trimmedCustomName = typeof customName === 'string' ? customName.trim() : '';
  if (trimmedCustomName) {
    return trimmedCustomName;
  }

  const trimmedFallback = typeof fallback === 'string' ? fallback.trim() : '';
  if (!trimmedFallback) {
    return emptyLabel;
  }

  return trimmedFallback.length > 50 ? `${trimmedFallback.slice(0, 50)}...` : trimmedFallback;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createWordMatcher(
  rawQuery: string,
  words: string[],
): Pick<SearchRuntime, 'matchesQuery' | 'buildSnippet'> {
  const normalizedQuery = rawQuery.trim().replace(/\s+/g, ' ');
  const requireExactPhrase = words.length > 1 && normalizedQuery.length > 0;
  const wordPatterns = words.map((word) => new RegExp(`(?<!\\p{L})${escapeRegex(word)}(?!\\p{L})`, 'u'));
  const phrasePattern = words.map((word) => escapeRegex(word)).join('\\s+');
  const phraseRegex = new RegExp(phrasePattern, 'iu');

  const allWordsMatch = (textLower: string): boolean =>
    wordPatterns.every((pattern) => pattern.test(textLower));

  const matchesQuery = (text: string): boolean => {
    if (typeof text !== 'string' || text.length === 0) {
      return false;
    }

    if (requireExactPhrase) {
      return phraseRegex.test(text);
    }

    if (phraseRegex.test(text)) {
      return true;
    }

    if (words.length === 1) {
      return allWordsMatch(text.toLowerCase());
    }

    return allWordsMatch(text.toLowerCase());
  };

  const buildSnippet = (
    text: string,
    snippetLen = 150,
  ): { snippet: string; highlights: SearchSnippetHighlight[] } => {
    const textLower = text.toLowerCase();
    let firstIndex = -1;
    let firstWordLen = 0;
    let phraseStart = -1;
    let phraseLength = 0;

    const phraseMatch = phraseRegex.exec(text);
    if (phraseMatch) {
      phraseStart = phraseMatch.index;
      phraseLength = phraseMatch[0].length;
      firstIndex = phraseStart;
      firstWordLen = phraseLength;
    }

    if (firstIndex === -1) {
      for (const word of words) {
        const regex = new RegExp(`(?<!\\p{L})${escapeRegex(word)}(?!\\p{L})`, 'u');
        const match = regex.exec(textLower);
        if (match && (firstIndex === -1 || match.index < firstIndex)) {
          firstIndex = match.index;
          firstWordLen = word.length;
        }
      }
    }

    if (firstIndex === -1) {
      firstIndex = 0;
    }

    const halfLen = Math.floor(snippetLen / 2);
    const start = Math.max(0, firstIndex - halfLen);
    const end = Math.min(text.length, firstIndex + halfLen + firstWordLen);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < text.length ? '...' : '';
    const snippetBody = text.slice(start, end).replace(/\n/g, ' ');
    const snippet = `${prefix}${snippetBody}${suffix}`;

    const snippetLower = snippet.toLowerCase();
    const highlights: SearchSnippetHighlight[] = [];

    if (phraseStart >= start && phraseStart + phraseLength <= end) {
      const phraseOffset = prefix.length + (phraseStart - start);
      highlights.push({
        start: phraseOffset,
        end: phraseOffset + phraseLength,
      });
    }

    if (!requireExactPhrase) {
      for (const word of words) {
        const regex = new RegExp(`(?<!\\p{L})${escapeRegex(word)}(?!\\p{L})`, 'gu');
        let match = regex.exec(snippetLower);
        while (match) {
          highlights.push({ start: match.index, end: match.index + word.length });
          match = regex.exec(snippetLower);
        }
      }
    }

    highlights.sort((left, right) => left.start - right.start);
    const merged: SearchSnippetHighlight[] = [];
    for (const highlight of highlights) {
      const previous = merged[merged.length - 1];
      if (previous && highlight.start <= previous.end) {
        previous.end = Math.max(previous.end, highlight.end);
      } else {
        merged.push({ ...highlight });
      }
    }

    return { snippet, highlights: merged };
  };

  return { matchesQuery, buildSnippet };
}

/**
 * 搜尋範圍由「有實作 extractSearchableMessages 的 provider」決定（design D5）。
 */
function collectExtractors(): {
  extractors: Map<LLMProvider, MessageExtractor>;
  pathResolvers: Map<LLMProvider, (filePath: string) => string>;
  unsearchableProviders: LLMProvider[];
} {
  const extractors = new Map<LLMProvider, MessageExtractor>();
  const pathResolvers = new Map<LLMProvider, (filePath: string) => string>();
  const unsearchableProviders: LLMProvider[] = [];
  for (const provider of providerRegistry.listProviders()) {
    const { sessions } = provider;
    if (sessions.extractSearchableMessages) {
      extractors.set(provider.id, (filePath) => sessions.extractSearchableMessages!(filePath));
      if (sessions.resolveSearchablePath) {
        pathResolvers.set(provider.id, (filePath) => sessions.resolveSearchablePath!(filePath));
      }
    } else {
      unsearchableProviders.push(provider.id);
    }
  }
  return { extractors, pathResolvers, unsearchableProviders };
}

function normalizeSearchableSessions(
  rows: SessionRepositoryRow[],
  extractors: Map<LLMProvider, MessageExtractor>,
  pathResolvers: Map<LLMProvider, (filePath: string) => string> = new Map(),
): SearchableSessionRow[] {
  const normalizedRows: SearchableSessionRow[] = [];
  const projectArchiveStateByPath = new Map<string, boolean>();

  for (const row of rows) {
    const provider = row.provider as LLMProvider;
    if (!extractors.has(provider)) {
      continue;
    }

    const rawJsonlPath = typeof row.jsonl_path === 'string' ? row.jsonl_path.trim() : '';
    if (!rawJsonlPath) {
      continue;
    }

    const absoluteJsonlPath = path.resolve(rawJsonlPath);
    if (!fsSync.existsSync(absoluteJsonlPath)) {
      continue;
    }

    /**
     * Active session rows can still belong to an archived project because
     * project archiving intentionally preserves the underlying session data.
     * Global conversation search should follow the visible workspace model,
     * which means excluding any session whose owning project is archived.
     *
     * Cache the archive lookup per normalized project path so one search pass
     * does not re-query the same project row for every session in that folder.
     */
    const normalizedProjectPath = typeof row.project_path === 'string' ? row.project_path.trim() : '';
    if (normalizedProjectPath) {
      if (!projectArchiveStateByPath.has(normalizedProjectPath)) {
        const projectRow = projectsDb.getProjectPath(normalizedProjectPath);
        projectArchiveStateByPath.set(normalizedProjectPath, Boolean(projectRow?.isArchived));
      }

      if (projectArchiveStateByPath.get(normalizedProjectPath) === true) {
        continue;
      }
    }

    // 預過濾與提取都讀 provider 指定的檔案，否則只在完整版出現的內容會在預過濾被篩掉
    const resolvePath = pathResolvers.get(provider);
    normalizedRows.push({
      ...row,
      provider,
      jsonl_path: resolvePath ? resolvePath(absoluteJsonlPath) : absoluteJsonlPath,
    });
  }

  return normalizedRows;
}

function buildProjectBuckets(searchableSessions: SearchableSessionRow[]): ProjectBucket[] {
  const projectBuckets = new Map<string, ProjectBucket>();
  const projectMetadataCache = new Map<string, { projectId: string | null; projectDisplayName: string }>();

  for (const session of searchableSessions) {
    const key = makeProjectKey(session.project_path);
    if (!projectBuckets.has(key)) {
      if (!projectMetadataCache.has(key)) {
        if (key === UNKNOWN_PROJECT_KEY) {
          projectMetadataCache.set(key, {
            projectId: null,
            projectDisplayName: 'Unknown Project',
          });
        } else {
          const projectRow = projectsDb.getProjectPath(key);
          const customProjectName = typeof projectRow?.custom_project_name === 'string'
            ? projectRow.custom_project_name.trim()
            : '';
          const displayName = customProjectName || path.basename(key) || key;

          projectMetadataCache.set(key, {
            projectId: projectRow?.project_id ?? null,
            projectDisplayName: displayName,
          });
        }
      }

      const metadata = projectMetadataCache.get(key) as { projectId: string | null; projectDisplayName: string };
      projectBuckets.set(key, {
        key,
        projectId: metadata.projectId,
        projectName: key,
        projectDisplayName: metadata.projectDisplayName,
        sessions: [],
      });
    }

    const bucket = projectBuckets.get(key) as ProjectBucket;
    bucket.sessions.push(session);
  }

  const buckets = Array.from(projectBuckets.values());
  for (const bucket of buckets) {
    bucket.sessions.sort((left, right) => {
      const leftTs = new Date(left.updated_at || left.created_at || 0).getTime();
      const rightTs = new Date(right.updated_at || right.created_at || 0).getTime();
      return rightTs - leftTs;
    });
  }

  return buckets;
}

/**
 * Executes ripgrep with the file list explicitly provided from sessionsDb jsonl paths.
 *
 * This avoids recursive directory walks and uses a fixed known candidate list.
 */
async function runRipgrepFilesWithMatches(
  pattern: string,
  filePaths: string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  if (!pattern || filePaths.length === 0 || signal?.aborted) {
    return new Set();
  }

  return new Promise((resolve, reject) => {
    const args = [
      '--files-with-matches',
      '--no-messages',
      '--ignore-case',
      '--fixed-strings',
      '--',
      pattern,
      ...filePaths,
    ];
    const rg = spawn(rgPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let aborted = false;

    const abortListener = () => {
      aborted = true;
      rg.kill();
    };

    if (signal) {
      signal.addEventListener('abort', abortListener, { once: true });
    }

    rg.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    rg.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    rg.on('error', (error) => {
      if (signal) {
        signal.removeEventListener('abort', abortListener);
      }

      if (aborted || signal?.aborted) {
        resolve(new Set());
        return;
      }

      reject(error);
    });

    rg.on('close', (code) => {
      if (signal) {
        signal.removeEventListener('abort', abortListener);
      }

      if (aborted || signal?.aborted) {
        resolve(new Set());
        return;
      }

      if (code !== 0 && code !== 1) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(`ripgrep failed with code ${String(code)}: ${stderr}`));
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const matchedPaths = new Set<string>();

      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        matchedPaths.add(normalizeComparablePath(trimmed));
      }

      resolve(matchedPaths);
    });
  });
}

async function findMatchedFileKeys(
  searchablePathEntries: SearchablePathEntry[],
  rawQuery: string,
  words: string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  if (searchablePathEntries.length === 0 || words.length === 0 || signal?.aborted) {
    return new Set();
  }

  const normalizedQuery = rawQuery.trim().replace(/\s+/g, ' ');
  const requireExactPhrase = words.length > 1 && normalizedQuery.length > 0;

  if (requireExactPhrase) {
    let matchedForPhrase = searchablePathEntries.slice();

    // Keep ripgrep as an over-approximation for exact phrase mode by requiring
    // each word to appear somewhere in the file, then defer strict phrase
    // validation to the in-memory matcher.
    for (const word of words) {
      if (signal?.aborted) {
        return new Set();
      }

      const matchedForWord = new Set<string>();
      const fileChunks = chunkArray(
        matchedForPhrase.map((entry) => entry.absolutePath),
        RIPGREP_FILE_CHUNK_SIZE,
      );

      let nextChunkIndex = 0;
      const workerCount = Math.min(RIPGREP_CHUNK_CONCURRENCY, fileChunks.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (nextChunkIndex < fileChunks.length && !signal?.aborted) {
          const currentIndex = nextChunkIndex;
          nextChunkIndex += 1;
          const chunkMatches = await runRipgrepFilesWithMatches(word, fileChunks[currentIndex], signal);
          for (const matchedPath of chunkMatches) {
            matchedForWord.add(matchedPath);
          }
        }
      });

      await Promise.all(workers);
      if (signal?.aborted) {
        return new Set();
      }

      matchedForPhrase = matchedForPhrase.filter((entry) => matchedForWord.has(entry.normalizedPath));
      if (matchedForPhrase.length === 0) {
        break;
      }
    }

    return new Set(matchedForPhrase.map((entry) => entry.normalizedPath));
  }

  let remainingEntries = searchablePathEntries.slice();

  // Run one ripgrep pass per term and intersect by keeping only files that
  // matched every query word.
  for (const word of words) {
    if (signal?.aborted) {
      return new Set();
    }

    const matchedForWord = new Set<string>();
    const fileChunks = chunkArray(
      remainingEntries.map((entry) => entry.absolutePath),
      RIPGREP_FILE_CHUNK_SIZE,
    );

    let nextChunkIndex = 0;
    const workerCount = Math.min(RIPGREP_CHUNK_CONCURRENCY, fileChunks.length);

    const workers = Array.from({ length: workerCount }, async () => {
      while (nextChunkIndex < fileChunks.length && !signal?.aborted) {
        const currentIndex = nextChunkIndex;
        nextChunkIndex += 1;
        const chunkMatches = await runRipgrepFilesWithMatches(word, fileChunks[currentIndex], signal);
        for (const matchedPath of chunkMatches) {
          matchedForWord.add(matchedPath);
        }
      }
    });

    await Promise.all(workers);
    if (signal?.aborted) {
      return new Set();
    }

    remainingEntries = remainingEntries.filter((entry) => matchedForWord.has(entry.normalizedPath));
    if (remainingEntries.length === 0) {
      break;
    }
  }

  return new Set(remainingEntries.map((entry) => entry.normalizedPath));
}

function addSessionMatch(
  runtime: SearchRuntime,
  matches: SessionConversationMatch[],
  match: SessionConversationMatch,
): void {
  if (runtime.totalMatches >= runtime.limit || matches.length >= MAX_MATCHES_PER_SESSION) {
    return;
  }

  matches.push(match);
  runtime.totalMatches += 1;
}

type SessionSearchState = {
  matches: SessionConversationMatch[];
  summary: string | null;
  lastUserText: string | null;
  lastAssistantText: string | null;
};

/**
 * 解析一個會話檔案，回傳檔內每個會話的命中結果。一個檔案可能含多個會話（Claude resume），
 * 所以以檔案為單位快取，同檔的其他會話直接取用。
 */
async function parseFileMatches(
  session: SearchableSessionRow,
  runtime: SearchRuntime,
): Promise<Map<string, SessionConversationResult>> {
  const extract = runtime.extractors.get(session.provider);
  const fileKey = normalizeComparablePath(session.jsonl_path);
  const sessionsInFile = (runtime.sessionsByFileKey.get(fileKey) ?? [session])
    .filter((candidate) => candidate.provider === session.provider);
  const customNameBySessionId = new Map(sessionsInFile.map((candidate) => [candidate.session_id, candidate.custom_name ?? null]));
  const stateBySessionId = new Map<string, SessionSearchState>();

  if (!extract) {
    return new Map();
  }

  try {
    for await (const message of extract(session.jsonl_path)) {
      if (runtime.totalMatches >= runtime.limit || runtime.isAborted()) {
        break;
      }

      const sessionId = message.sessionId ?? session.session_id;
      if (!customNameBySessionId.has(sessionId)) {
        continue;
      }

      let state = stateBySessionId.get(sessionId);
      if (!state) {
        state = { matches: [], summary: null, lastUserText: null, lastAssistantText: null };
        stateBySessionId.set(sessionId, state);
      }

      if (message.role === 'summary') {
        state.summary = message.text;
        continue;
      }

      if (message.role === 'user') {
        state.lastUserText = message.text;
      } else {
        state.lastAssistantText = message.text;
      }

      if (!runtime.matchesQuery(message.text)) {
        continue;
      }

      const { snippet, highlights } = runtime.buildSnippet(message.text);
      addSessionMatch(runtime, state.matches, {
        role: message.role,
        snippet,
        highlights,
        timestamp: message.timestamp ?? null,
        provider: session.provider,
        messageUuid: message.messageUuid,
      });
    }
  } catch {
    return new Map();
  }

  const results = new Map<string, SessionConversationResult>();
  for (const [sessionId, state] of stateBySessionId) {
    if (state.matches.length === 0) {
      continue;
    }

    results.set(sessionId, {
      sessionId,
      provider: session.provider,
      sessionSummary: toSummaryText(
        customNameBySessionId.get(sessionId) ?? null,
        state.summary || state.lastUserText || state.lastAssistantText,
        'New Session',
      ),
      matches: state.matches,
    });
  }
  return results;
}

async function parseSessionMatches(
  session: SearchableSessionRow,
  runtime: SearchRuntime,
): Promise<SessionConversationResult | null> {
  const fileKey = normalizeComparablePath(session.jsonl_path);
  if (!runtime.fileResultsCache.has(fileKey)) {
    runtime.fileResultsCache.set(fileKey, await parseFileMatches(session, runtime));
  }
  return runtime.fileResultsCache.get(fileKey)?.get(session.session_id) ?? null;
}

type SearchConversationsResult = {
  results: ProjectConversationResult[];
  totalMatches: number;
  query: string;
  /** 已註冊但沒有實作提取方法的 provider，它們的會話不在搜尋範圍內。 */
  unsearchableProviders: LLMProvider[];
};

export async function searchConversations(
  query: string,
  limit = 50,
  onProjectResult: ((update: SessionConversationSearchProgressUpdate) => void) | null = null,
  signal: AbortSignal | null = null,
): Promise<SearchConversationsResult> {
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 50, 200));
  const words = safeQuery.toLowerCase().split(/\s+/).filter((word) => word.length > 0);

  const { extractors, pathResolvers, unsearchableProviders } = collectExtractors();
  const empty: SearchConversationsResult = { results: [], totalMatches: 0, query: safeQuery, unsearchableProviders };

  if (words.length === 0) {
    return empty;
  }

  const isAborted = () => signal?.aborted === true;
  if (isAborted()) {
    return empty;
  }

  const searchableSessions = normalizeSearchableSessions(sessionsDb.getAllSessions(), extractors, pathResolvers);
  if (searchableSessions.length === 0) {
    return empty;
  }

  const sessionsByPathKey = new Map<string, SearchableSessionRow[]>();
  const searchablePathEntries: SearchablePathEntry[] = [];

  for (const session of searchableSessions) {
    const normalizedPath = normalizeComparablePath(session.jsonl_path);
    if (!normalizedPath) {
      continue;
    }

    if (!sessionsByPathKey.has(normalizedPath)) {
      sessionsByPathKey.set(normalizedPath, []);
      searchablePathEntries.push({
        normalizedPath,
        absolutePath: session.jsonl_path,
      });
    }

    const pathSessions = sessionsByPathKey.get(normalizedPath) as SearchableSessionRow[];
    pathSessions.push(session);
  }

  const matchedFileKeys = await findMatchedFileKeys(
    searchablePathEntries,
    safeQuery,
    words,
    signal ?? undefined,
  );
  if (isAborted() || matchedFileKeys.size === 0) {
    return empty;
  }

  const matchedSessionKeys = new Set<string>();
  for (const fileKey of matchedFileKeys) {
    const sessions = sessionsByPathKey.get(fileKey);
    if (!sessions) {
      continue;
    }

    for (const session of sessions) {
      matchedSessionKeys.add(getSessionKey(session));
    }
  }

  const projectBuckets = buildProjectBuckets(searchableSessions);
  const totalProjects = projectBuckets.length;
  const results: ProjectConversationResult[] = [];
  let scannedProjects = 0;

  const runtime: SearchRuntime = {
    ...createWordMatcher(safeQuery, words),
    limit: safeLimit,
    totalMatches: 0,
    isAborted,
    extractors,
    sessionsByFileKey: sessionsByPathKey,
    fileResultsCache: new Map<string, Map<string, SessionConversationResult>>(),
  };

  for (const bucket of projectBuckets) {
    if (runtime.totalMatches >= runtime.limit || runtime.isAborted()) {
      break;
    }

    const projectResult: ProjectConversationResult = {
      projectId: bucket.projectId,
      projectName: bucket.projectName,
      projectDisplayName: bucket.projectDisplayName,
      sessions: [],
    };

    for (const session of bucket.sessions) {
      if (runtime.totalMatches >= runtime.limit || runtime.isAborted()) {
        break;
      }
      if (!matchedSessionKeys.has(getSessionKey(session))) {
        continue;
      }

      const sessionResult = await parseSessionMatches(session, runtime);
      if (sessionResult) {
        projectResult.sessions.push(sessionResult);
      }
    }

    scannedProjects += 1;
    if (projectResult.sessions.length > 0) {
      results.push(projectResult);
      onProjectResult?.({
        projectResult,
        totalMatches: runtime.totalMatches,
        scannedProjects,
        totalProjects,
      });
    } else if (onProjectResult && scannedProjects % 10 === 0) {
      onProjectResult({
        projectResult: null,
        totalMatches: runtime.totalMatches,
        scannedProjects,
        totalProjects,
      });
    }
  }

  return {
    results,
    totalMatches: runtime.totalMatches,
    query: safeQuery,
    unsearchableProviders,
  };
}

/**
 * Application service for session-conversation search.
 *
 * Provider routes call this service so route handlers stay focused on
 * request parsing/response formatting, while search execution remains
 * centralized in one place.
 */
export const sessionConversationsSearchService = {
  /**
   * Streams progress updates while the search scans provider session logs.
   */
  async search(input: SearchSessionConversationsInput): Promise<{ unsearchableProviders: LLMProvider[] }> {
    return searchConversations(
      input.query,
      input.limit,
      input.onProgress ?? null,
      input.signal ?? null,
    );
  },
};
