import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type Owner = {
  configRoot: string; threadId?: string | null; projectPath: string;
  userId: string | number | null; owner: 'chat' | 'terminal';
};
type Lease = Owner & { token: string; directory: string; serverPid: number; serverStartedAt?: string; pid?: number; startedAt?: string };

/** Disk-backed exclusive claims also fail closed after an unclean server restart.
 * No PID from a previous process is ever killed or assumed safe to reclaim.
 */
function processIdentity(pid: number | undefined): string | null | undefined {
  if (!pid) return undefined;
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? null : undefined; }
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    }
    if (process.platform === 'darwin') return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000 }).trim() || undefined;
  } catch { /* Unknown identity is not proof of exit. */ }
  return undefined;
}

export class CodexOwnership {
  private leases = new Map<string, Lease>();

  status(configRoot: string, threadId: string) {
    const directory = this.directory(configRoot, threadId);
    if (!fs.existsSync(directory)) return { busy: false, owner: null };
    try {
      const record = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
      return { busy: true, owner: record.owner === 'terminal' ? 'terminal' : 'chat' };
    } catch { return { busy: true, owner: 'unknown' }; }
  }

  acquire(owner: Owner): Lease {
    if (owner.userId === null) throw new Error('Codex requires an authenticated user');
    const token = randomUUID();
    const directory = this.directory(owner.configRoot, owner.threadId || `pending:${token}`);
    const lease = { ...owner, token, directory, serverPid: process.pid, serverStartedAt: processIdentity(process.pid) || undefined };
    this.claim(lease);
    this.leases.set(token, lease);
    return lease;
  }

  private directory(configRoot: string, identity: string) {
    const root = fs.realpathSync(configRoot);
    return path.join(root, 'agentui-runs', createHash('sha256').update(identity).digest('hex'));
  }

  private claim(lease: Lease) {
    fs.mkdirSync(path.dirname(lease.directory), { recursive: true, mode: 0o700 });
    try { fs.mkdirSync(lease.directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let existing: Partial<Lease> = {};
      try { existing = JSON.parse(fs.readFileSync(path.join(lease.directory, 'owner.json'), 'utf8')); } catch { /* Incomplete claim remains locked. */ }
      const serverIdentity = processIdentity(existing.serverPid);
      const childIdentity = processIdentity(existing.pid);
      const serverGone = serverIdentity === null || (serverIdentity && existing.serverStartedAt && serverIdentity !== existing.serverStartedAt);
      const childGone = childIdentity === null || (childIdentity && existing.startedAt && childIdentity !== existing.startedAt);
      if (serverGone && childGone) {
        // Serialize recovery, then re-check the generation before moving it.
        fs.mkdirSync(path.join(lease.directory, 'recovering'));
        const current = JSON.parse(fs.readFileSync(path.join(lease.directory, 'owner.json'), 'utf8'));
        if (current.token !== existing.token) {
          fs.rmdirSync(path.join(lease.directory, 'recovering'));
          throw new Error('Codex ownership changed during recovery; retry');
        }
        const recovered = `${lease.directory}.retired-${lease.token}`;
        fs.renameSync(lease.directory, recovered);
        fs.rmSync(recovered, { recursive: true });
        this.claim(lease);
        return;
      }
      const sameUser = String(existing.userId) === String(lease.userId);
      const description = sameUser ? existing.owner || 'previous runtime' : 'another user';
      throw new Error(`Codex session is owned by ${description}. Wait for chat to finish or stop it explicitly; disconnect the terminal before sending in chat. If the server crashed, verify the recorded process has exited before removing ${lease.directory}.`);
    }
    this.persist(lease);
  }

  private persist(lease: Lease) {
    const filename = path.join(lease.directory, 'owner.json');
    fs.writeFileSync(`${filename}.tmp`, JSON.stringify(lease), { mode: 0o600 });
    fs.renameSync(`${filename}.tmp`, filename);
  }

  attach(lease: Lease, pid: number | undefined) {
    lease.pid = pid;
    lease.startedAt = processIdentity(pid) || undefined;
    this.persist(lease);
  }

  bind(lease: Lease, threadId: string) {
    if (lease.threadId === threadId) return;
    const previous = lease.directory;
    const next = { ...lease, threadId, directory: this.directory(lease.configRoot, threadId) };
    this.claim(next);
    Object.assign(lease, next);
    fs.rmSync(previous, { recursive: true });
  }

  /** Call only after OS exit confirmation, or if spawning never happened. */
  release(lease: Lease) {
    if (this.leases.get(lease.token) !== lease) return;
    fs.rmSync(lease.directory, { recursive: true });
    this.leases.delete(lease.token);
  }
}

export const codexOwnership = new CodexOwnership();
