import { chatSyncStreamUrl } from './chat-sync';

// Chat sync fan-out over fetch streaming. EventSource cannot send headers, so
// the old transport put the bearer token in the URL (?access_token=), where it
// ends up in proxy/access logs. This transport sends `Authorization: Bearer`
// and parses the same text/event-stream frames incrementally.

export type SseEventHandler = (name: string, data: string) => void;

/** Incremental text/event-stream parser; `push` accepts arbitrary chunk splits. */
export function createSseParser(onEvent: SseEventHandler) {
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length > 0) onEvent(eventName || 'message', dataLines.join('\n'));
    eventName = '';
    dataLines = [];
  };

  const processLine = (line: string) => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    // `id` and `retry` are not used by the chat sync relay.
  };

  return {
    push(text: string) {
      buffer += text;
      let newline = buffer.search(/\r\n|\r|\n/);
      while (newline !== -1) {
        // A lone trailing '\r' may be the first half of '\r\n': wait for more.
        if (buffer[newline] === '\r' && newline === buffer.length - 1) break;
        const width = buffer.startsWith('\r\n', newline) ? 2 : 1;
        processLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + width);
        newline = buffer.search(/\r\n|\r|\n/);
      }
    },
  };
}

export type ChatSyncStreamError = { status?: number; error?: unknown };

export type ChatSyncStreamOptions = {
  url: string;
  /** Sent as `Authorization: Bearer`; omit for cookie-authenticated endpoints. */
  accessToken?: string;
  credentials?: RequestCredentials;
  onEvent: SseEventHandler;
  /** Called once when the stream fails or ends on its own; never after close(). */
  onError: (error: ChatSyncStreamError) => void;
  fetchImpl?: typeof fetch;
};

export function openChatSyncStream({ url, accessToken, credentials, onEvent, onError, fetchImpl = fetch }: ChatSyncStreamOptions) {
  const controller = new AbortController();
  let closed = false;
  const fail = (error: ChatSyncStreamError) => {
    if (closed || controller.signal.aborted) return;
    closed = true;
    onError(error);
  };

  void (async () => {
    let response: Response;
    try {
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      response = await fetchImpl(url, {
        headers,
        cache: 'no-store',
        ...(credentials ? { credentials } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      fail({ error });
      return;
    }
    if (!response.ok || !response.body) {
      fail({ status: response.status });
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser((name, data) => {
      if (!closed && !controller.signal.aborted) onEvent(name, data);
    });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      fail({ status: response.status }); // server ended the stream
    } catch (error) {
      fail({ error });
    }
  })();

  return {
    close() {
      closed = true;
      controller.abort();
    },
  };
}

export type ChatSyncRelayOptions = {
  sessionId: string;
  accessToken: string;
  /** Latest applied relay_seq, read again on every (re)connect. */
  getSince: () => number | undefined;
  /** `since` is the watermark this connection was opened with. */
  onEvent: (name: string, data: string, since: number | undefined) => void;
  reconnectDelayMs?: number;
  fetchImpl?: typeof fetch;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (timer: number) => void;
};

/** Keeps one authenticated chat sync stream open, reconnecting with `since`. */
export function createChatSyncRelay({
  sessionId,
  accessToken,
  getSince,
  onEvent,
  reconnectDelayMs = 1000,
  fetchImpl,
  setTimer = (fn, ms) => window.setTimeout(fn, ms),
  clearTimer = (timer) => window.clearTimeout(timer),
}: ChatSyncRelayOptions) {
  let disposed = false;
  let stream: { close(): void } | null = null;
  let timer: number | null = null;

  const connect = () => {
    timer = null;
    if (disposed) return;
    const since = getSince();
    stream = openChatSyncStream({
      url: chatSyncStreamUrl(sessionId, since),
      accessToken,
      fetchImpl,
      onEvent: (name, data) => onEvent(name, data, since),
      onError: () => {
        stream = null;
        if (disposed) return;
        timer = setTimer(connect, reconnectDelayMs);
      },
    });
  };

  connect();
  return {
    close() {
      disposed = true;
      stream?.close();
      stream = null;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
