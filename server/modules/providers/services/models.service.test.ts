import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerModelsService } from './models.service.js';

test('Antigravity model lookup leaves the event loop responsive', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-models-'));
  const executable = path.join(root, 'agy');
  const previousPath = process.env.ANTIGRAVITY_CLI_PATH;
  t.after(() => {
    if (previousPath === undefined) delete process.env.ANTIGRAVITY_CLI_PATH;
    else process.env.ANTIGRAVITY_CLI_PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(executable, `#!${process.execPath}\nsetTimeout(() => process.stdout.write('model-id\\tModel Label\\n'), 150);`, { mode: 0o755 });
  process.env.ANTIGRAVITY_CLI_PATH = executable;

  const resultPromise = providerModelsService.listProviderModels('antigravity', { refresh: true });
  let settled = false;
  void resultPromise.finally(() => { settled = true; });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  const result = await resultPromise;
  assert.equal(result.source, 'live');
  assert.equal(result.models[0].value, 'model-id');
});
