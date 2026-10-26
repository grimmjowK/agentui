import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  parseAntigravityVersion,
  resolveAntigravityConfigRoot,
  resolveAntigravityExecutablePath,
} from './antigravity-cli-path.js';

test('resolves explicit configured path or falls back to PATH and standard paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const cli = path.join(root, 'agy');
  fs.writeFileSync(cli, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const options = { platform: 'darwin' as const, searchPath: root, homeDir: root };

  // Explicit
  assert.equal(resolveAntigravityExecutablePath(cli, options), cli);
  assert.equal(resolveAntigravityExecutablePath(`"${cli}"`, options), cli);

  // On PATH
  assert.equal(resolveAntigravityExecutablePath(undefined, options), cli);

  // Fallback to ~/.local/bin/agy
  const localBin = path.join(root, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  const localAgy = path.join(localBin, 'agy');
  fs.writeFileSync(localAgy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  fs.unlinkSync(cli);
  const emptyPathOptions = { platform: 'darwin' as const, searchPath: '', homeDir: root };
  assert.equal(resolveAntigravityExecutablePath(undefined, emptyPathOptions), localAgy);

  // Error on missing
  fs.unlinkSync(localAgy);
  assert.throws(() => resolveAntigravityExecutablePath(undefined, emptyPathOptions), /not found/);
  assert.throws(() => resolveAntigravityExecutablePath(' ', emptyPathOptions), /empty/);
});

test('parses version output correctly', () => {
  assert.deepEqual(parseAntigravityVersion('agy version 1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseAntigravityVersion('antigravity 2.0.1-preview'), [2, 0, 1]);
  assert.equal(parseAntigravityVersion('invalid version'), null);
});

test('resolves config root with default fallback', () => {
  const custom = '/custom/antigravity/home';
  process.env.ANTIGRAVITY_HOME = custom;
  assert.equal(resolveAntigravityConfigRoot(), path.resolve(custom));
  delete process.env.ANTIGRAVITY_HOME;
  const mockHome = '/mock/nonexistent/home';
  assert.equal(
    resolveAntigravityConfigRoot({ homeDir: mockHome }),
    path.resolve(path.join(mockHome, '.gemini', 'antigravity')),
  );
});
