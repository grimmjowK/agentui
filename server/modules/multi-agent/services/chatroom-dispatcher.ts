/**
 * 聊天室調度器（multi-agent-workspace design D6）。
 * 每聊天室同時只跑一個回合；忙碌時使用者訊息排隊，本輪結束後依序處理。
 */
import { multiAgentsDb, type MemberSession } from '@/modules/database/index.js';
import { sendToUser } from '@/modules/websocket/index.js';

import {
  MEMBER_DEFAULT_PERMISSION_MODE,
  mentionedMemberIds,
  resolveMentions,
  type ChatMember,
  type ChatMessage,
  type ChatroomDef,
  type MultiAgent,
} from '../../../../shared/multiAgent.js';
import { PROVIDER_INFO } from '../../../../shared/providers.js';

import { AgentCall, takeRecentWithin, truncateCodePoints, type RuntimeResolver } from './agent-call.js';

export const MEMBER_TIMEOUT_MS = 120_000;
export const REPLAY_MAX_MESSAGES = 50;
export const REPLAY_MAX_CHARS = 20_000;

type Publish = (userId: string | number, event: unknown) => void;
type Agent = MultiAgent & { userId: number };

export type ChatroomDispatcherDeps = {
  resolveRuntime?: RuntimeResolver;
  publish?: Publish;
  timeoutMs?: number;
};

type ActiveTurn = {
  /** 刪除時停止派發下一則排隊訊息；一般停止回合不影響佇列。 */
  drain?: boolean;
  turnId: string;
  stopping: boolean;
  call: AgentCall | null;
  done: Promise<void>;
};

const codePoints = (text: string) => [...text].length;

type SeenSettings = NonNullable<MemberSession['seen']>;

function seenOf(member: ChatMember, def: ChatroomDef): SeenSettings {
  return {
    name: member.name,
    persona: member.persona,
    rulesText: def.rules.text,
    maxReplyChars: def.rules.maxReplyChars,
    allowAiMentions: def.rules.allowAiMentions,
  };
}

/** 與 session 上次看到的設定比對，產生「設定已更新」提示（不重建 session）。改回原值則沒有提示。 */
export function settingNotes(session: MemberSession, member: ChatMember, def: ChatroomDef): string[] {
  const notes: string[] = [];
  const seen = session.seen;
  const now = seenOf(member, def);
  if (seen) {
    if (seen.name !== now.name) notes.push(`你的名稱已改為「${now.name}」`);
    if (seen.persona !== now.persona) notes.push(`你的人設已更新為：${now.persona}`);
    if (seen.rulesText !== now.rulesText) {
      notes.push(now.rulesText ? `群規已更新：${now.rulesText}` : '群規已清除');
    }
    if (seen.maxReplyChars !== now.maxReplyChars) notes.push(`每則回覆上限改為 ${now.maxReplyChars} 字`);
    if (seen.allowAiMentions !== now.allowAiMentions) {
      notes.push(now.allowAiMentions ? '現在可以 @ 其他成員請其接話' : '現在不可以 @ 其他成員');
    }
  }
  if (session.truncatedAt) notes.push(`你上次的回覆在第 ${session.truncatedAt} 字被截斷`);
  return notes;
}

/** session 是否必須重建：換 provider，或同 provider 換模型但不支援跨模型續接 */
export function needsNewSession(session: MemberSession | undefined, member: ChatMember): boolean {
  if (!session) return true;
  if (session.provider !== member.provider) return true;
  if (session.model !== member.model && !PROVIDER_INFO[member.provider].capabilities.resumeAcrossModels) return true;
  return false;
}

function formatTranscript(messages: ChatMessage[]): string {
  return messages.map((m) => {
    const who = m.authorKind === 'user' ? '使用者' : m.authorKind === 'system' ? '系統' : (m.author?.name ?? '成員');
    return `[${who}] ${m.content}`;
  }).join('\n');
}

export function buildMemberPrompt(input: {
  member: ChatMember;
  def: ChatroomDef;
  history: ChatMessage[];
  historyTruncated: boolean;
  isNewSession: boolean;
  notes: string[];
}): string {
  const { member, def, history, historyTruncated, isNewSession, notes } = input;
  const others = def.members.filter((m) => m.id !== member.id).map((m) => m.name);
  const rules = [
    `每則回覆不超過 ${def.rules.maxReplyChars} 字，超出會被截斷。`,
    def.rules.allowAiMentions && others.length
      ? `如需其他成員接話，可以用 @名稱 提及（${others.join('、')}）；沒有必要時不要提及。`
      : '不要 @ 其他成員，也不要替其他成員發言。',
    '只代表你自己的角色發言，避免重複他人已說過的內容與客套話。',
  ];
  const parts: string[] = [];
  if (isNewSession) {
    parts.push(
      `你在一個群聊中扮演「${member.name}」。`,
      member.persona ? `## 你的人設\n${member.persona}` : '',
      others.length ? `群聊中的其他成員：${others.join('、')}。` : '',
      def.rules.text ? `## 群規\n${def.rules.text}` : '',
      `## 發言限制\n${rules.map((r) => `- ${r}`).join('\n')}`,
    );
  }
  if (notes.length) parts.push(`## 設定更新\n${notes.map((n) => `- ${n}`).join('\n')}`);
  if (history.length) {
    parts.push(`## ${isNewSession ? '最近的群聊紀錄' : '上次發言後的新訊息'}${historyTruncated ? '（較早內容已省略）' : ''}\n${formatTranscript(history)}`);
  }
  parts.push(`請以「${member.name}」的身份回覆。`);
  return parts.filter(Boolean).join('\n\n');
}

export class ChatroomDispatcher {
  private readonly active = new Map<string, ActiveTurn>();
  private readonly deleting = new Set<string>();
  private readonly publish: Publish;
  private readonly resolveRuntime?: RuntimeResolver;
  private readonly timeoutMs: number;

  constructor(deps: ChatroomDispatcherDeps = {}) {
    this.publish = deps.publish ?? sendToUser;
    this.resolveRuntime = deps.resolveRuntime;
    this.timeoutMs = deps.timeoutMs ?? MEMBER_TIMEOUT_MS;
  }

  isBusy(multiAgentId: string): boolean {
    return this.active.has(multiAgentId);
  }

  isDeleting(multiAgentId: string): boolean {
    return this.deleting.has(multiAgentId);
  }

  markDeleting(multiAgentId: string): void {
    this.deleting.add(multiAgentId);
  }

  clearDeleting(multiAgentId: string): void {
    this.deleting.delete(multiAgentId);
  }

  /** 送出使用者訊息。忙碌時排隊；否則立即開始回合。 */
  send(agent: Agent, content: string): ChatMessage {
    if (this.deleting.has(agent.id)) {
      throw new Error('Chatroom is deleting');
    }
    const message = multiAgentsDb.appendMessage({
      multiAgentId: agent.id, turnId: null, authorKind: 'user', memberId: null, author: null,
      content, status: 'queued', finishReason: null,
    });
    multiAgentsDb.touch(agent.id);
    this.emitMessage(agent, message);
    this.pump(agent.id);
    return message;
  }

  /** 停止指定回合；回合已結束或不符時回傳 false（無副作用）。 */
  async stop(multiAgentId: string, turnId: string): Promise<boolean> {
    const turn = this.active.get(multiAgentId);
    if (!turn || turn.turnId !== turnId) return false;
    if (!turn.stopping) {
      turn.stopping = true;
      multiAgentsDb.updateTurn(turnId, 'stopping');
      await turn.call?.abort();
    }
    return true;
  }

  async stopAndWait(multiAgentId: string): Promise<void> {
    const turn = this.active.get(multiAgentId);
    if (!turn) return;
    turn.drain = true;
    await this.stop(multiAgentId, turn.turnId);
    await turn.done;
  }

  /** 等待目前回合與所有排隊訊息處理完（測試用） */
  async idle(multiAgentId: string): Promise<void> {
    while (this.active.has(multiAgentId)) await this.active.get(multiAgentId)!.done;
  }

  /** 若空閒則處理下一則排隊訊息 */
  pump(multiAgentId: string): void {
    if (this.active.has(multiAgentId) || this.deleting.has(multiAgentId)) return;
    const agent = multiAgentsDb.getById(multiAgentId);
    const next = agent?.definition ? multiAgentsDb.nextQueuedMessage(multiAgentId) : null;
    if (!agent || !next) return;
    const def = agent.definition as ChatroomDef;
    const turnRow = multiAgentsDb.createTurn(agent.id, next.id, def);
    const turn: ActiveTurn = { turnId: turnRow.id, stopping: false, call: null, done: Promise.resolve() };
    this.active.set(agent.id, turn);
    turn.done = this.runTurn(agent, def, next, turn)
      .catch((error) => console.error('[multi-agent] turn failed', error))
      .finally(() => {
        this.active.delete(agent.id);
        if (!turn.drain) this.pump(agent.id);
      });
  }

  private async runTurn(agent: Agent, def: ChatroomDef, trigger: ChatMessage, turn: ActiveTurn): Promise<void> {
    const promoted = multiAgentsDb.promoteQueuedMessage(agent.id, trigger.id, turn.turnId);
    if (!promoted) {
      // 排隊期間被使用者取消
      multiAgentsDb.updateTurn(turn.turnId, 'stopped', true);
      return;
    }
    this.emitMessage(agent, promoted);
    this.emitTurn(agent, turn.turnId, 'running');

    const queue = resolveMentions(promoted.content, def.members, def.rules.unmentionedBehavior);
    let replies = 0;
    let limitHit = false;

    while (queue.length && !turn.stopping) {
      if (replies >= def.rules.maxAiRepliesPerTurn) { limitHit = true; break; }
      const nextId = queue.shift();
      const member = def.members.find((m) => m.id === nextId);
      if (!member) continue;
      replies += 1;
      const reply = await this.memberSpeak(agent, def, member, turn);
      if (turn.stopping || !reply || !def.rules.allowAiMentions || reply.finishReason) continue;
      const mentioned = mentionedMemberIds(reply.content, def.members);
      const targets = mentioned === 'all' ? def.members.map((m) => m.id) : mentioned;
      for (const id of targets) if (id !== member.id) queue.push(id);
    }
    if (!turn.stopping && (limitHit || (queue.length && replies >= def.rules.maxAiRepliesPerTurn))) {
      const notice = multiAgentsDb.appendMessage({
        multiAgentId: agent.id, turnId: turn.turnId, authorKind: 'system', memberId: null, author: null,
        content: '已達本輪發言上限', status: 'done', finishReason: null,
      });
      this.emitMessage(agent, notice);
    }
    const status = turn.stopping ? 'stopped' : 'completed';
    multiAgentsDb.updateTurn(turn.turnId, status, true);
    multiAgentsDb.touch(agent.id);
    this.emitTurn(agent, turn.turnId, status);
  }

  private async memberSpeak(agent: Agent, def: ChatroomDef, member: ChatMember, turn: ActiveTurn): Promise<ChatMessage | null> {
    const sessions = multiAgentsDb.getMemberSessions(agent.id);
    const saved = sessions[member.id];
    const rebuild = needsNewSession(saved, member);
    const session = rebuild ? undefined : saved;

    const notes = session ? settingNotes(session, member, def) : [];
    const historyAll = session
      ? multiAgentsDb.listMessagesAfter(agent.id, session.lastDeliveredSeq)
      : multiAgentsDb.listMessagesAfter(agent.id, 0);
    const replay = takeRecentWithin(historyAll, (m) => codePoints(m.content), REPLAY_MAX_MESSAGES, REPLAY_MAX_CHARS);

    const message = multiAgentsDb.appendMessage({
      multiAgentId: agent.id, turnId: turn.turnId, authorKind: 'member', memberId: member.id,
      author: { name: member.name, provider: member.provider, model: member.model, color: member.color },
      content: '', status: 'streaming', finishReason: null,
    });
    this.emitMessage(agent, message);

    const run = async (sessionId: string | null, isNew: boolean, history: ChatMessage[], truncated: boolean) => {
      let content = '';
      let finishReason = null as string | null;
      let lastEmit = 0;
      const call = new AgentCall({
        userId: agent.userId,
        provider: member.provider,
        model: member.model,
        permissionMode: member.permissionMode ?? MEMBER_DEFAULT_PERMISSION_MODE[member.provider],
        cwd: agent.workspacePath,
        sessionId,
        prompt: buildMemberPrompt({ member, def, history, historyTruncated: truncated, isNewSession: isNew, notes }),
        timeoutMs: this.timeoutMs,
        onOutput: (text) => {
          if (finishReason) return;
          const clipped = truncateCodePoints(text, def.rules.maxReplyChars);
          content = clipped ?? text;
          if (clipped !== null) {
            finishReason = 'length';
            void call.abort();
          }
          const t = Date.now();
          if (clipped !== null || t - lastEmit > 150) {
            lastEmit = t;
            this.emitDelta(agent, turn.turnId, message.id, member.id, content);
          }
        },
      }, this.resolveRuntime);
      turn.call = call;
      const result = await call.run();
      turn.call = null;
      return { result, content: finishReason ? content : (truncateCodePoints(result.text, def.rules.maxReplyChars) ?? result.text), finishReason };
    };

    let { result, content, finishReason }: { result: Awaited<ReturnType<AgentCall['run']>>; content: string; finishReason: string | null } = await run(session?.sessionId ?? null, !session, replay.items, replay.truncated);
    // 續接失敗：清除 session 重建後重試一次
    if (session && result.status === 'failed' && !turn.stopping) {
      const full = takeRecentWithin(multiAgentsDb.listMessagesAfter(agent.id, 0), (m) => codePoints(m.content), REPLAY_MAX_MESSAGES, REPLAY_MAX_CHARS);
      ({ result, content, finishReason } = await run(null, true, full.items, full.truncated));
    }

    const stopped = turn.stopping && !finishReason;
    if (!finishReason) {
      if (result.status === 'timeout') finishReason = 'timeout';
      else if (stopped || result.status === 'aborted') finishReason = 'stopped';
      else if (result.status === 'failed') finishReason = 'error';
    }
    const isError = finishReason === 'error' || finishReason === 'timeout';
    const finalContent = isError && !content ? (result.error ?? '回覆失敗') : content;
    multiAgentsDb.updateMessage(message.id, {
      content: finalContent,
      status: isError ? 'error' : 'done',
      finishReason,
    });

    // 更新 session：只有拿到 sessionId 才保存；完整成功才推進游標；若成員在回合中已被移除則不再寫回
    if (result.sessionId && !this.deleting.has(agent.id)) {
      const succeeded = result.status === 'succeeded' || finishReason === 'length';
      multiAgentsDb.upsertMemberSession(agent.id, member.id, {
        provider: member.provider,
        model: member.model,
        sessionId: result.sessionId,
        // 成功時歷史已送達且自己的回覆在 session 內，游標推進到這則；失敗則保留舊游標下次重送
        lastDeliveredSeq: succeeded ? message.seq : (session?.lastDeliveredSeq ?? 0),
        // 成功送達本輪提示後才記為已看過；失敗時保留舊的，下次仍會提示
        seen: succeeded ? seenOf(member, def) : (session?.seen ?? seenOf(member, def)),
        truncatedAt: finishReason === 'length' ? def.rules.maxReplyChars : succeeded ? undefined : session?.truncatedAt,
      });
    }

    const final = multiAgentsDb.getMessage(agent.id, message.id);
    if (final) this.emitMessage(agent, final);
    return final;
  }

  /** 成員被移除時清掉其 session */
  pruneMemberSessions(multiAgentId: string, def: ChatroomDef): void {
    multiAgentsDb.pruneMemberSessions(multiAgentId, def.members.map((m) => m.id));
  }

  private emitMessage(agent: Agent, message: ChatMessage): void {
    this.publish(agent.userId, { type: 'multi-agent-message', multiAgentId: agent.id, kind: 'upsert', message });
  }

  private emitDelta(agent: Agent, turnId: string, messageId: string, memberId: string, content: string): void {
    this.publish(agent.userId, { type: 'multi-agent-message', multiAgentId: agent.id, kind: 'delta', turnId, messageId, memberId, content });
  }

  private emitTurn(agent: Agent, turnId: string, status: string): void {
    this.publish(agent.userId, { type: 'multi-agent-turn', multiAgentId: agent.id, turnId, status });
  }
}

export const chatroomDispatcher = new ChatroomDispatcher();
