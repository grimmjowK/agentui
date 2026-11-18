/**
 * 多 Agent 建立器複用聊天頁時注入的設定（multi-agent-workspace design D3）。
 * 一般聊天沒有 Provider，所有欄位皆為 null，行為不變。
 */
import { createContext, useContext } from 'react';

export type ChatBuilderConfig = {
  /** 新會話第一則訊息前附加的建立器說明（以 command-context 信封包起來，氣泡只顯示使用者原文） */
  promptPrefix: string;
  /** 空狀態標題與說明 */
  emptyTitle: string;
  emptyDescription: string;
  /** 外部要求填入輸入框的文字（例如「讓 AI 修正」），nonce 變化時套用 */
  inputRequest?: { text: string; nonce: number } | null;
};

export const ChatBuilderContext = createContext<ChatBuilderConfig | null>(null);

export function useChatBuilder(): ChatBuilderConfig | null {
  return useContext(ChatBuilderContext);
}
