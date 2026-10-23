import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type Owner = {
  configRoot: string; threadId?: string | null; projectPath: string;
  userId: string | number | null; owner: 'chat' | 'terminal';
};
type Lease = Owner & { token: string; directory: string; claimedAt: string; serverPid: number; serverStartedAt?: string; pid?: number; startedAt?: string };

/** 单个进程的双重身份校验结论：已确认退出 / 已确认存活 / 无法确认。 */
export type IdentityVerdict = 'confirmed-exited' | 'confirmed-alive' | 'unknown';

/** 锁的只读诊断结果，供 CLI/管理端点展示，不触发任何回收动作。 */
export type OwnershipDiagnosis = {
  directory: string;
  owner: 'chat' | 'terminal' | 'unknown';
  userId: string | number | null;
  claimedAt: string | null;
  ageMs: number | null;
  server: IdentityVerdict;
  child: IdentityVerdict;
};

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

const SELF_PROCESS_STARTED_AT = processIdentity(process.pid) || undefined;

/**
 * 把 processIdentity 的裸结果归纳为三态结论，与 claim() 里的 gone 判定保持同一套语义：
 * - confirmed-exited：PID 已消失（ESRCH），或 PID 被复用成了另一个进程（身份签名与记录不符）。
 * - confirmed-alive：PID 存在且身份签名与记录一致。
 * - unknown：PID 存在但无法取得身份签名，或记录里没有可比对的签名——不足以证明退出。
 */
function identityVerdict(pid: number | undefined, recordedStart: string | undefined): IdentityVerdict {
  const current = processIdentity(pid);
  if (current === null) return 'confirmed-exited';
  if (current && recordedStart && current !== recordedStart) return 'confirmed-exited';
  if (current && recordedStart && current === recordedStart) return 'confirmed-alive';
  return 'unknown';
}

export class CodexOwnership {
  private leases = new Map<string, Lease>();

  status(configRoot: string, threadId: string) {
    const directory = this.directory(configRoot, threadId);
    if (!fs.existsSync(directory)) return { busy: false, owner: null };
    try {
      const record = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
      const serverGone = identityVerdict(record.serverPid, record.serverStartedAt) === 'confirmed-exited';
      const childGone = identityVerdict(record.pid, record.startedAt) === 'confirmed-exited';
      const sameServerOrphan = record.serverPid === process.pid
        && (!record.token || !this.leases.has(record.token))
        && Boolean(record.pid)
        && childGone;
      if ((serverGone && childGone) || sameServerOrphan) return { busy: false, owner: null };
      return { busy: true, owner: record.owner === 'terminal' ? 'terminal' : 'chat' };
    } catch { return { busy: true, owner: 'unknown' }; }
  }

  acquire(owner: Owner): Lease {
    if (owner.userId === null) throw new Error('Codex requires an authenticated user');
    const token = randomUUID();
    const directory = this.directory(owner.configRoot, owner.threadId || `pending:${token}`);
    const lease = { ...owner, token, directory, claimedAt: new Date().toISOString(), serverPid: process.pid, serverStartedAt: SELF_PROCESS_STARTED_AT };
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
      const serverGone = identityVerdict(existing.serverPid, existing.serverStartedAt) === 'confirmed-exited';
      const childGone = identityVerdict(existing.pid, existing.startedAt) === 'confirmed-exited';
      const sameServerOrphan = existing.serverPid === process.pid
        && (!existing.token || !this.leases.has(existing.token))
        && Boolean(existing.pid)
        && childGone;
      if ((serverGone && childGone) || sameServerOrphan) {
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

  /**
   * 只读诊断一个 thread 的锁：输出持有方、声明时间、距今时长，以及服务端进程和子进程各自的
   * 双重身份校验结论。不删除、不修改任何锁。锁不存在时返回 null。
   */
  diagnose(configRoot: string, threadId: string): OwnershipDiagnosis | null {
    const directory = this.directory(configRoot, threadId);
    if (!fs.existsSync(directory)) return null;
    let record: Partial<Lease> = {};
    try { record = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8')); } catch { /* Incomplete claim: treated as unknown identity below. */ }
    const claimedAt = typeof record.claimedAt === 'string' ? record.claimedAt : null;
    return {
      directory,
      owner: record.owner === 'terminal' ? 'terminal' : record.owner === 'chat' ? 'chat' : 'unknown',
      userId: record.userId ?? null,
      claimedAt,
      ageMs: claimedAt ? Date.now() - Date.parse(claimedAt) : null,
      server: identityVerdict(record.serverPid, record.serverStartedAt),
      child: identityVerdict(record.pid, record.startedAt),
    };
  }

  /**
   * 显式强制释放一个异常锁。仅当双重身份校验结论均非 confirmed-alive、且锁龄超过 minAgeMs 时才
   * 允许；释放前再次核对身份，若任一端此时确认存活则中止并报告冲突。
   * 返回 'released' | 'still-alive' | 'not-found'。这是有门槛的管理操作，不在常规 UI 路径暴露。
   */
  forceRelease(configRoot: string, threadId: string, minAgeMs: number): 'released' | 'still-alive' | 'not-found' {
    const diagnosis = this.diagnose(configRoot, threadId);
    if (!diagnosis) return 'not-found';
    if (diagnosis.server === 'confirmed-alive' || diagnosis.child === 'confirmed-alive') return 'still-alive';
    if (diagnosis.ageMs !== null && diagnosis.ageMs < minAgeMs) return 'still-alive';
    // 释放前二次核对，防止诊断与释放之间持有方恢复响应。
    const recheck = this.diagnose(configRoot, threadId);
    if (!recheck) return 'not-found';
    if (recheck.server === 'confirmed-alive' || recheck.child === 'confirmed-alive') return 'still-alive';
    fs.rmSync(diagnosis.directory, { recursive: true, force: true });
    return 'released';
  }
}

export const codexOwnership = new CodexOwnership();
