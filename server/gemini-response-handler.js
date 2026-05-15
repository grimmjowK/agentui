// Gemini Response Handler - JSON Stream processing
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { stripAnsiSequences } from './utils/url-detection.js';

class GeminiResponseHandler {
  constructor(ws, options = {}) {
    this.ws = ws;
    this.sessionId = options.sessionId || null;
    this.buffer = '';
    this.onContentFragment = options.onContentFragment || null;
    this.onInit = options.onInit || null;
    this.onToolUse = options.onToolUse || null;
    this.onToolResult = options.onToolResult || null;
    this.onNonJsonLine = options.onNonJsonLine || null;
    this.onResult = options.onResult || null;
  }

  setSessionId(id) {
    this.sessionId = id;
  }

  // Process incoming raw data from Gemini stream-json
  processData(data) {
    // PTY 输出先剥离 ANSI 转义序列再缓冲，防止 ANSI 码截断 JSON 行
    this.buffer += stripAnsiSequences(data);

    // PTY 使用 \r\n 换行，统一为 \n
    this.buffer = this.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);
        this.handleEvent(event);
      } catch (err) {
        if (this.onNonJsonLine) {
          this.onNonJsonLine(trimmed);
        }
      }
    }
  }

  handleEvent(event) {
    const sid = this.sessionId;

    if (event.type === 'init') {
      if (this.onInit) {
        this.onInit(event);
      }
      return;
    }

    // Invoke per-type callbacks for session tracking
    if (event.type === 'message' && event.role === 'assistant') {
      const content = event.content || '';
      if (this.onContentFragment && content) {
        this.onContentFragment(content);
      }
    } else if (event.type === 'tool_use' && this.onToolUse) {
      this.onToolUse(event);
    } else if (event.type === 'tool_result' && this.onToolResult) {
      this.onToolResult(event);
    } else if ((event.type === 'result' || (event.type === 'error' && !event.tool_id)) && this.onResult) {
      this.onResult(event);
    }

    // Normalize via adapter and send all resulting messages
    const normalized = sessionsService.normalizeMessage('gemini', event, sid);
    for (const msg of normalized) {
      this.ws.send(msg);
    }
  }

  forceFlush() {
    if (this.buffer.trim()) {
      const cleanBuffer = this.buffer.trim();
      if (cleanBuffer) {
        try {
          const event = JSON.parse(cleanBuffer);
          this.handleEvent(event);
        } catch (err) {
          if (this.onNonJsonLine) {
            this.onNonJsonLine(cleanBuffer);
          }
        }
      }
    }
  }

  destroy() {
    this.buffer = '';
  }
}

export default GeminiResponseHandler;
