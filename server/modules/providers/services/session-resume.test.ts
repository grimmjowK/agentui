import assert from 'node:assert/strict';
import test from 'node:test';

import { buildResumeCommand } from './session-resume.js';

test('buildResumeCommand 按 provider 拼命令并安全引用路径', () => {
  assert.equal(buildResumeCommand('claude', 'abc-123', '/Users/me/my proj', 'darwin'), "cd '/Users/me/my proj' && claude --resume abc-123");
  assert.equal(buildResumeCommand('codex', 'abc', "/tmp/it's", 'linux'), "cd '/tmp/it'\\''s' && codex resume abc");
  assert.equal(buildResumeCommand('antigravity', 'abc', null, 'darwin'), 'agy --conversation abc');
  assert.equal(buildResumeCommand('gemini', 'abc', "C:\\a'b", 'win32'), "Set-Location 'C:\\a''b'; gemini --resume abc");
  // 带 shell 元字符的 id、未知 provider 一律不给命令
  assert.equal(buildResumeCommand('claude', 'abc;rm -rf ~', '/p', 'darwin'), null);
  assert.equal(buildResumeCommand('unknown', 'abc', '/p', 'darwin'), null);
});
