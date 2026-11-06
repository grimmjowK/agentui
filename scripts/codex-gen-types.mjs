#!/usr/bin/env node
/**
 * 生成 Codex app-server 協議型別（design D8）。
 *
 * 完整生成約 747 個檔案，這裡只保留介接層實際用到的方法與型別，以及它們的相依型別。
 * 新增用到的方法時，加進下方清單後重新執行 `npm run codex:gen-types`，並在 review 檢查 diff。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 介接層送出的請求（回應型別依命名慣例 `XxxParams` → `XxxResponse`）。 */
const CLIENT_REQUESTS = [
  'initialize',
  'model/list',
  'thread/start',
  'thread/resume',
  'thread/read',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
];

/** 介接層處理的伺服器通知。 */
const SERVER_NOTIFICATIONS = [
  'error',
  'turn/started',
  'turn/completed',
  'turn/plan/updated',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'thread/tokenUsage/updated',
];

/** 介接層回應的伺服器請求（審批）。 */
const SERVER_REQUESTS = [
  'mcpServer/elicitation/request',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
];

/** 清單以外另外直接使用的型別。 */
const EXTRA_TYPES = ['ThreadItem', 'RequestId'];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'server/modules/codex-runtime/protocol');
const genDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gen-'));

const version = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
execFileSync('codex', ['app-server', 'generate-ts', '--out', genDir], { stdio: 'inherit' });

const read = (relative) => fs.readFileSync(path.join(genDir, relative), 'utf8');

function findType(name) {
  for (const relative of [`${name}.ts`, `v2/${name}.ts`]) {
    if (fs.existsSync(path.join(genDir, relative))) return relative;
  }
  throw new Error(`找不到生成的型別 ${name}`);
}

/** 從生成的 union 檔讀出 method → params 型別名稱。 */
function paramsByMethod(unionFile, methods) {
  const source = read(unionFile);
  return methods.map((method) => {
    const match = new RegExp(`"method": "${method.replace(/\//g, '\\/')}",(?: id: RequestId,)? "?params"?: (\\w+)`).exec(source);
    if (!match) throw new Error(`${unionFile} 中沒有 ${method}（codex 版本變了？）`);
    return { method, params: match[1] };
  });
}

const requests = paramsByMethod('ClientRequest.ts', CLIENT_REQUESTS)
  .map((entry) => ({ ...entry, result: entry.params.replace(/Params$/, 'Response') }));
const notifications = paramsByMethod('ServerNotification.ts', SERVER_NOTIFICATIONS);
const serverRequests = paramsByMethod('ServerRequest.ts', SERVER_REQUESTS)
  .map((entry) => ({ ...entry, result: entry.params.replace(/Params$/, 'Response') }));

const entryTypes = [
  ...requests.flatMap((entry) => [entry.params, entry.result]),
  ...notifications.map((entry) => entry.params),
  ...serverRequests.flatMap((entry) => [entry.params, entry.result]),
  ...EXTRA_TYPES,
];

// 從入口型別沿 import 收集相依檔案
const kept = new Set();
const stack = entryTypes.map(findType);
while (stack.length > 0) {
  const relative = stack.pop();
  if (kept.has(relative)) continue;
  kept.add(relative);
  for (const [, spec] of read(relative).matchAll(/from "(\.[^"]+)"/g)) {
    stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative), `${spec}.ts`)));
  }
}

const header = `// ${version} · 由 npm run codex:gen-types 生成，請勿手動修改。\n`;

fs.rmSync(outDir, { recursive: true, force: true });
for (const relative of kept) {
  // 後端是 NodeNext 模組解析，相對路徑必須帶副檔名
  const source = read(relative).replace(/from "(\.[^"]+)"/g, 'from "$1.js"');
  fs.mkdirSync(path.dirname(path.join(outDir, relative)), { recursive: true });
  fs.writeFileSync(path.join(outDir, relative), header + source);
}

const importLine = (name) => `import type { ${name} } from './${findType(name).replace(/\.ts$/, '.js')}';`;
const index = [
  header,
  ...[...new Set(entryTypes)].sort().map(importLine),
  '',
  `export type { ${[...new Set(entryTypes)].sort().join(', ')} };`,
  '',
  '/** 介接層送出的請求：method → 參數與回應。 */',
  'export type ClientRequestMap = {',
  ...requests.map((entry) => `  '${entry.method}': { params: ${entry.params}; result: ${entry.result} };`),
  '};',
  '',
  'export type ClientRequestMethod = keyof ClientRequestMap;',
  '',
  '/** 介接層處理的伺服器通知。 */',
  'export type ServerNotification =',
  ...notifications.map((entry) => `  | { method: '${entry.method}'; params: ${entry.params} }`),
  '  ;',
  '',
  '/** 介接層回應的伺服器請求：method → 參數與回應。 */',
  'export type ServerRequestMap = {',
  ...serverRequests.map((entry) => `  '${entry.method}': { params: ${entry.params}; result: ${entry.result} };`),
  '};',
  '',
  'export type ServerRequest = {',
  '  [M in keyof ServerRequestMap]: { method: M; id: RequestId; params: ServerRequestMap[M][\'params\'] };',
  '}[keyof ServerRequestMap];',
  '',
].join('\n');
fs.writeFileSync(path.join(outDir, 'index.ts'), index);

fs.rmSync(genDir, { recursive: true, force: true });
console.log(`${version}: 保留 ${kept.size} 個型別檔 → ${path.relative(repoRoot, outDir)}`);
