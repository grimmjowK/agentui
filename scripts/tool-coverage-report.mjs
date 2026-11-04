#!/usr/bin/env -S npx tsx
/**
 * 存量渲染覆蓋率驗收（design D1b）。
 *
 * 掃描本機 ~/.claude/projects 與 ~/.codex/sessions，套用後端相同的映射，
 * 對照前端 toolConfigs.ts，輸出沒有專用設定（會走通用卡片）的工具呼叫比例。
 * 只讀本機檔案、只輸出工具名與次數，不輸出任何會話內容。
 *
 * 用法：npx tsx scripts/tool-coverage-report.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TOOL_CONFIGS, getToolConfig } from '../src/components/chat/tools/configs/toolConfigs.ts';
import { mapRolloutEntry } from '../server/modules/providers/list/codex/codex-item-mapper.ts';

function* walkJsonl(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJsonl(full);
    else if (entry.name.endsWith('.jsonl')) yield full;
  }
}

function* readEntries(file) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* 略過壞行 */ }
  }
}

const isMcp = (name) => name.startsWith('mcp__') || name.includes('/');
const isCovered = (name) => getToolConfig(name) !== TOOL_CONFIGS.Default;

function tally(names) {
  const stats = { total: 0, mcp: 0, uncovered: new Map() };
  for (const name of names) {
    if (isMcp(name)) { stats.mcp += 1; continue; }
    stats.total += 1;
    if (!isCovered(name)) stats.uncovered.set(name, (stats.uncovered.get(name) || 0) + 1);
  }
  return stats;
}

function* claudeToolNames() {
  for (const file of walkJsonl(path.join(os.homedir(), '.claude', 'projects'))) {
    for (const entry of readEntries(file)) {
      const content = entry?.message?.content;
      if (entry?.type !== 'assistant' || !Array.isArray(content)) continue;
      for (const block of content) if (block?.type === 'tool_use') yield String(block.name);
    }
  }
}

function* codexToolNames() {
  for (const file of walkJsonl(path.join(os.homedir(), '.codex', 'sessions'))) {
    const splitIds = new Map();
    for (const entry of readEntries(file)) {
      for (const mapped of mapRolloutEntry(entry, splitIds)) {
        if (mapped.kind === 'tool_use') yield String(mapped.toolName);
      }
    }
  }
}

function report(label, stats) {
  const uncovered = [...stats.uncovered.values()].reduce((a, b) => a + b, 0);
  const pct = stats.total ? ((uncovered / stats.total) * 100).toFixed(1) : '0.0';
  console.log(`\n${label}: ${uncovered}/${stats.total} 未覆蓋 (${pct}%)，MCP 另計 ${stats.mcp}`);
  for (const [name, count] of [...stats.uncovered].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(6)}  ${name}`);
  }
  return Number(pct);
}

const claudePct = report('Claude', tally(claudeToolNames()));
const codexPct = report('Codex', tally(codexToolNames()));

const pass = claudePct < 1 && codexPct < 5;
console.log(`\n門檻（Claude < 1%、Codex < 5%）：${pass ? '通過' : '未通過'}`);
process.exitCode = pass ? 0 : 1;
