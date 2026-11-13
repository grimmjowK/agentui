/**
 * 斜杠命令 / skill 芯片发送时，UI 会把命令正文（skill markdown 等）拼进 prompt 发给 CLI。
 * 这部分是 agent 层注入的上下文，不是用户输入；用信封标签包起来，回放历史时才能
 * 把它和用户真正输入的文字拆开（不勾选「显示原始参数」时只展示用户输入）。
 *
 * 注意：信封之前发送的旧会话没有标记，无法拆分，仍按原样展示。
 */
const OPEN_TAG_RE = /^<command-context name="([^"]*)">\n([\s\S]*?)\n<\/command-context>\n*/;

export function wrapCommandContext(commandName: string, body: string, userText: string): string {
  const envelope = `<command-context name="${commandName.replace(/"/g, '')}">\n${body}\n</command-context>`;
  return userText ? `${envelope}\n\n${userText}` : envelope;
}

/** 拆出注入上下文；不是信封格式时返回 null。text 为空时用命令名兜底，保证气泡有内容。 */
export function splitCommandContext(content: string): { text: string; injectedContext: string } | null {
  const match = OPEN_TAG_RE.exec(content);
  if (!match) return null;
  const text = content.slice(match[0].length).trim();
  return { text: text || match[1], injectedContext: match[2] };
}

/** 手動輸入與命令晶片共用：保留原始換行與空白，不從已展開的模板反推參數。 */
export function getCommandUserText(commandName: string, rawInput: string): string {
  if (!rawInput.startsWith(commandName)) return '';
  const rest = rawInput.slice(commandName.length);
  return rest && !/^\s/.test(rest) ? '' : rest.trim();
}
