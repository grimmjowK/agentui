/** Diagnose the CLI bootstrap error without changing its account or routing config. */
export function codexTerminalFailure(output: string): string | null {
  if (/account\/read failed during TUI bootstrap[\s\S]*workspace routing discovery timed out/.test(output)) {
    return 'Codex account workspace routing discovery timed out during terminal startup. The CLI exited; the session history is unchanged. Check the CLI account/network connection, then click Connect to retry the same session.';
  }
  return null;
}
