/** Diagnose the CLI bootstrap error without changing its account or routing config. */
export function codexTerminalFailure(output: string): string | null {
  if (/account\/read failed during TUI bootstrap[\s\S]*workspace routing discovery timed out/.test(output)) {
    return 'Codex account workspace routing discovery timed out during terminal startup. The CLI exited; the session history is unchanged. Check the CLI account/network connection, then click Connect to retry the same session.';
  }
  // paginated thread 的分页读取 API（thread/items/list）在当前 CLI 版本尚未实现，非交互 resume
  // 这类会话时 TUI bootstrap 失败。agentui 无法替 TUI 注入 excludeTurns，只能明确告知用户。
  if (/paginated_threads is not supported yet|paginated threads require thread\/(turns|items)\/list/.test(output)) {
    return 'This Codex session uses the paginated thread format, which the current Codex CLI cannot resume in the terminal yet (thread/items/list is not implemented). Chat still works for this session. Upgrade the Codex CLI once this is supported, or continue the session in chat.';
  }
  return null;
}
