/**
 * 工作流執行器（multi-agent-workspace design D5）。
 * 後端記憶體中按 DAG 執行，就緒節點並行（上限 3），狀態寫回 run 並推送給擁有者。
 */
import { multiAgentsDb } from '@/modules/database/index.js';
import { sendToUser } from '@/modules/websocket/index.js';

import { isApprovalNode, type MultiAgent, type NodeRunStatus, type WorkflowDef, type WorkflowNode, type WorkflowRun } from '../../../../shared/multiAgent.js';
import { getDefaultPermissionMode } from '../../../../shared/providers.js';
import { workflowSessions, type LiveWorkflowSession } from '@/shared/workflow-session-registry.js';

import { AgentCall, truncateCodePoints, type RuntimeResolver } from './agent-call.js';

export const MAX_PARALLEL_NODES = 3;
/** 每個上游輸出併入下游提示的上限（code points） */
export const UPSTREAM_OUTPUT_LIMIT = 6000;

type Publish = (userId: string | number, event: unknown) => void;

export type WorkflowRunnerDeps = {
  resolveRuntime?: RuntimeResolver;
  publish?: Publish;
};

/** 階段式／漸近式進度：啟動 10%，每個事件往 90% 逼近 */
const nextProgress = (current: number) => Math.min(90, current + (90 - current) * 0.08);

export function buildNodePrompt(node: WorkflowNode, def: WorkflowDef, states: Record<string, NodeRunStatus>, startInput: string | null = null): string {
  const upstream = node.dependsOn.map((id) => {
    const dep = def.nodes.find((n) => n.id === id);
    const output = states[id]?.output ?? '';
    const clipped = truncateCodePoints(output, UPSTREAM_OUTPUT_LIMIT) ?? output;
    return `### 上游步驟「${dep?.title ?? id}」的輸出\n${clipped}`;
  });
  return [
    `你正在執行工作流中的一個步驟：「${node.title}」。`,
    // 啟動時輸入只給沒有依賴的入口節點，下游經由上游輸出取得
    !node.dependsOn.length && startInput ? `## 本次執行的輸入\n${startInput}` : '',
    upstream.length ? `${upstream.join('\n\n')}\n` : '',
    `## 你的任務\n${node.instruction}`,
    '完成後直接給出這一步的結果，供後續步驟使用。',
  ].filter(Boolean).join('\n\n');
}

/** waiting_input 的出口：送出新指示續接、以目前輸出完成、標記失敗 */
type InputDecision = { kind: 'resume'; text: string; clientId: string } | { kind: 'complete' } | { kind: 'fail' };

class ActiveRun {
  readonly calls = new Map<string, AgentCall>();
  /** 等待人工確認的節點：resolve 後 runner 繼續（true=核准） */
  readonly confirmations = new Map<string, (approved: boolean, note: string) => void>();
  /** 使用者中斷後等待指示的節點（waiting_input） */
  readonly inputs = new Map<string, (decision: InputDecision) => void>();
  stopping = false;
  constructor(readonly run: WorkflowRun, readonly agent: MultiAgent & { userId: number }) {}
}

export class WorkflowRunner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly publish: Publish;
  private readonly resolveRuntime?: RuntimeResolver;

  constructor(deps: WorkflowRunnerDeps = {}) {
    this.publish = deps.publish ?? sendToUser;
    this.resolveRuntime = deps.resolveRuntime;
  }

  /** 開始執行。已有執行中 run 時回傳 null。回傳的 promise 只代表已建立，執行在背景進行。 */
  start(agent: MultiAgent & { userId: number }, startInput: string | null = null): { run: WorkflowRun; done: Promise<void> } | null {
    const def = agent.definition as WorkflowDef;
    const initial: Record<string, NodeRunStatus> = Object.fromEntries(
      def.nodes.map((n) => [n.id, { state: 'pending', progress: 0 }]),
    );
    const run = multiAgentsDb.createRun(agent, initial, startInput?.trim() || null);
    if (!run) return null;
    const active = new ActiveRun(run, agent);
    this.active.set(run.id, active);
    this.emitRun(active);
    const done = this.execute(active).finally(() => this.active.delete(run.id));
    return { run, done };
  }

  /** 停止。回傳 false 表示該 run 不在執行中。 */
  async stop(runId: string): Promise<boolean> {
    const active = this.active.get(runId);
    if (!active) return false;
    if (active.stopping) return true;
    active.stopping = true;
    active.run.status = 'stopping';
    for (const state of Object.values(active.run.nodeStates)) {
      if (state.state === 'pending') state.state = 'skipped';
    }
    this.persist(active);
    this.emitRun(active);
    for (const resolve of [...active.confirmations.values()]) resolve(false, '');
    for (const resolve of [...active.inputs.values()]) resolve({ kind: 'fail' });
    await Promise.all([...active.calls.values()].map((call) => call.abort()));
    return true;
  }

  isActive(multiAgentId: string): boolean {
    return [...this.active.values()].some((a) => a.agent.id === multiAgentId);
  }

  async stopByAgent(multiAgentId: string): Promise<void> {
    await Promise.all([...this.active.values()].filter((a) => a.agent.id === multiAgentId).map((a) => this.stop(a.run.id)));
  }

  private async execute(active: ActiveRun): Promise<void> {
    const { run, agent } = active;
    const def = run.definition;
    const running = new Map<string, Promise<void>>();

    const ready = () => def.nodes.filter((n) => run.nodeStates[n.id].state === 'pending'
      && n.dependsOn.every((d) => run.nodeStates[d].state === 'succeeded'));

    while (!active.stopping) {
      for (const node of ready()) {
        if (running.size >= MAX_PARALLEL_NODES) break;
        const task = this.runNode(active, node).finally(() => running.delete(node.id));
        running.set(node.id, task);
      }
      if (!running.size) break;
      await Promise.race(running.values());
    }
    await Promise.all(running.values());

    // 未能執行的節點（上游失敗）標記略過
    for (const state of Object.values(run.nodeStates)) {
      if (state.state === 'pending') state.state = 'skipped';
    }
    const states = Object.values(run.nodeStates);
    run.status = active.stopping ? 'stopped'
      : states.every((s) => s.state === 'succeeded') ? 'succeeded' : 'failed';
    run.finishedAt = new Date().toISOString();
    this.persist(active, true);
    this.emitRun(active);
  }

  private async runNode(active: ActiveRun, node: WorkflowNode): Promise<void> {
    const { run, agent } = active;
    const state = run.nodeStates[node.id];
    if (isApprovalNode(node)) {
      await this.awaitConfirmation(active, node);
      return;
    }
    state.state = 'running';
    state.progress = 10;
    this.emitNode(active, node.id);
    this.persist(active);

    let lastEmit = 0;
    let userInterrupted = false;
    let waiting: ((decision: InputDecision) => void) | null = null;
    const call = new AgentCall({
      userId: agent.userId,
      provider: node.provider!,
      model: node.model!,
      permissionMode: node.permissionMode ?? getDefaultPermissionMode(node.provider!),
      cwd: agent.workspacePath,
      sessionId: null,
      prompt: buildNodePrompt(node, run.definition, run.nodeStates, run.startInput),
      persist: true,
      onEvent: () => {
        if (state.state !== 'running') return;
        state.progress = nextProgress(state.progress);
        const t = Date.now();
        if (t - lastEmit > 300) { lastEmit = t; this.emitNode(active, node.id); }
      },
      onOutput: (text) => { state.output = text; },
      onSessionId: (sessionId) => {
        // 先登記再讓事件繼續：同步器第一次索引這個會話時它已在側邊欄排除名單
        multiAgentsDb.addWorkflowSession({ sessionId, multiAgentId: agent.id, runId: run.id, nodeId: node.id, userId: agent.userId });
        if (state.sessionId && state.sessionId !== sessionId) workflowSessions.unregister(state.sessionId, live);
        state.sessionId = sessionId;
        workflowSessions.register(sessionId, live);
        this.emitNode(active, node.id);
      },
      onApprovalChange: (waitingApproval) => {
        if (state.state === 'running' || state.state === 'waiting_approval') {
          state.state = waitingApproval ? 'waiting_approval' : 'running';
          this.emitNode(active, node.id);
        }
      },
    }, this.resolveRuntime);
    const live: LiveWorkflowSession = {
      multiAgentId: agent.id,
      runId: run.id,
      nodeId: node.id,
      nodeTitle: node.title,
      userId: agent.userId,
      state: () => (waiting ? 'waiting_input' : 'running'),
      markUserInterrupted: () => { userInterrupted = true; },
      resume: (text, clientId) => {
        if (!waiting) return false;
        waiting({ kind: 'resume', text, clientId });
        return true;
      },
    };
    active.calls.set(node.id, call);

    try {
      let result = await call.run();
      // 聊天頁中斷：不判定失敗，等使用者的下一步（design D4）
      while (!active.stopping && result.status === 'aborted' && userInterrupted) {
        userInterrupted = false;
        state.state = 'waiting_input';
        state.output = result.text;
        this.persist(active);
        this.emitNode(active, node.id);
        const decision = await new Promise<InputDecision>((resolve) => {
          waiting = resolve;
          active.inputs.set(node.id, resolve);
        });
        waiting = null;
        active.inputs.delete(node.id);
        if (decision.kind !== 'resume' || active.stopping) {
          result = decision.kind === 'complete' && !active.stopping
            ? { ...result, status: 'succeeded', error: null }
            : { ...result, status: 'failed', error: active.stopping ? 'stopped' : 'rejected' };
          break;
        }
        state.state = 'running';
        this.emitNode(active, node.id);
        result = await call.run(decision.text, decision.clientId);
      }
      state.output = result.text;
      if (active.stopping || result.status === 'aborted') {
        state.state = 'failed';
        state.error = 'stopped';
      } else if (result.status === 'succeeded') {
        state.state = 'succeeded';
        state.progress = 100;
      } else {
        state.state = 'failed';
        state.error = result.error ?? result.status;
      }
    } finally {
      active.calls.delete(node.id);
      if (state.sessionId) workflowSessions.unregister(state.sessionId, live);
    }
    this.persist(active);
    this.emitNode(active, node.id);
  }

  /** waiting_input 的畫布操作：以目前輸出完成或標記失敗。節點不在等待時回傳 false。 */
  finishWaitingInput(runId: string, nodeId: string, outcome: 'complete' | 'fail'): boolean {
    const resolve = this.active.get(runId)?.inputs.get(nodeId);
    if (!resolve) return false;
    resolve({ kind: outcome });
    return true;
  }

  /** 人工確認節點：暫停執行，等使用者核准／駁回；停止時直接略過。 */
  private awaitConfirmation(active: ActiveRun, node: WorkflowNode): Promise<void> {
    const state = active.run.nodeStates[node.id];
    state.state = 'waiting_confirmation';
    state.progress = 50;
    state.output = node.instruction;
    this.persist(active);
    this.emitNode(active, node.id);
    return new Promise((resolve) => {
      active.confirmations.set(node.id, (approved, note) => {
        active.confirmations.delete(node.id);
        state.state = approved ? 'succeeded' : 'failed';
        state.progress = 100;
        // 下游只看得到直接上游：把確認前的上游輸出原樣傳下去，再附上使用者備註
        const upstream = node.dependsOn.map((id) => active.run.nodeStates[id]?.output ?? '').filter(Boolean);
        state.output = [...upstream, note ? `## 人工確認備註\n${note}` : '## 人工確認\n已核准，無備註'].join('\n\n');
        if (!approved) state.error = 'rejected';
        this.persist(active);
        this.emitNode(active, node.id);
        resolve();
      });
    });
  }

  /** 使用者在畫布上核准／駁回人工確認節點。找不到等待中的節點時回傳 false。 */
  confirm(runId: string, nodeId: string, approved: boolean, note = ''): boolean {
    const active = this.active.get(runId);
    const resolve = active?.confirmations.get(nodeId);
    if (!active || !resolve) return false;
    resolve(approved, note.trim());
    return true;
  }

  private persist(active: ActiveRun, finished = false): void {
    multiAgentsDb.updateRun(active.run.id, { status: active.run.status, nodeStates: active.run.nodeStates, finished });
  }

  private emitRun(active: ActiveRun): void {
    this.publish(active.agent.userId, {
      type: 'multi-agent-run',
      multiAgentId: active.agent.id,
      runId: active.run.id,
      status: active.run.status,
      nodeStates: structuredClone(active.run.nodeStates),
    });
  }

  private emitNode(active: ActiveRun, nodeId: string): void {
    this.publish(active.agent.userId, {
      type: 'multi-agent-run',
      multiAgentId: active.agent.id,
      runId: active.run.id,
      status: active.run.status,
      nodeId,
      node: { ...active.run.nodeStates[nodeId] },
    });
  }
}

export const workflowRunner = new WorkflowRunner();
