// Load environment variables from .env before other imports execute.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findAppRoot, getModuleDir } from './utils/runtime-paths.js';

const __dirname = getModuleDir(import.meta.url);
// Resolve the repo/app root via the nearest /server folder so this file keeps finding the
// same top-level .env file from both /server/load-env.js and /dist-server/server/load-env.js.
const APP_ROOT = findAppRoot(__dirname);

try {
  const envPath = path.join(APP_ROOT, '.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      const [key, ...valueParts] = trimmedLine.split('=');
      if (key && valueParts.length > 0 && !process.env[key]) {
        process.env[key] = valueParts.join('=').trim();
      }
    }
  });
} catch (e) {
  console.log('No .env file found or error reading it:', e.message);
}

// Keep the default database in a stable user-level location so rebuilding dist-server
// never changes where the backend stores auth.db when DATABASE_PATH is not set explicitly.
const DEFAULT_DATABASE_PATH = path.join(os.homedir(), '.cloudcli', 'auth.db');

if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = DEFAULT_DATABASE_PATH;
}

// Ensure standard user-level CLI install directories are present on PATH so newly installed
// CLIs (agy, cursor-agent, npm global packages) are immediately discoverable without restarting.
{
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const extraBinDirs = process.platform === 'win32'
    ? [
        path.join(localAppData, 'agy', 'bin'),
        path.join(localAppData, 'cursor-agent'),
        path.join(appData, 'npm'),
        path.join(home, '.local', 'bin'),
      ]
    : [
        path.join(home, '.local', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        path.join(home, '.gemini', 'antigravity', 'bin'),
      ];
  const currentEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const seen = new Set(currentEntries.map((entry) => (process.platform === 'win32' ? entry.toLowerCase() : entry)));
  for (const dir of extraBinDirs) {
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    if (!seen.has(key)) {
      seen.add(key);
      currentEntries.push(dir);
    }
  }
  process.env.PATH = currentEntries.join(path.delimiter);
}
