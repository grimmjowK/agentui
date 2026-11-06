## REMOVED Requirements

### Requirement: Delete Gemini CLI session file on session deletion
**Reason**: Gemini CLI 已被 Antigravity CLI 取代，`gemini` provider 整體下線。
**Migration**: 改用 `antigravity` provider；磁碟上既有的 Gemini 會話檔案保留不動，但不再於 UI 中顯示或管理。
