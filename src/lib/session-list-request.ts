export interface SessionListRequestOptions {
  includeRecentMessages?: boolean;
  signal?: AbortSignal;
}

export interface SessionListQuery extends SessionListRequestOptions {
  limit: number;
  offset: number;
  sessionId?: string | null;
  filters?: Record<string, string | undefined>;
  profile?: string | null;
}

export function buildSessionListQuery({ limit, offset, sessionId, filters, profile, includeRecentMessages }: SessionListQuery): string {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (sessionId) params.set('session_id', sessionId);
  if (profile?.trim()) params.set('profile', profile.trim());
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (value && value !== 'all') params.set(key, value);
  }
  if (includeRecentMessages !== undefined) params.set('include_recent_messages', String(includeRecentMessages));
  return params.toString();
}
