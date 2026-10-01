import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChatModelPicker } from './ChatModelPicker';
import type { ChatModelIdentity, ChatModelSwitchResult } from '../lib/chat-protocol';
import { parseReasoningChoices } from '../lib/chat-status-runtime';

type Props = {
  identity: ChatModelIdentity | null;
  sessionId: string | null;
  profile?: string;
  request: <T,>(method: string, params?: Record<string, unknown>) => Promise<T>;
  modelOpen: boolean;
  refresh: boolean;
  onOpenModel: () => void;
  onCloseModel: () => void;
  onModelChange: (model: string, provider: string, confirm?: boolean) => Promise<ChatModelSwitchResult>;
  onReasoningChange: (value: string, expectedSessionId?: string) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  running: boolean;
  disabled: boolean;
};

export function ChatStatusRuntime({ identity, sessionId, profile, request, modelOpen, refresh, onOpenModel, onCloseModel, onModelChange, onReasoningChange, onBusyChange, running, disabled }: Props) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const effortRef = useRef<HTMLButtonElement>(null);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [choices, setChoices] = useState<{ value: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ sessionId: string; value: string } | null>(null);
  const queued = pending?.sessionId === sessionId ? pending : null;
  const effort = queued?.value || identity?.reasoningEffort || '—';

  useEffect(() => { setPending(null); setReasoningOpen(false); setError(null); onCloseModel(); }, [sessionId, onCloseModel]);
  useEffect(() => { if (modelOpen) { setReasoningOpen(false); setError(null); } }, [modelOpen]);
  useEffect(() => {
    if (!modelOpen && !reasoningOpen) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) { setReasoningOpen(false); onCloseModel(); }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      (modelOpen ? modelRef : effortRef).current?.focus();
      setReasoningOpen(false); onCloseModel();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [modelOpen, reasoningOpen, onCloseModel]);

  const apply = async (value: string, targetSession: string) => {
    setBusy(true); onBusyChange(true); setError(null);
    try { await onReasoningChange(value, targetSession); if (sessionRef.current === targetSession) { setReasoningOpen(false); effortRef.current?.focus(); } }
    catch (err) { if (sessionRef.current === targetSession) setError(err instanceof Error ? err.message : 'Could not change reasoning.'); }
    finally { setBusy(false); onBusyChange(false); }
  };
  useEffect(() => {
    if (running || disabled || busy || !queued) return;
    setPending(null);
    void apply(queued.value, queued.sessionId);
  }, [running, disabled, busy, queued, onReasoningChange]);

  const openReasoning = async () => {
    onCloseModel(); setError(null);
    if (reasoningOpen) { setReasoningOpen(false); return; }
    setReasoningOpen(true); setLoading(true);
    const targetSession = sessionId;
    try {
      const result = await request('complete.slash', { text: '/reasoning ', ...(sessionId ? { session_id: sessionId } : {}) });
      if (sessionRef.current !== targetSession) return;
      const next = parseReasoningChoices(result);
      setChoices(next);
      if (!next.length) setError('Reasoning options unavailable. Use /reasoning in chat.');
    } catch (err) { if (sessionRef.current === targetSession) setError(err instanceof Error ? err.message : 'Could not load reasoning options.'); }
    finally { if (sessionRef.current === targetSession) setLoading(false); }
  };

  const footer = rootRef.current?.closest('.chat-runtime-footer');
  const panel = modelOpen || reasoningOpen || error ? (
    <div ref={panelRef} className={`chat-status-popover ${reasoningOpen ? 'is-reasoning' : ''}`} role="dialog" aria-label={modelOpen ? 'Choose provider and model' : 'Choose reasoning effort'}>
      {running ? <p className="chat-status-picker-notice">Changes apply next turn.</p> : null}
      {modelOpen ? <ChatModelPicker request={request} sessionId={sessionId} profile={profile} currentModel={identity?.model} currentProvider={identity?.provider} initialRefresh={refresh} onSelect={onModelChange} onClose={() => { onCloseModel(); modelRef.current?.focus(); }} /> : <>
        <header className="chat-reasoning-picker-head"><strong>Reasoning</strong><button type="button" onClick={() => { setReasoningOpen(false); setError(null); effortRef.current?.focus(); }}>Close</button></header>
        <p className="chat-reasoning-picker-note">Hermes effort; provider mapping may vary.</p>
        {loading ? <p>Loading options…</p> : <div className="chat-reasoning-options">{choices.map((choice) => <button key={choice.value} type="button" title={choice.label} aria-pressed={effort === choice.value} disabled={busy || !sessionId} onClick={() => { if (!sessionId) return; if (running) { setPending({ sessionId, value: choice.value }); setReasoningOpen(false); effortRef.current?.focus(); } else void apply(choice.value, sessionId); }}>{choice.value === 'none' ? 'Off' : choice.value}</button>)}</div>}
        {error ? <p className="chat-model-picker-error" role="alert">{error}</p> : null}
      </>}
    </div>
  ) : null;

  return <span className="chat-status-line-model-group" ref={rootRef}>
    <button ref={modelRef} className="chat-status-line-model chat-status-control" type="button" aria-label="Choose provider and model" aria-haspopup="dialog" aria-expanded={modelOpen} disabled={disabled || busy} title={identity ? `${identity.model}${identity.provider ? ` via ${identity.provider}` : ''}${running ? ' · Changes apply next turn' : ''}` : 'Choose provider and model'} onClick={() => { setReasoningOpen(false); setError(null); if (modelOpen) onCloseModel(); else onOpenModel(); }}>{identity?.model || 'Model unavailable'}</button>
    <span className="chat-status-line-separator" aria-hidden>|</span>
    <button ref={effortRef} className="chat-status-line-reasoning chat-status-control" type="button" aria-label={`Reasoning: ${effort}${queued ? ', next turn' : ''}`} aria-haspopup="dialog" aria-expanded={reasoningOpen} disabled={disabled || busy || !identity?.reasoningEffort} title={queued ? 'Queued for next turn' : 'Choose reasoning effort'} onClick={() => void openReasoning()}>{busy ? 'saving…' : effort}{queued ? ' · next' : ''}</button>
    {panel && footer ? createPortal(panel, footer) : null}
  </span>;
}
