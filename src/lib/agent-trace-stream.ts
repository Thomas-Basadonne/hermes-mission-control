import { openChatSyncStream } from './chat-sync-stream';

// Live agent trace over fetch streaming (MC-FIX-10). Same reason as the chat
// sync stream: EventSource cannot send headers, so the token used to travel
// in ?access_token=. The local sidecar now gets `Authorization: Bearer`; the
// official Hermes API candidate keeps its cookie auth and never sees the
// Mission Control token.

export type TraceStreamParams = {
  sessionId?: string | null;
  profile?: string | null;
  handoffId?: string | null;
  limit: number;
  interval: number;
  compact: boolean;
};

export type TraceStreamCandidate = { url: string; accessToken?: string; credentials?: RequestCredentials };

export function traceStreamCandidates({ localBase, officialBase, accessToken, ...params }: TraceStreamParams & {
  localBase: string;
  officialBase: string;
  accessToken?: string;
}): TraceStreamCandidate[] {
  const search = new URLSearchParams();
  if (params.sessionId) search.set('session_id', params.sessionId);
  if (params.profile) search.set('profile', params.profile);
  if (params.handoffId) search.set('handoff_id', params.handoffId);
  search.set('limit', String(params.limit));
  search.set('interval', String(params.interval));
  if (params.compact) search.set('compact', '1');
  const path = `/mission-control/agents/trace/stream?${search.toString()}`;
  const local = `${localBase.replace(/\/$/, '')}${path}`;
  const official = `${officialBase.replace(/\/$/, '')}${path}`;
  const candidates: TraceStreamCandidate[] = [{ url: local, accessToken: accessToken || undefined, credentials: 'include' }];
  if (official !== local) candidates.push({ url: official, credentials: 'include' });
  return candidates;
}

export function connectAgentTraceStream({ candidates, acceptNamedTrace, onFrame, onExhausted, fetchImpl }: {
  candidates: TraceStreamCandidate[];
  /** Server capability: frames are sent as `event: trace`. */
  acceptNamedTrace: boolean;
  onFrame: (data: string) => void;
  /** Every candidate failed or ended: the caller falls back to polling. */
  onExhausted: () => void;
  fetchImpl?: typeof fetch;
}) {
  let disposed = false;
  let current: { close(): void } | null = null;

  const connect = (index: number) => {
    if (disposed) return;
    if (index >= candidates.length) {
      onExhausted();
      return;
    }
    const candidate = candidates[index];
    current = openChatSyncStream({
      url: candidate.url,
      accessToken: candidate.accessToken,
      credentials: candidate.credentials,
      fetchImpl,
      onEvent: (name, data) => {
        if (name === 'message' || (acceptNamedTrace && name === 'trace')) onFrame(data);
      },
      onError: () => {
        current = null;
        connect(index + 1);
      },
    });
  };

  connect(0);
  return {
    close() {
      disposed = true;
      current?.close();
      current = null;
    },
  };
}
