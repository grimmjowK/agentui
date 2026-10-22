import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveCodexExecutablePath, resolveCodexCapabilityStatus, parseCodexVersion } from './codex-cli-path.js';

test('all callers resolve explicit or PATH executables; no App fallback', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // 即便存在一个"App 风格"的二进制，没有显式配置时也绝不会被选中——只认 PATH 里的 codex。
  const app = path.join(root, 'App with spaces; literal');
  const cli = path.join(root, 'codex');
  for (const file of [app, cli]) fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const options = { platform: 'darwin' as const, searchPath: root };
  assert.equal(resolveCodexExecutablePath(undefined, options), cli);
  assert.equal(resolveCodexExecutablePath(`"${cli}"`, options), cli);
  assert.equal(resolveCodexExecutablePath('codex', options), cli);
  assert.equal(resolveCodexExecutablePath(undefined, { ...options, platform: 'linux' }), cli);
  // 显式指向 App 二进制仍然可用（保留给需要的人）。
  assert.equal(resolveCodexExecutablePath(app, options), app);
  assert.throws(() => resolveCodexExecutablePath(path.join(root, 'missing'), options), /unavailable/);
  assert.throws(() => resolveCodexExecutablePath(' ', options), /empty/);
  // PATH 里没有 codex 时报错提示安装 CLI，不再退回任何 App 内置版本。
  fs.unlinkSync(cli);
  assert.throws(() => resolveCodexExecutablePath(undefined, options), /not found/);
});

test('runtime cache invalidates when the selected executable or configuration root changes', async (t) => {
  const { getCodexRuntimeInfo } = await import('./codex-cli-path.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-version-'));
  const originalPath = process.env.CODEX_CLI_PATH;
  const originalHome = process.env.CODEX_HOME;
  t.after(() => {
    if (originalPath === undefined) delete process.env.CODEX_CLI_PATH; else process.env.CODEX_CLI_PATH = originalPath;
    if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'codex $(literal); with spaces');
  fs.writeFileSync(file, '#!/bin/sh\necho codex-cli 0.155.0-alpha.1\n', { mode: 0o755 });
  process.env.CODEX_CLI_PATH = file;
  process.env.CODEX_HOME = root;
  assert.equal(getCodexRuntimeInfo().version, 'codex-cli 0.155.0-alpha.1');
  fs.writeFileSync(file, '#!/bin/sh\necho codex-cli 0.163.0\n');
  process.env.CODEX_HOME = path.join(root, 'another-config');
  const runtime = getCodexRuntimeInfo();
  assert.equal(runtime.version, 'codex-cli 0.163.0');
  assert.equal(runtime.configRoot, process.env.CODEX_HOME);
  // 平台相关：darwin 上 0.163.0 >= 0.155.0 为 protocol-tested，其它平台为 unverified。
  assert.equal(runtime.capabilities.status, process.platform === 'darwin' ? 'protocol-tested' : 'unverified');
});

test('version parsing extracts major.minor.patch and rejects unparseable strings', () => {
  assert.deepEqual(parseCodexVersion('codex-cli 0.163.0'), [0, 163, 0]);
  assert.deepEqual(parseCodexVersion('codex-cli 0.155.0-alpha.9.2'), [0, 155, 0]);
  assert.equal(parseCodexVersion('codex-cli-test-22'), null);
  assert.equal(parseCodexVersion(''), null);
});

test('capability status gates on a minimum verified version, not exact match', () => {
  // 达到或高于最低已验证版本 + darwin → protocol-tested（含带补丁号的预发布版本）。
  assert.equal(resolveCodexCapabilityStatus('codex-cli 0.155.0-alpha.9.2', 'darwin'), 'protocol-tested');
  assert.equal(resolveCodexCapabilityStatus('codex-cli 0.163.0', 'darwin'), 'protocol-tested');
  // 低于最低已验证版本但可解析 → unverified（仍尝试运行）。
  assert.equal(resolveCodexCapabilityStatus('codex-cli 0.154.9', 'darwin'), 'unverified');
  // 非 darwin 平台未经协议实测 → unverified。
  assert.equal(resolveCodexCapabilityStatus('codex-cli 0.163.0', 'linux'), 'unverified');
  // 版本号无法解析 → unsupported。
  assert.equal(resolveCodexCapabilityStatus('codex-cli-test-22', 'darwin'), 'unsupported');
});
