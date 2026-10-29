import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createShellSessionLookup } from './shell-session-lookup.js';

test('Gemini stops resuming a cached session after its transcript is deleted', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcript = path.join(root, 'session.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  const memory = { cliSessionId: 'native-id' };
  const lookup = createShellSessionLookup(() => memory, () => ({ provider: 'gemini', jsonl_path: transcript }));

  assert.equal(lookup('native-id')?.cliSessionId, 'native-id');
  fs.unlinkSync(transcript);
  assert.equal(lookup('native-id')?.cliSessionId, undefined);
  assert.equal(memory.cliSessionId, 'native-id');
  fs.mkdirSync(transcript);
  assert.equal(lookup('native-id')?.cliSessionId, undefined);
});

test('Gemini memory-only mappings without a verified transcript cannot resume', () => {
  const lookup = createShellSessionLookup(() => ({ cliSessionId: 'native-id' }), () => null);
  assert.equal(lookup('app-id', 'gemini')?.cliSessionId, undefined);
});

test('Gemini checks the native ID transcript when the app ID differs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-native-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcript = path.join(root, 'native.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  const lookup = createShellSessionLookup(
    () => ({ cliSessionId: 'native-id' }),
    (id) => id === 'native-id' ? { provider: 'gemini', jsonl_path: transcript } : null,
  );
  assert.equal(lookup('app-id', 'gemini')?.cliSessionId, 'native-id');
  fs.unlinkSync(transcript);
  assert.equal(lookup('app-id', 'gemini')?.cliSessionId, undefined);
});

test('indexed Gemini sessions with absent or legacy paths cannot resume', () => {
  for (const jsonl_path of [null, '/missing/session.jsonl', '/legacy/session.json']) {
    const lookup = createShellSessionLookup(() => null, () => ({ provider: 'gemini', jsonl_path }));
    assert.equal(lookup('native-id')?.cliSessionId, undefined);
  }
});

test('other providers keep memory and indexed resume IDs', () => {
  const cached = createShellSessionLookup(() => ({ cliSessionId: 'cached-id' }), () => ({ provider: 'codex' }));
  assert.equal(cached('app-id')?.cliSessionId, 'cached-id');
  const indexed = createShellSessionLookup(() => null, () => ({ provider: 'antigravity' }));
  assert.equal(indexed('native-id')?.cliSessionId, 'native-id');
  assert.equal(createShellSessionLookup(() => null, () => null)('missing'), null);
});
