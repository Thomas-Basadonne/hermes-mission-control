import type { ChatMessage, ChatModelIdentity } from './chat-protocol';
import { extractSessionModel } from './chat-protocol';
import { buildLastChatClaimPayload, normalizeServerLastChat, type ServerLastChat } from './chat-bootstrap';

const STORAGE_KEY = 'mission-control-chat-drawer-v1';

export type PersistedChat = {
  sessionId: string | null;
  sessionKey: string | null;
  sessionTitle: string | null;
  profile: string | null;
  modelIdentity: ChatModelIdentity | null;
  messages: ChatMessage[];
  updatedAt: number;
  revision: number | null;
};

const emptyPersistedChat = (): PersistedChat => ({
  sessionId: null,
  sessionKey: null,
  sessionTitle: null,
  profile: null,
  modelIdentity: null,
  messages: [],
  updatedAt: 0,
  revision: null,
});

export function readPersistedChat(): PersistedChat {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyPersistedChat();
    const parsed = JSON.parse(raw) as Partial<PersistedChat>;
    return {
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      sessionKey: typeof parsed.sessionKey === 'string' ? parsed.sessionKey : null,
      sessionTitle: typeof parsed.sessionTitle === 'string' && parsed.sessionTitle.trim() ? parsed.sessionTitle.trim() : null,
      profile: typeof parsed.profile === 'string' && parsed.profile.trim() ? parsed.profile.trim() : null,
      modelIdentity: extractSessionModel(parsed.modelIdentity),
      messages: Array.isArray(parsed.messages) ? (parsed.messages as ChatMessage[]) : [],
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      revision: typeof parsed.revision === 'number' && Number.isInteger(parsed.revision) && parsed.revision > 0
        ? parsed.revision
        : null,
    };
  } catch {
    return emptyPersistedChat();
  }
}

/** Restore only the exact session/profile's display cache. It is NOT durable readiness. */
export function selectCachedChatMessages(
  cached: PersistedChat,
  reference: string | null | undefined,
  profile: string | null | undefined,
): ChatMessage[] {
  const owner = (value: string | null | undefined) => value?.trim() || 'default';
  if (!reference || (reference !== cached.sessionId && reference !== cached.sessionKey)
    || owner(profile) !== owner(cached.profile)) return [];
  if (!cached.messages.every((message) => message && typeof message.id === 'string'
    && typeof message.text === 'string' && ['user', 'assistant', 'tool', 'system'].includes(message.role))) return [];
  return cached.messages;
}

/** Drop display-only cache rows even when replay cloned/settled their objects.
 * Keep rows with genuinely new live content; status/source alone are not content.
 */
export function dropUnchangedCachedMessages(current: ChatMessage[], cached: ChatMessage[]): ChatMessage[] {
  if (cached.length === 0) return current;
  const contentKey = (message: ChatMessage) => JSON.stringify(Object.fromEntries(
    Object.entries(message).filter(([key]) => key !== 'status' && key !== 'source').sort(([a], [b]) => a.localeCompare(b)),
  ));
  const cachedById = new Map(cached.map((message) => [message.id, message]));
  return current.filter((message) => {
    const prior = cachedById.get(message.id);
    return !prior || (message !== prior && contentKey(message) !== contentKey(prior));
  });
}

/** Coalesce stream updates without serializing every delta or starving continuous streams. */
export function createChatPersistenceScheduler(
  setTimer: (callback: () => void, delay: number) => number = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer: (handle: number) => void = (handle) => window.clearTimeout(handle),
) {
  let timer: number | null = null;
  let pending: (() => void) | null = null;
  const flush = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    const write = pending;
    pending = null;
    write?.();
  };
  return {
    schedule(write: () => void) {
      pending = write;
      if (timer === null) timer = setTimer(flush, 1000);
    },
    flush,
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = null;
    },
  };
}

export function persistChat(
  sessionId: string | null,
  sessionKey: string | null,
  sessionTitle: string | null,
  modelIdentity: ChatModelIdentity | null,
  messages: ChatMessage[],
  revision: number | null = null,
  profile: string | null = null,
) {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sessionId,
        sessionKey,
        sessionTitle: sessionTitle?.trim() || null,
        profile: profile?.trim() || null,
        modelIdentity,
        messages,
        updatedAt: Date.now(),
        revision,
      }),
    );
  } catch {
    // Storage is best effort; the live session remains authoritative.
  }
}

export async function persistChatTitle(
  sessionId: string,
  sessionKey: string | null,
  title: string,
  storedToken: string,
): Promise<void> {
  const normalizedTitle = title.trim().slice(0, 120);
  if (!normalizedTitle || (!sessionId.trim() && !sessionKey?.trim())) return;
  try {
    await fetch('/api/local/chat/title', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(storedToken ? { Authorization: `Bearer ${storedToken}` } : {}),
      },
      cache: 'no-store',
      body: JSON.stringify({ sessionId, sessionKey, title: normalizedTitle }),
    });
  } catch {
    // The gateway/runtime remains authoritative; MC metadata is best effort.
  }
}

export type LastChatClaimResult = {
  accepted: boolean;
  conflict: boolean;
  lastChat: ServerLastChat | null;
};

function parseLastChatPayload(value: unknown): ServerLastChat | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { lastChat?: unknown };
  return normalizeServerLastChat(record.lastChat);
}

/**
 * Claim the shared pointer with CAS. This remains best-effort for transport
 * failures, but a 409 is returned to the caller so it can adopt the canonical
 * pointer instead of silently continuing with stale local state.
 */
export async function syncLastChatToServer(
  sessionId: string | null,
  sessionKey: string | null,
  sessionTitle: string | null,
  modelIdentity: ChatModelIdentity | null,
  storedToken: string,
  expectedRevision: number | null = null,
  profile?: string | null,
): Promise<LastChatClaimResult> {
  if (!sessionId || !sessionId.trim()) return { accepted: false, conflict: false, lastChat: null };
  try {
    const body = buildLastChatClaimPayload(sessionId, sessionKey, sessionTitle, modelIdentity, expectedRevision, profile);
    const res = await fetch('/api/local/chat/last', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(storedToken ? { Authorization: `Bearer ${storedToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => null);
    const lastChat = parseLastChatPayload(payload);
    return { accepted: res.ok, conflict: res.status === 409, lastChat };
  } catch {
    return { accepted: false, conflict: false, lastChat: null };
  }
}

export async function fetchServerLastChat(storedToken: string, signal?: AbortSignal): Promise<ServerLastChat | null> {
  try {
    const res = await fetch('/api/local/chat/last', {
      headers: storedToken ? { Authorization: `Bearer ${storedToken}` } : {},
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const data = await res.json() as { lastChat?: unknown };
    return parseLastChatPayload(data);
  } catch {
    return null;
  }
}
