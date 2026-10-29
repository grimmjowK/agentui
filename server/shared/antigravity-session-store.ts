import fs from 'node:fs';
import { copyFile, mkdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

const SAFE_SESSION_ID = /^[a-zA-Z0-9_.-]+$/;

type EnsureAntigravitySessionOptions = {
  homeDir?: string;
  cliRoot?: string;
};

function conversationDbPath(root: string, sessionId: string): string {
  return path.join(root, 'conversations', `${sessionId}.db`);
}

/**
 * Older Antigravity builds store conversation trajectories beside the desktop
 * app data, while `agy` only resumes trajectories from its CLI app-data store.
 * Copy a consistent SQLite snapshot into the CLI store without touching the
 * source conversation.
 */
export async function ensureAntigravitySessionInCliStore(
  sessionId: string,
  options: EnsureAntigravitySessionOptions = {},
): Promise<boolean> {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error('Invalid Antigravity conversation ID.');
  }

  const homeDir = options.homeDir ?? os.homedir();
  const cliRoot = options.cliRoot ?? path.join(homeDir, '.gemini', 'antigravity-cli');
  const destinationPath = conversationDbPath(cliRoot, sessionId);
  if (fs.existsSync(destinationPath)) {
    return false;
  }

  const sourceRoots = [
    process.env.ANTIGRAVITY_HOME,
    path.join(homeDir, '.gemini', 'antigravity'),
    path.join(homeDir, '.gemini', 'antigravity-cli'),
  ]
    .filter((root): root is string => Boolean(root))
    .map((root) => path.resolve(root));

  const sourcePath = Array.from(new Set(sourceRoots))
    .filter((root) => root !== path.resolve(cliRoot))
    .map((root) => conversationDbPath(root, sessionId))
    .find((candidate) => fs.existsSync(candidate));

  if (!sourcePath) {
    return false;
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.${randomUUID()}.tmp`;
  let database: Database.Database | undefined;

  try {
    database = new Database(sourcePath, { readonly: true, fileMustExist: true });
    await database.backup(temporaryPath);
    database.close();
    database = undefined;

    try {
      await copyFile(temporaryPath, destinationPath, fs.constants.COPYFILE_EXCL);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      throw error;
    }
  } finally {
    database?.close();
    await unlink(temporaryPath).catch(() => {});
  }
}
