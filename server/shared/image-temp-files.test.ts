import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cleanupTempFiles, handleImages } from './image-temp-files.js';

const SAMPLE_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('handleImages saves temp image files, appends paths to prompt, and cleanupTempFiles removes them', async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentui-img-test-'));
  try {
    const { modifiedCommand, tempImagePaths, tempDir } = await handleImages(
      '請看這張圖',
      [{ name: 'error.png', data: SAMPLE_PNG_DATA_URL }],
      workDir,
    );

    assert.equal(tempImagePaths.length, 1);
    assert.ok(tempDir);
    assert.match(modifiedCommand, /^請看這張圖\n\n\[Images provided at the following paths:\]\n1\. /);

    const stat = await fs.stat(tempImagePaths[0]);
    assert.ok(stat.isFile());

    await cleanupTempFiles(tempImagePaths, tempDir);
    await assert.rejects(() => fs.stat(tempImagePaths[0]));
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

test('handleImages supports image-only messages when prompt text is empty', async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentui-img-empty-'));
  try {
    const { modifiedCommand, tempImagePaths, tempDir } = await handleImages(
      '',
      [{ name: 'only.png', data: SAMPLE_PNG_DATA_URL }],
      workDir,
    );

    assert.equal(tempImagePaths.length, 1);
    assert.match(modifiedCommand, /^\[Images provided at the following paths:\]\n1\. /);
    await cleanupTempFiles(tempImagePaths, tempDir);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});
