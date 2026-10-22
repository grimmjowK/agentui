#!/usr/bin/env tsx
/**
 * Codex 会话锁管理 CLI（有门槛的异常恢复入口，不在聊天/终端常规 UI 上暴露）。
 *
 * 用法：
 *   tsx --tsconfig server/tsconfig.json scripts/codex-lock-admin.ts diagnose <threadId> [--config-root <dir>]
 *   tsx --tsconfig server/tsconfig.json scripts/codex-lock-admin.ts force-release <threadId> [--config-root <dir>] [--min-age-ms <ms>]
 *
 * diagnose 只读，输出锁的持有方、声明时间、距今时长，以及服务端/子进程的双重身份校验结论。
 * force-release 仅当两端身份均非 confirmed-alive 且锁龄超过 --min-age-ms（默认 10 分钟）时才释放，
 * 并在释放前二次核对身份。
 */
import { codexOwnership } from '../server/modules/codex-runtime/ownership.js';
import { resolveCodexConfigRoot } from '../server/shared/codex-cli-path.js';

function parseArgs(argv: string[]) {
  const [command, threadId, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i]?.startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, threadId, flags };
}

function main() {
  const { command, threadId, flags } = parseArgs(process.argv.slice(2));
  if (!command || !threadId) {
    console.error('用法: codex-lock-admin.ts <diagnose|force-release> <threadId> [--config-root <dir>] [--min-age-ms <ms>]');
    process.exit(2);
  }
  const configRoot = flags['config-root'] || resolveCodexConfigRoot();

  if (command === 'diagnose') {
    const diagnosis = codexOwnership.diagnose(configRoot, threadId);
    if (!diagnosis) { console.log('未找到该 thread 的锁。'); return; }
    console.log(JSON.stringify(diagnosis, null, 2));
    return;
  }

  if (command === 'force-release') {
    const minAgeMs = Number(flags['min-age-ms'] ?? 600000);
    const result = codexOwnership.forceRelease(configRoot, threadId, minAgeMs);
    if (result === 'not-found') console.log('未找到该 thread 的锁。');
    else if (result === 'still-alive') console.log('拒绝释放：持有方可能仍存活，或锁龄未达到阈值。先运行 diagnose 核对。');
    else console.log('已释放该 thread 的锁。');
    return;
  }

  console.error(`未知命令: ${command}`);
  process.exit(2);
}

main();
