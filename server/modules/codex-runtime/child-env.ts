const AMBIENT_CODEX_RUN_KEYS = [
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
] as const;

/**
 * Starts AgentUI-managed Codex processes outside the identity of any Codex
 * process that happened to launch AgentUI. An explicit CODEX_HOME remains the
 * only inherited Codex runtime identity.
 */
export function buildCodexChildEnv(
  configRoot: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, CODEX_HOME: configRoot };
  for (const key of AMBIENT_CODEX_RUN_KEYS) delete env[key];
  return env;
}
