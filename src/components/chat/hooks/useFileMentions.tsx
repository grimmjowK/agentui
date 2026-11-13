import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';
import { api } from '../../../utils/api';
import { escapeRegExp } from '../utils/chatFormatting';
import { filterMentionCandidates } from '../utils/mentionCandidates';
import type { Project } from '../../../types/app';
import { getAllSessions } from '../../sidebar/utils/utils';

interface ProjectFileNode {
  name: string;
  type: 'file' | 'directory';
  path?: string;
  children?: ProjectFileNode[];
}

export interface MentionableFile {
  name: string;
  path: string;
  relativePath?: string;
  /** 下拉第二行的说明；session 候选用来显示 provider，缺省显示 path */
  detail?: string;
}

interface UseFileMentionsOptions {
  selectedProject: Project | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
}

const flattenFileTree = (files: ProjectFileNode[], basePath = ''): MentionableFile[] => {
  let flattened: MentionableFile[] = [];

  files.forEach((file) => {
    const fullPath = basePath ? `${basePath}/${file.name}` : file.name;
    if (file.type === 'directory' && file.children) {
      flattened = flattened.concat(flattenFileTree(file.children, fullPath));
      return;
    }

    // .tmp/ 是服务端给 agent 放临时附件的目录（附图、@session transcript），不作为候选
    if (file.type === 'file' && !fullPath.startsWith('.tmp/')) {
      flattened.push({
        name: file.name,
        path: fullPath,
        relativePath: file.path,
      });
    }
  });

  return flattened;
};

const SESSION_FETCH_LIMIT = 200;

export function useFileMentions({ selectedProject, input, setInput, textareaRef }: UseFileMentionsOptions) {
  const [fileList, setFileList] = useState<MentionableFile[]>([]);
  const [fileMentions, setFileMentions] = useState<string[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<MentionableFile[]>([]);
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState(-1);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [atSymbolPosition, setAtSymbolPosition] = useState(-1);

  useEffect(() => {
    const abortController = new AbortController();

    const fetchProjectFiles = async () => {
      // File list is keyed by DB projectId now; the backend resolves it to
      // the project's path before reading.
      const projectId = selectedProject?.projectId;
      setFileList([]);
      setFilteredFiles([]);
      if (!projectId) {
        return;
      }


      try {
        const response = await api.getFiles(projectId, { signal: abortController.signal });
        if (!response.ok) {
          return;
        }

        const files = (await response.json()) as ProjectFileNode[];
        setFileList(flattenFileTree(files));
      } catch (error) {
        // Ignore aborts from rapid project switches; we only care about the latest request.
        if ((error as { name?: string })?.name === 'AbortError') {
          return;
        }
        console.error('Error fetching files:', error);
      }
    };

    fetchProjectFiles();
    return () => {
      abortController.abort();
    };
  }, [selectedProject?.projectId]);

  // 当前项目下所有 provider 的会话，选中后插入 `@session:<id>`，由服务端展开为 transcript 引用。
  // 侧边栏只载入了前 20 笔，所以每次打开下拉都向后端拉一次（未拉到前先用侧边栏已有的）。
  const [fetchedSessions, setFetchedSessions] = useState<Project['sessionsByProvider'] | null>(null);
  const projectId = selectedProject?.projectId;

  // 只在切換專案時清除快取；關閉下拉時清除會改變 sessionList，
  // 使候選過濾 effect 再次開啟下拉，導致 Escape 無法關閉。
  useEffect(() => {
    setFetchedSessions(null);
  }, [projectId]);

  useEffect(() => {
    if (!showFileDropdown || !projectId) {
      return;
    }
    let cancelled = false;
    // ponytail: 后端单页上限 200 笔，更老的会话要靠搜尋；需要时再接 /search/sessions
    api
      .projectSessions(projectId, { limit: SESSION_FETCH_LIMIT })
      .then((response: Response) => (response.ok ? response.json() : null))
      .then((page: Pick<Project, 'sessionsByProvider'> | null) => {
        if (!cancelled && page?.sessionsByProvider) {
          setFetchedSessions(page.sessionsByProvider);
        }
      })
      .catch((error: unknown) => console.error('Error fetching sessions for mentions:', error));
    return () => {
      cancelled = true;
    };
  }, [showFileDropdown, projectId]);

  const sessionList = useMemo<MentionableFile[]>(() => {
    if (!selectedProject) {
      return [];
    }
    const source = fetchedSessions ? { ...selectedProject, sessionsByProvider: fetchedSessions } : selectedProject;
    return getAllSessions(source).map((session) => ({
      name: String(session.summary || session.name || session.id),
      path: `@session:${session.id}`,
      detail: `${session.__provider ?? 'session'} · @session`,
    }));
  }, [selectedProject, fetchedSessions]);

  useEffect(() => {
    const textBeforeCursor = input.slice(0, cursorPosition);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex === -1) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      return;
    }

    const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
    if (textAfterAt.includes(' ')) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      return;
    }

    setAtSymbolPosition(lastAtIndex);
    setShowFileDropdown(true);
    setSelectedFileIndex(-1);

    setFilteredFiles(filterMentionCandidates(textAfterAt, fileList, sessionList));
  }, [input, cursorPosition, fileList, sessionList]);

  const activeFileMentions = useMemo(() => {
    if (!input || fileMentions.length === 0) {
      return [];
    }
    return fileMentions.filter((path) => input.includes(path));
  }, [fileMentions, input]);

  const sortedFileMentions = useMemo(() => {
    if (activeFileMentions.length === 0) {
      return [];
    }
    const uniqueMentions = Array.from(new Set(activeFileMentions));
    return uniqueMentions.sort((mentionA, mentionB) => mentionB.length - mentionA.length);
  }, [activeFileMentions]);

  const fileMentionRegex = useMemo(() => {
    if (sortedFileMentions.length === 0) {
      return null;
    }
    const pattern = sortedFileMentions.map(escapeRegExp).join('|');
    return new RegExp(`(${pattern})`, 'g');
  }, [sortedFileMentions]);

  const fileMentionSet = useMemo(() => new Set(sortedFileMentions), [sortedFileMentions]);

  const renderInputWithMentions = useCallback(
    (text: string) => {
      if (!text) {
        return '';
      }
      if (!fileMentionRegex) {
        return text;
      }

      const parts = text.split(fileMentionRegex);
      return parts.map((part, index) =>
        fileMentionSet.has(part) ? (
          <span
            key={`mention-${index}`}
            className="-ml-0.5 rounded-md bg-blue-200/70 box-decoration-clone px-0.5 text-transparent dark:bg-blue-300/40"
          >
            {part}
          </span>
        ) : (
          <span key={`text-${index}`}>{part}</span>
        ),
      );
    },
    [fileMentionRegex, fileMentionSet],
  );

  const selectFile = useCallback(
    (file: MentionableFile) => {
      const textBeforeAt = input.slice(0, atSymbolPosition);
      const textAfterAtQuery = input.slice(atSymbolPosition);
      const spaceIndex = textAfterAtQuery.indexOf(' ');
      const textAfterQuery = spaceIndex !== -1 ? textAfterAtQuery.slice(spaceIndex) : '';

      const newInput = `${textBeforeAt}${file.path} ${textAfterQuery}`;
      const newCursorPosition = textBeforeAt.length + file.path.length + 1;

      if (textareaRef.current && !textareaRef.current.matches(':focus')) {
        textareaRef.current.focus();
      }

      setInput(newInput);
      setCursorPosition(newCursorPosition);
      setFileMentions((previousMentions) =>
        previousMentions.includes(file.path) ? previousMentions : [...previousMentions, file.path],
      );

      setShowFileDropdown(false);
      setAtSymbolPosition(-1);

      if (!textareaRef.current) {
        return;
      }

      requestAnimationFrame(() => {
        if (!textareaRef.current) {
          return;
        }
        textareaRef.current.setSelectionRange(newCursorPosition, newCursorPosition);
        if (!textareaRef.current.matches(':focus')) {
          textareaRef.current.focus();
        }
      });
    },
    [input, atSymbolPosition, textareaRef, setInput],
  );

  const handleFileMentionsKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showFileDropdown || filteredFiles.length === 0) {
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex < filteredFiles.length - 1 ? previousIndex + 1 : 0,
        );
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex > 0 ? previousIndex - 1 : filteredFiles.length - 1,
        );
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        if (selectedFileIndex >= 0) {
          selectFile(filteredFiles[selectedFileIndex]);
        } else if (filteredFiles.length > 0) {
          selectFile(filteredFiles[0]);
        }
        return true;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        setShowFileDropdown(false);
        return true;
      }

      return false;
    },
    [showFileDropdown, filteredFiles, selectedFileIndex, selectFile],
  );

  return {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  };
}
