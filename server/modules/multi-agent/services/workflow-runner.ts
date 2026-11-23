/**
 * 工作流執行器（multi-agent-workspace design D5）。
 * 後端記憶體中按 DAG 執行，就緒節點並行（上限 3），狀態寫回 run 並推送給擁有者。
 */
import { multiAgentsDb, sessionMessagesDb } from '@/modules/database/index.js';
import { sendToUser } from '@/modules/websocket/index.js';
import { workflowSessions, type LiveWorkflowSession, type WorkflowContinueResult } from '@/shared/workflow-session-registry.js';

import { isApprovalNode, type MultiAgent, type NodeRunStatus, type WorkflowDef, type WorkflowNode, type WorkflowRun } from '../../../../shared/multiAgent.js';
import { getDefaultPermissionMode } from '../../../../shared/providers.js';

import { AgentCall, truncateCodePoints, type RuntimeResolver } from './agent-call.js';

export const MAX_PARALLEL_NODES = 3;
export const MAX_CONCURRENT_RUNS = 5;
/** 每個上游輸出併入下游提示的上限（code points） */
export const UPSTREAM_OUTPUT_LIMIT = 6000;

type Publish = (userId: string | number, event: unknown) => void;

export type WorkflowRunnerDeps = {
  resolveRuntime?: RuntimeResolver;
  publish?: Publish;
};

export type ConfirmDecision = 'approve' | 'rework' | 'reject';
type InternalConfirmDecision = ConfirmDecision | 'reset';

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
    !node.dependsOn.length && startInput
      ? `## 本次執行的輸入\n${startInput}\n\n> 注意：上方「本次執行的輸入」為使用者本次指定的目標，優先級高於下方任務中的預設範圍或狀態篩選條件（例如指定了特定工單號時，直接處理該工單，不因狀態篩選而跳過）。`
      : '',
    upstream.length ? `${upstream.join('\n\n')}\n` : '',
    `## 你的任務\n${node.instruction}`,
    '完成後直接給出這一步的結果，供後續步驟使用。',
  ].filter(Boolean).join('\n\n');
}

/** 收集 roots 及其所有傳遞下游節點 ID */
function collectDownstream(def: WorkflowDef, roots: Iterable<string>): Set<string> {
  const set = new Set<string>(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of def.nodes) {
      if (!set.has(n.id) && n.dependsOn.some((d) => set.has(d))) {
        set.add(n.id);
        changed = true;
      }
    }
  }
  return set;
}

/** 找出人工確認節點對應的上游 Agent 節點（若隔著其他確認節點則繼續往上找） */
function upstreamAgentNodes(def: WorkflowDef, node: WorkflowNode): WorkflowNode[] {
  const result: WorkflowNode[] = [];
  const visited = new Set<string>();
  const walk = (ids: string[]) => {
    for (const id of ids) {
      if (visited.has(id)) continue;
      visited.add(id);
      const dep = def.nodes.find((n) => n.id === id);
      if (!dep) continue;
      if (isApprovalNode(dep)) walk(dep.dependsOn);
      else result.push(dep);
    }
  };
  walk(node.dependsOn);
  return result;
}

/** 重置指定節點集合為 pending（保留 sessionId 以便續接對話），並將其餘 skipped 節點恢復為 pending */
function resetNodesForRerun(run: WorkflowRun, toReset: Set<string>, keepOutputIds?: Set<string>): void {
  for (const [id, prev] of Object.entries(run.nodeStates)) {
    if (toReset.has(id)) {
      run.nodeStates[id] = {
        state: 'pending',
        progress: 0,
        ...(prev?.sessionId ? { sessionId: prev.sessionId } : {}),
        ...(keepOutputIds?.has(id) && prev?.output ? { output: prev.output } : {}),
      };
    } else if (prev.state === 'skipped') {
      run.nodeStates[id] = { state: 'pending', progress: 0 };
    }
  }
}

/** 從節點會話訊息紀錄同步最後一則非空 assistant 文字到 state.output */
function syncLatestAssistantOutput(state: NodeRunStatus): void {
  if (!state.sessionId) return;
  const rows = sessionMessagesDb.list(state.sessionId, { afterSeq: null, limit: null }).messages;
  for (let i = rows.length - 1; i >= 0; i--) {
    const msg = rows[i];
    if (msg.kind === 'text' && msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim()) {
      state.output = msg.content;
      return;
    }
  }
}

/** waiting_input 的出口：送出新指示續接、以目前輸出完成、標記失敗 */
type InputDecision = { kind: 'resume'; text: string; clientId: string } | { kind: 'complete' } | { kind: 'fail' };

class ActiveRun {
  readonly calls = new Map<string, AgentCall>();
  /** 等待人工確認的節點：resolve 後 runner 繼續 */
  readonly confirmations = new Map<string, (decision: InternalConfirmDecision, note: string) => void>();
  /** 使用者中斷後等待指示的節點（waiting_input） */
  readonly inputs = new Map<string, (decision: InputDecision) => void>();
  /** 退回重做或對話頁追問時，指定某節點下一輪要續接的提示詞 */
  readonly followUps = new Map<string, { prompt: string; clientId?: string }>();
  stopping = false;
  private wakeResolve: (() => void) | null = null;
  constructor(readonly run: WorkflowRun, readonly agent: MultiAgent & { userId: number }) {}

  waitWake(): Promise<void> {
    return new Promise((resolve) => { this.wakeResolve = resolve; });
  }

  wake(): void {
    const resolve = this.wakeResolve;
    this.wakeResolve = null;
    resolve?.();
  }
}

export class WorkflowRunner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly publish: Publish;
  private readonly resolveRuntime?: RuntimeResolver;

  constructor(deps: WorkflowRunnerDeps = {}) {
    this.publish = deps.publish ?? sendToUser;
    this.resolveRuntime = deps.resolveRuntime;
    workflowSessions.onContinue((sessionId, userId, text, clientId) =>
      this.continueFromNodeSession(sessionId, userId, text, clientId));
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
    for (const resolve of [...active.confirmations.values()]) resolve('reject', '');
    for (const resolve of [...active.inputs.values()]) resolve({ kind: 'fail' });
    active.wake();
    await Promise.all([...active.calls.values()].map((call) => call.abort()));
    return true;
  }

  isActive(multiAgentId: string): boolean {
    return [...this.active.values()].some((a) => a.agent.id === multiAgentId);
  }

  activeCount(multiAgentId: string): number {
    return [...this.active.values()].filter((a) => a.agent.id === multiAgentId).length;
  }

  async stopByAgent(multiAgentId: string): Promise<void> {
    await Promise.all([...this.active.values()].filter((a) => a.agent.id === multiAgentId).map((a) => this.stop(a.run.id)));
  }

  private async execute(active: ActiveRun): Promise<void> {
    const { run } = active;
    const def = run.definition;
    const running = new Map<string, Promise<void>>();

    const ready = () => def.nodes.filter((n) => !running.has(n.id)
      && run.nodeStates[n.id].state === 'pending'
      && n.dependsOn.every((d) => run.nodeStates[d].state === 'succeeded'));

    while (!active.stopping) {
      for (const node of ready()) {
        if (running.size >= MAX_PARALLEL_NODES) break;
        const task = this.runNode(active, node).finally(() => running.delete(node.id));
        running.set(node.id, task);
      }
      if (!running.size) break;
      await Promise.race([...running.values(), active.waitWake()]);
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

    const followUp = active.followUps.get(node.id);
    active.followUps.delete(node.id);
    const prompt = followUp
      ? followUp.prompt
      : buildNodePrompt(node, run.definition, run.nodeStates, run.startInput);

    let lastEmit = 0;
    let userInterrupted = false;
    let waiting: ((decision: InputDecision) => void) | null = null;
    const call = new AgentCall({
      userId: agent.userId,
      provider: node.provider!,
      model: node.model!,
      permissionMode: node.permissionMode ?? getDefaultPermissionMode(node.provider!),
      cwd: agent.workspacePath,
      sessionId: state.sessionId ?? null,
      prompt,
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
    if (state.sessionId) workflowSessions.register(state.sessionId, live);
    active.calls.set(node.id, call);

    try {
      let result = await call.run(prompt, followUp?.clientId);
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
        delete state.error;
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

  /** 人工確認節點：暫停執行，等使用者核准／退回重做／駁回；停止時直接略過。 */
  private awaitConfirmation(active: ActiveRun, node: WorkflowNode): Promise<void> {
    const state = active.run.nodeStates[node.id];
    state.state = 'waiting_confirmation';
    state.progress = 50;
    state.output = node.instruction;
    this.persist(active);
    this.emitNode(active, node.id);
    return new Promise((resolve) => {
      active.confirmations.set(node.id, (decision, note) => {
        active.confirmations.delete(node.id);
        if (decision === 'reset') {
          resolve();
          return;
        }
        if (decision === 'rework') {
          const targets = upstreamAgentNodes(active.run.definition, node);
          const prompt = [
            `人工確認節點「${node.title}」退回重做，請根據以下修改意見重新調整，並直接輸出更新後的完整結果供後續步驟使用：`,
            note || '請重新檢查並修正上一步的輸出。',
          ].join('\n\n');
          const targetIds = new Set(targets.map((t) => t.id));
          for (const id of targetIds) active.followUps.set(id, { prompt });
          resetNodesForRerun(active.run, collectDownstream(active.run.definition, targetIds), targetIds);
          this.persist(active);
          this.emitRun(active);
          resolve();
          active.wake();
          return;
        }
        const approved = decision === 'approve';
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

  /** 使用者在畫布上核准／退回重做／駁回人工確認節點。找不到等待中的節點時回傳 false。 */
  confirm(runId: string, nodeId: string, decision: boolean | ConfirmDecision, note = ''): boolean {
    const active = this.active.get(runId);
    const resolve = active?.confirmations.get(nodeId);
    if (!active || !resolve) return false;
    const kind: ConfirmDecision = typeof decision === 'boolean' ? (decision ? 'approve' : 'reject') : decision;
    if (kind === 'rework') {
      const node = active.run.definition.nodes.find((n) => n.id === nodeId);
      if (!node || !upstreamAgentNodes(active.run.definition, node).length) return false;
    }
    resolve(kind, note.trim());
    return true;
  }

  /**
   * 使用者在已完成／失敗的節點對話頁送出新訊息：
   * 以同一 sessionId 續接該節點，完成後更新該節點輸出並自動往後流轉下游（含人工確認節點）。
   */
  continueFromNodeSession(
    sessionId: string,
    userId: string | number | null,
    text: string,
    clientId: string,
  ): WorkflowContinueResult {
    const entry = multiAgentsDb.getWorkflowSession(sessionId);
    if (!entry || userId === null || userId === undefined || String(entry.userId) !== String(userId)) {
      return 'not_workflow';
    }
    const prompt = text.trim();
    if (!prompt) return 'not_workflow';

    const active = this.active.get(entry.runId);
    if (active) {
      if (active.stopping) return 'busy';
      const downstream = collectDownstream(active.run.definition, [entry.nodeId]);
      for (const id of downstream) {
        if (active.calls.has(id) && !active.inputs.has(id)) return 'busy';
      }
      for (const id of downstream) {
        active.confirmations.get(id)?.('reset', '');
      }
      active.followUps.set(entry.nodeId, { prompt, clientId });
      resetNodesForRerun(active.run, downstream, new Set([entry.nodeId]));
      active.run.nodeStates[entry.nodeId].sessionId = sessionId;
      this.persist(active);
      this.emitRun(active);
      active.wake();
      return 'continued';
    }

    if (this.activeCount(entry.multiAgentId) >= MAX_CONCURRENT_RUNS) return 'busy';
    const run = multiAgentsDb.getRun(entry.multiAgentId, entry.runId);
    const agent = multiAgentsDb.getById(entry.multiAgentId);
    if (!run || !agent || !run.definition.nodes.some((n) => n.id === entry.nodeId)) return 'not_workflow';

    const downstream = collectDownstream(run.definition, [entry.nodeId]);
    resetNodesForRerun(run, downstream, new Set([entry.nodeId]));
    run.nodeStates[entry.nodeId].sessionId = sessionId;
    run.status = 'running';
    run.finishedAt = null;

    const reopened = new ActiveRun(run, agent);
    reopened.followUps.set(entry.nodeId, { prompt, clientId });
    this.active.set(run.id, reopened);
    this.persist(reopened);
    this.emitRun(reopened);
    void this.execute(reopened).finally(() => this.active.delete(run.id));
    return 'continued';
  }

  /**
   * 將某節點會話中最新一則 AI 回覆同步為節點輸出，並重置其下游節點繼續往後流轉。
   */
  continueDownstream(multiAgentId: string, runId: string, nodeId: string): boolean {
    const active = this.active.get(runId);
    if (active) {
      if (active.agent.id !== multiAgentId || active.stopping || active.calls.has(nodeId)) return false;
      const state = active.run.nodeStates[nodeId];
      if (!state) return false;
      syncLatestAssistantOutput(state);
      state.state = 'succeeded';
      state.progress = 100;
      delete state.error;
      const downstream = collectDownstream(active.run.definition, [nodeId]);
      downstream.delete(nodeId);
      for (const id of downstream) {
        if (active.calls.has(id) && !active.inputs.has(id)) return false;
      }
      for (const id of downstream) active.confirmations.get(id)?.('reset', '');
      resetNodesForRerun(active.run, downstream);
      this.persist(active);
      this.emitRun(active);
      active.wake();
      return true;
    }

    if (this.activeCount(multiAgentId) >= MAX_CONCURRENT_RUNS) return false;
    const run = multiAgentsDb.getRun(multiAgentId, runId);
    const agent = multiAgentsDb.getById(multiAgentId);
    if (!run || !agent) return false;
    const state = run.nodeStates[nodeId];
    if (!state) return false;
    syncLatestAssistantOutput(state);
    state.state = 'succeeded';
    state.progress = 100;
    delete state.error;
    const downstream = collectDownstream(run.definition, [nodeId]);
    downstream.delete(nodeId);
    resetNodesForRerun(run, downstream);
    if (!downstream.size) {
      multiAgentsDb.updateRun(run.id, { nodeStates: run.nodeStates });
      return true;
    }
    run.status = 'running';
    run.finishedAt = null;
    const reopened = new ActiveRun(run, agent);
    this.active.set(run.id, reopened);
    this.persist(reopened);
    this.emitRun(reopened);
    void this.execute(reopened).finally(() => this.active.delete(run.id));
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
