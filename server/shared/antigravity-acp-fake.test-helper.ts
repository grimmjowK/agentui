/**
 * 測試用：產生一個說 ACP 的假 `agy` 腳本。
 * `script` 是 agent 端 JS 函式主體，可使用：
 *   prompt(text, sessionId) → 回傳 Promise<{ updates, transcript, stopReason, error, wait }>
 * 劇本以 prompt 文字分派；簡單情境用 `respond` 描述即可。
 */
export function acpFakeAgent(promptHandler: string): string {
  return `
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.ANTIGRAVITY_HOME;
const record = (m) => fs.appendFileSync(path.join(home, 'acp-calls.jsonl'), JSON.stringify(m) + '\\n');
record({ argv: process.argv.slice(2), cwd: process.cwd() });
if (process.env.FAKE_AGY_SESSION === 'startup-failure') { process.stderr.write('CLI startup failure'); process.exit(1); }
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let sessionId = null;
const ctx = {
  out,
  update: (u) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } }),
  text: (t) => ctx.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } }),
  transcript: (entries) => {
    const dir = path.join(home, 'brain', sessionId, '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    for (const e of entries) fs.appendFileSync(path.join(dir, 'transcript.jsonl'), JSON.stringify({ created_at: new Date().toISOString(), ...e }) + '\\n');
  },
  get sessionId() { return sessionId; },
};
const handlePrompt = async (id, text) => { ${promptHandler} };
let cancelHook = null;
ctx.onCancel = (fn) => { cancelHook = fn; };
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method) record({ method: m.method, params: m.params });
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentInfo: { version: 'fake' } } });
  if (m.method === 'session/new') { sessionId = process.env.FAKE_AGY_SESSION || ('acp-' + Date.now()); return out({ jsonrpc: '2.0', id: m.id, result: { sessionId } }); }
  if (m.method === 'session/resume') { sessionId = m.params.sessionId; return out({ jsonrpc: '2.0', id: m.id, result: {} }); }
  if (m.method === 'session/set_mode' || m.method === 'session/set_model') return out({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'session/cancel') return cancelHook && cancelHook();
  if (m.method === 'session/prompt') {
    return void Promise.resolve(handlePrompt(m.id, m.params.prompt[0].text)).then((result) => {
      if (result === undefined) return;
      if (result.error) return out({ jsonrpc: '2.0', id: m.id, error: result.error });
      out({ jsonrpc: '2.0', id: m.id, result: { stopReason: result.stopReason || 'end_turn' } });
    });
  }
});
`;
}
