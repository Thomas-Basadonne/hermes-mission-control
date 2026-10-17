/**
 * Decides whether a submit may reuse the runtime session already resumed on the live
 * socket instead of re-running `session.resume` plus the canonical transcript fetch.
 *
 * A runtime id is only valid on the socket it was resumed over: the gateway reaps a
 * session when its transport closes (ws-orphan grace), so any new socket must take the
 * full resume path. Preview mode never reuses, because it resumes explicitly.
 */
const WS_OPEN = 1;

export type LiveRuntimeCheck = {
  socket: { readyState: number } | null;
  /** The socket the current runtime id was resumed (or created) over. */
  resumedOnSocket: unknown;
  liveSessionId: string | null;
  /** Session the caller explicitly asked for, if any. */
  requestedSessionRef: string | null;
  liveSessionKey: string | null;
  preview: boolean;
};

export function canReuseLiveRuntime(check: LiveRuntimeCheck): boolean {
  const { socket, resumedOnSocket, liveSessionId, requestedSessionRef, liveSessionKey, preview } = check;
  if (!socket || socket.readyState !== WS_OPEN) return false;
  if (preview || !liveSessionId) return false;
  if (resumedOnSocket !== socket) return false;
  if (requestedSessionRef && requestedSessionRef !== liveSessionId && requestedSessionRef !== liveSessionKey) return false;
  return true;
}

/** The gateway rejects a prompt whose runtime id died with an earlier socket. */
const STALE_RUNTIME = /4007|session not found/i;

export function isStaleRuntimeError(message: string): boolean {
  return STALE_RUNTIME.test(message);
}
