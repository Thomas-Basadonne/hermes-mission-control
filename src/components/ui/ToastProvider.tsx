import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastTone = 'success' | 'info' | 'warning' | 'error';
export type ToastOptions = { tone?: ToastTone; durationMs?: number }; // durationMs only applies to success/info; alerts persist until dismissed.
export type ShowToast = (message: string, options?: ToastOptions) => void;

type ToastEntry = { id: number; message: string; tone: ToastTone };
type ToastContextValue = { showToast: ShowToast };

const MAX_VISIBLE_TOASTS = 3;
const DEFAULT_DURATION_MS: Partial<Record<ToastTone, number>> = {
  success: 3200,
  info: 3200,
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children, dismissLabel = 'Dismiss notification' }: { children: ReactNode; dismissLabel?: string }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const entriesRef = useRef<ToastEntry[]>([]);
  const timersRef = useRef(new Map<number, number>());
  const nextIdRef = useRef(0);

  const removeToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    const next = entriesRef.current.filter((entry) => entry.id !== id);
    entriesRef.current = next;
    setToasts(next);
  }, []);

  const showToast = useCallback<ShowToast>((message, options = {}) => {
    if (!message.trim()) return;
    const tone = options.tone ?? 'info';
    const id = ++nextIdRef.current;
    const entry = { id, message, tone };
    const next = [...entriesRef.current, entry];

    while (next.length > MAX_VISIBLE_TOASTS) {
      const transientIndex = next.findIndex((item) => {
        if (item.id === id || (item.tone !== 'success' && item.tone !== 'info')) return false;
        const toastElement = document.querySelector(`[data-toast-id="${item.id}"]`);
        return !toastElement?.contains(document.activeElement);
      });
      if (transientIndex < 0) break;
      const [removed] = next.splice(transientIndex, 1);
      if (removed) {
        const timer = timersRef.current.get(removed.id);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          timersRef.current.delete(removed.id);
        }
      }
    }

    entriesRef.current = next;
    setToasts(next);
    const durationMs = tone === 'error' || tone === 'warning'
      ? undefined
      : options.durationMs ?? DEFAULT_DURATION_MS[tone];
    if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0) {
      const expireWhenUnfocused = () => {
        const toastElement = document.querySelector(`[data-toast-id="${id}"]`);
        if (toastElement?.contains(document.activeElement)) {
          const timer = window.setTimeout(expireWhenUnfocused, 1000);
          timersRef.current.set(id, timer);
          return;
        }
        removeToast(id);
      };
      const timer = window.setTimeout(expireWhenUnfocused, durationMs);
      timersRef.current.set(id, timer);
    }
  }, [removeToast]);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) window.clearTimeout(timer);
    timersRef.current.clear();
    entriesRef.current = [];
  }, []);

  const contextValue = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <div className="mc-toast-viewport" data-toast-viewport>
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="mc-toast"
            data-toast-item
            data-toast-tone={toast.tone}
            data-toast-id={toast.id}
          >
            <span
              data-toast-message
              role={toast.tone === 'error' || toast.tone === 'warning' ? 'alert' : 'status'}
            >
              {toast.message}
            </span>
            <button
              type="button"
              className="mc-toast-dismiss"
              aria-label={`${dismissLabel}: ${toast.message}`}
              onClick={() => removeToast(toast.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
