import type { LLMProvider } from '../../../types/app';
import type { SessionStore } from '../../../stores/useSessionStore';

/** 串流不依附目前顯示的會話；切換畫面不清空其他會話尚未完成的文字。 */
export function createSessionStreamBuffer(
  store: Pick<SessionStore, 'updateStreaming' | 'finalizeStreaming'>,
) {
  type Stream = { text: string; provider: LLMProvider; timer?: ReturnType<typeof setTimeout> };
  const streams = new Map<string, Stream>();

  const flush = (sessionId: string, stream: Stream) => {
    clearTimeout(stream.timer);
    stream.timer = undefined;
    store.updateStreaming(sessionId, stream.text, stream.provider);
  };

  return {
    append(sessionId: string, text: string, provider: LLMProvider) {
      if (!text) return;
      let stream = streams.get(sessionId);
      if (!stream) {
        stream = { text: '', provider };
        streams.set(sessionId, stream);
      }
      stream.text += text;
      if (stream.timer === undefined) {
        const pending = stream;
        stream.timer = setTimeout(() => flush(sessionId, pending), 100);
      }
    },
    finish(sessionId: string, messageId?: string) {
      const stream = streams.get(sessionId);
      if (stream) {
        flush(sessionId, stream);
        streams.delete(sessionId);
      }
      store.finalizeStreaming(sessionId, messageId);
    },
    dispose() {
      // 卸載時保留已收到的內容並取消計時器，不虛構完成事件。
      for (const [sessionId, stream] of streams) flush(sessionId, stream);
      streams.clear();
    },
  };
}
