import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveCodexExecutablePath } from './codex-cli-path.js';

test('all callers resolve explicit, App and PATH executables without an SDK fallback', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'App with spaces; literal');
  const cli = path.join(root, 'codex');
  for (const file of [app, cli]) fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const options = { platform: 'darwin' as const, appPaths: [app], searchPath: root };
  assert.equal(resolveCodexExecutablePath(undefined, options), app);
  assert.equal(resolveCodexExecutablePath(`"${cli}"`, options), cli);
  assert.equal(resolveCodexExecutablePath('codex', options), cli);
  assert.equal(resolveCodexExecutablePath(undefined, { ...options, platform: 'linux' }), cli);
  assert.throws(() => resolveCodexExecutablePath(path.join(root, 'missing'), options), /unavailable/);
  assert.throws(() => resolveCodexExecutablePath(' ', options), /empty/);
  fs.chmodSync(app, 0o644);
  assert.equal(resolveCodexExecutablePath(undefined, options), cli);
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
  fs.writeFileSync(file, '#!/bin/sh\necho codex-cli-test-1\n', { mode: 0o755 });
  process.env.CODEX_CLI_PATH = file;
  process.env.CODEX_HOME = root;
  assert.equal(getCodexRuntimeInfo().version, 'codex-cli-test-1');
  fs.writeFileSync(file, '#!/bin/sh\necho codex-cli-test-22\n');
  process.env.CODEX_HOME = path.join(root, 'another-config');
  const runtime = getCodexRuntimeInfo();
  assert.equal(runtime.version, 'codex-cli-test-22');
  assert.equal(runtime.configRoot, process.env.CODEX_HOME);
  assert.equal(runtime.capabilities.status, 'unverified');
});
