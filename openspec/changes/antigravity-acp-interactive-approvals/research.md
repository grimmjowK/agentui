# ACP 支援調研與實測（2026-11-05）

本 change 暫緩前的調研紀錄。版本與已知問題變動很快，重啟前務必重新驗證。

## 版本與接入方式

| | 接入方式 | 測試版本 |
| --- | --- | --- |
| Antigravity | CLI 內建 `agy acp` | agy 1.5.0（ACP 支援在 1.5.0 才上線） |
| Claude | `@agentclientprotocol/claude-agent-acp`，底層 `@anthropic-ai/claude-agent-sdk` | 0.100.0（SDK 0.3.316） |
| Codex | `@agentclientprotocol/codex-acp`，底層 `codex app-server`（自帶 `@openai/codex`，可用 `CODEX_PATH` 指定本機版本） | 2.5.0（自帶 codex 0.165） |

舊套件 `@zed-industries/claude-code-acp`、`@zed-industries/claude-agent-acp`、`@zed-industries/codex-acp` 皆已棄用。ACP 規格 v1 為生產版本（1.15.x），v2 仍是草案。

## 本機實測結論

實測腳本為一次性腳本，沒有提交；以下為結果。

- 三家都能完成 initialize → session/new → 需審批的工具 → session/request_permission → 回覆後繼續 → session/resume。
- 審批選項：
  - Antigravity：`allow`（allow_once）、`deny`（reject_once）。
  - Claude：一般工具 `allow-once` / `reject`；編輯另有 `allow-with-updates`（allow_always，本會話內允許該目錄的編輯）；計畫審批（`kind: switch_mode`）有 5 個選項，含「批准後改用 auto / bypass」。
  - Codex（`workspace-write` 模式）：`allow_once`、`accept_execpolicy_amendment`（allow_always，永久放寬執行規則，我們目前刻意過濾）、`cancel`。
- 模式：
  - Antigravity：`default`、`accept-edits`、`plan`（沒有跳過權限）。
  - Claude：`default`、`acceptEdits`、`plan`、`auto`、`bypassPermissions`。
  - Codex：`read-only`、`workspace-write`、`agent`（由 AI 自動審核，不問使用者）、`agent-full-access`。
- 設定項（configOptions）：
  - Antigravity：model、thought_level、mode。
  - Claude：mode、model、effort、fast、ultracode、agent。
  - Codex：mode、collaboration_mode（default / plan）、model、reasoning_effort。
- 執行中再送 `session/prompt`：
  - Antigravity、Claude：併入目前這一輪，最終回覆遵循插話。
  - Codex：插話內容被採納，但多產生一則回覆（不是併入原回覆）。
- Claude 的 AskUserQuestion：客戶端宣告 `elicitation.form` 後，以 `elicitation/create` 表單詢問。
- Claude 的 UI 允許/禁用工具清單：可經 `session/new` 的 `_meta.claudeCode.options`（allowedTools / disallowedTools）傳入（讀原始碼確認，未實測）。
- `agy acp` 的會話寫入同一個 `brain/<id>/.system_generated/logs/transcript.jsonl` 並被現有 synchronizer 索引。`session/resume` 不重播歷史，`session/load` 會重播。

## 與現有接法相比的落差（不能閹割的項目）

| 項目 | 狀態 |
| --- | --- |
| Codex 的 DeepSeek profile 與 `-c` 設定覆寫（model_provider、model_catalog_json） | 未找到支援證據，最可能退化 |
| Codex 插話的呈現 | 會多一則回覆，與現有 `turn/steer` 直接併入不同 |
| Codex 審批預設由 AI 自動審核 | 需固定使用 `workspace-write` 模式 |
| Codex 的「不再詢問」放寬規則 | 需在客戶端過濾 |
| Codex 與終端頁共用會話的佔用鎖（codexOwnership） | 轉接器自己啟動 app-server，需重新接上 |
| Claude「記住」允許規則 | 寫入 Claude 設定檔而非我們的 UI 設定，行為改變 |
| Claude 子 agent 即時事件 | 需宣告草案階段能力才會分開，否則混入主對話 |
| 即時事件改走 ACP、歷史仍讀原生檔案 | 即時與歷史顯示可能不一致 |

## 調研到的風險（二手資料）

- 插話在 ACP 規格中沒有正式機制（PR #1261 未合併），兩個轉接器用非標準擴充 `_session/steering`。
- claude-agent-acp 幾乎每天發版；已知會讓整輪失敗的 issue：#1486、#1501；計畫（TodoWrite）更新在部分模型上不觸發：#1380。
- codex-acp 發版頻繁；app-server 崩潰時 `session/prompt` 不返回：#600；resume 後可能卡住：#672；非特權容器啟動失敗：#470。
- agy acp 剛上線：自訂 skills 不出現在指令清單、`authenticate` 有硬編碼逾時、部分模型串流卡住等問題。
- Antigravity 服務條款對「用第三方工具存取」有限制性措辭；本專案使用官方 CLI 內建的 `agy acp`，但重啟前建議確認最新條款原文。

## 重啟時的建議方向

1. 做一個不分 provider 的 ACP 執行層（連線、事件映射、審批、逾時、中斷只寫一套）。
2. Antigravity 直接切到 ACP（它沒有其他互動審批管道）。
3. Claude、Codex 保留現有接法並可切換到 ACP；每家通過「功能不退化」驗收清單（上表）才把預設切過去。
4. 審批回覆訊息與審批池三家統一。
5. 轉接器鎖定版本，客戶端自加逾時保護。

## 暫緩期間的現況

Antigravity 仍為 headless 非互動模式。需要審批的工具會被自動拒絕，頁面會顯示警告（commit `0bc00cc6`），建議使用者改用跳過權限或在 `settings.json` 的 `permissions.allow` 加允許規則。
