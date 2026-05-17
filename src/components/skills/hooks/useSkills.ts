import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { SkillItem, SkillProvider, SkillScope } from '../types';

type ApiResponse<T> = {
  success: boolean;
  data: T;
};

type SkillsListResponse = {
  skills: SkillItem[];
};

type SkillCreateResponse = {
  skill: SkillItem;
};

type UploadResponse = {
  imported: string[];
};

type UseSkillsArgs = {
  provider: SkillProvider;
  workspacePath?: string;
};

const toResponseJson = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const getApiErrorMessage = (payload: unknown, fallback: string): string => {
  if (!payload || typeof payload !== 'object') return fallback;
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
};

export function useSkills({ provider, workspacePath }: UseSkillsArgs) {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);

  const refreshSkills = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (workspacePath) params.set('workspacePath', workspacePath);
      const response = await authenticatedFetch(
        `/api/providers/${provider}/skills?${params.toString()}`,
      );
      const data = await toResponseJson<ApiResponse<SkillsListResponse>>(response);
      if (!response.ok || !data.success) {
        throw new Error(getApiErrorMessage(data, 'Failed to load skills'));
      }
      setSkills(data.data.skills);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load skills');
    } finally {
      setIsLoading(false);
    }
  }, [provider, workspacePath]);

  const createSkill = useCallback(async (
    name: string,
    content: string,
    scope: SkillScope,
  ) => {
    const response = await authenticatedFetch(`/api/providers/${provider}/skills`, {
      method: 'POST',
      body: JSON.stringify({ name, content, scope, workspacePath }),
    });
    const data = await toResponseJson<ApiResponse<SkillCreateResponse>>(response);
    if (!response.ok || !data.success) {
      throw new Error(getApiErrorMessage(data, 'Failed to create skill'));
    }
    await refreshSkills();
    setSaveStatus('success');
    return data.data.skill;
  }, [provider, workspacePath, refreshSkills]);

  const updateSkill = useCallback(async (
    name: string,
    content: string,
    scope: SkillScope,
  ) => {
    const response = await authenticatedFetch(`/api/providers/${provider}/skills`, {
      method: 'POST',
      body: JSON.stringify({ name, content, scope, workspacePath }),
    });
    const data = await toResponseJson<ApiResponse<SkillCreateResponse>>(response);
    if (!response.ok || !data.success) {
      throw new Error(getApiErrorMessage(data, 'Failed to update skill'));
    }
    await refreshSkills();
    setSaveStatus('success');
    return data.data.skill;
  }, [provider, workspacePath, refreshSkills]);

  const deleteSkill = useCallback(async (name: string, scope: SkillScope) => {
    const params = new URLSearchParams({ scope });
    if (workspacePath) params.set('workspacePath', workspacePath);
    const response = await authenticatedFetch(
      `/api/providers/${provider}/skills/${encodeURIComponent(name)}?${params.toString()}`,
      { method: 'DELETE' },
    );
    const data = await toResponseJson<ApiResponse<{ removed: boolean }>>(response);
    if (!response.ok || !data.success) {
      throw new Error(getApiErrorMessage(data, 'Failed to delete skill'));
    }
    await refreshSkills();
    setSaveStatus('success');
  }, [provider, workspacePath, refreshSkills]);

  const uploadFile = useCallback(async (file: File, scope: SkillScope) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('scope', scope);
    if (workspacePath) formData.append('workspacePath', workspacePath);

    const response = await authenticatedFetch(`/api/providers/${provider}/skills/upload`, {
      method: 'POST',
      body: formData,
      headers: {},
    });
    const data = await toResponseJson<ApiResponse<UploadResponse>>(response);
    if (!response.ok || !data.success) {
      throw new Error(getApiErrorMessage(data, 'Failed to upload skill file'));
    }
    await refreshSkills();
    setSaveStatus('success');
    return data.data.imported;
  }, [provider, workspacePath, refreshSkills]);

  useEffect(() => {
    void refreshSkills();
  }, [refreshSkills]);

  useEffect(() => {
    if (saveStatus === null) return;
    const timer = window.setTimeout(() => setSaveStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  return {
    skills,
    isLoading,
    error,
    saveStatus,
    createSkill,
    updateSkill,
    deleteSkill,
    uploadFile,
    refreshSkills,
  };
}
