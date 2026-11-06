import assert from 'node:assert/strict';
import test from 'node:test';

import { getProjectSessions, mapProjectSessions } from './projectSessions';

const project = {
  sessionsByProvider: {
    claude: [{ id: 'c1' }],
    codex: [{ id: 'x1' }, { id: 'x2' }],
  },
};

test('getProjectSessions 不指定 provider 時回傳全部並帶上 __provider', () => {
  assert.deepEqual(getProjectSessions(project).map((s) => [s.id, s.__provider]), [
    ['c1', 'claude'], ['x1', 'codex'], ['x2', 'codex'],
  ]);
});

test('getProjectSessions 指定 provider 與缺欄位', () => {
  assert.deepEqual(getProjectSessions(project, 'codex').map((s) => s.id), ['x1', 'x2']);
  assert.deepEqual(getProjectSessions(project, 'antigravity'), []);
  assert.deepEqual(getProjectSessions({}), []);
});

test('mapProjectSessions 對每個 provider 套用轉換', () => {
  const next = mapProjectSessions(project.sessionsByProvider, (sessions) => sessions.filter((s) => s.id !== 'x1'));
  assert.deepEqual(next.codex?.map((s) => s.id), ['x2']);
  assert.deepEqual(next.cursor, []);
});
