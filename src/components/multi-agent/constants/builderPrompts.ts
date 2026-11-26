/**
 * 建立器說明：首次送出時附加在使用者需求之前（design D3）。
 * 只描述輸出格式與限制，模型清單由使用者描述或 AI 自行選擇，保存時後端再校驗。
 */
import { MAX_CHAT_MEMBERS, MAX_WORKFLOW_NODES } from '../../../../shared/multiAgent';
import type { LLMProvider } from '../../../../shared/providers';
import type { MultiAgentKind } from '../types/types';

export const DEFINITION_LANGUAGE = 'multi-agent-json';

/**
 * 建立器說明的版本。格式有變（例如新增節點類型）時遞增，
 * 既有建立器會話的下一則訊息會重新附上最新說明。
 */
export const BUILDER_PROMPT_VERSION = 2;

type ModelHint = { provider: LLMProvider; models: string[] };

function modelSection(hints: ModelHint[]): string {
  if (!hints.length) return '';
  const lines = hints.map((h) => `- ${h.provider}: ${h.models.join(', ')}`);
  return `\n可用的 provider 與模型（provider 與 model 欄位必須取自此清單）：\n${lines.join('\n')}\n`;
}

const WORKFLOW_EXAMPLE = `{
  "nodes": [
    { "id": "collect", "title": "收集資料", "instruction": "……", "provider": "claude", "model": "sonnet", "dependsOn": [] },
    { "id": "review", "title": "人工確認", "instruction": "確認資料是否齊全", "type": "approval", "dependsOn": ["collect"] },
    { "id": "summarize", "title": "撰寫摘要", "instruction": "……", "provider": "codex", "model": "gpt-5", "dependsOn": ["review"] }
  ]
}`;

const CHATROOM_EXAMPLE = `{
  "members": [
    { "id": "pm", "name": "產品經理", "persona": "……", "provider": "claude", "model": "sonnet" },
    { "id": "eng", "name": "工程師", "persona": "……", "provider": "codex", "model": "gpt-5" }
  ],
  "rules": { "text": "……", "allowAiMentions": false, "maxAiRepliesPerTurn": 2, "unmentionedBehavior": "all" }
}`;

export function buildBuilderPrompt(kind: MultiAgentKind, hints: ModelHint[], current: unknown): string {
  const common = [
    '你是多 Agent 設計助手。根據使用者的需求，設計並輸出一份定義。',
    `輸出時把完整定義放在一個 \`\`\`${DEFINITION_LANGUAGE} 程式碼區塊中（JSON 格式，不要註解）。`,
    '每次修改都輸出完整定義，不要只輸出差異。需求不清楚時先簡短追問，不要猜。',
    '不要建立或修改任何檔案，只在對話中輸出定義。',
  ];
  const spec = kind === 'workflow'
    ? [
      `這是一個工作流：由 1–${MAX_WORKFLOW_NODES} 個步驟（節點）組成，依 dependsOn 形成無環的依賴關係；`,
      '沒有依賴的步驟會並行執行，上游步驟的輸出會自動附在下游步驟的提示中。',
      'id 用簡短的英文小寫；instruction 要具體寫出該步驟要做什麼、輸出什麼。',
      '需要人工確認、評審或決策才能往下走時，插入人工確認節點：{ "id", "title", "instruction"（寫明要使用者確認什麼）, "type": "approval", "dependsOn" }，不要填 provider / model。',
      '執行到人工確認節點時整個工作流暫停，使用者核准（可附備註）後才繼續；駁回則下游全部略過。上游輸出與使用者備註會一起傳給下游。',
      `格式範例：\n${WORKFLOW_EXAMPLE}`,
    ]
    : [
      `這是一個群聊聊天室：由 1–${MAX_CHAT_MEMBERS} 位成員組成，每位成員是一個 AI 角色。`,
      '成員名稱不可重複、不可含空白或 @，也不可叫「所有人」；persona 寫清楚角色的立場、專長與說話風格。',
      'rules.text 是群規；maxAiRepliesPerTurn 為 1–32 的整數；unmentionedBehavior 為 all 或 none。',
      '群規要能防止成員之間空泛客套、重複發言，以節省 token。',
      `格式範例：\n${CHATROOM_EXAMPLE}`,
    ];
  const currentSection = current
    ? `\n目前的定義如下，請在此基礎上依使用者要求修改：\n\`\`\`${DEFINITION_LANGUAGE}\n${JSON.stringify(current, null, 2)}\n\`\`\``
    : '';
  return [...common, '', ...spec, modelSection(hints), currentSection].join('\n');
}
