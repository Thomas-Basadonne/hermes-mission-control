import type { ChatModelProviderOption } from './chat-protocol';

export type ModelSelection = { provider: string; model: string };
export type ModelRow = ModelSelection & { providerName: string; disabled: boolean; warning?: string; recent: boolean };

export function rememberModel(recent: ModelSelection[], selected: ModelSelection): ModelSelection[] {
  return [selected, ...recent.filter((row) => row.provider !== selected.provider || row.model !== selected.model)].slice(0, 5);
}

export function modelRows(providers: ChatModelProviderOption[], query: string, recent: ModelSelection[], selectedProvider = ''): ModelRow[] {
  const needle = query.trim().toLowerCase();
  const rows = providers.filter((provider) => !selectedProvider || provider.slug === selectedProvider).flatMap((provider) => provider.models.filter((model) =>
    `${provider.name} ${provider.slug} ${model}`.toLowerCase().includes(needle)
  ).map((model) => ({ provider: provider.slug, providerName: provider.name, model, disabled: provider.authenticated === false, warning: provider.warning, recent: false })));
  const ordered: ModelRow[] = [];
  if (!needle) for (const selection of recent) {
    const row = rows.find((item) => item.provider === selection.provider && item.model === selection.model && !item.disabled);
    if (row && !ordered.includes(row)) { row.recent = true; ordered.push(row); }
  }
  return [...ordered, ...rows.filter((row) => !ordered.includes(row))];
}

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export function parseReasoningChoices(raw: unknown): { value: string; label: string }[] {
  const items = raw && typeof raw === 'object' && 'items' in raw && Array.isArray(raw.items) ? raw.items : [];
  const seen = new Set<string>();
  return items.flatMap((item) => {
    const value = typeof item?.text === 'string' ? item.text.trim() : '';
    if (!EFFORTS.has(value) || seen.has(value)) return [];
    seen.add(value);
    return [{ value, label: typeof item.meta === 'string' && item.meta ? item.meta : value }];
  });
}

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export async function setSessionReasoning(value: string, sessionId: string, request: Request): Promise<string> {
  if (!sessionId) throw new Error('Session required for reasoning selection.');
  if (!EFFORTS.has(value)) throw new Error('Invalid reasoning effort.');
  await request('config.set', { key: 'reasoning', value, scope: 'session', session_id: sessionId });
  const verified = await request('config.get', { key: 'reasoning', session_id: sessionId });
  const actual = verified && typeof verified === 'object' && 'value' in verified ? String(verified.value) : '';
  if (actual !== value) throw new Error('Reasoning change was not confirmed by the gateway.');
  return actual;
}
