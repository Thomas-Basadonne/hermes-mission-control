import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../lib/i18n';
import { RefreshCw, Rocket, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { MissionControlGatewayAction } from '../../lib/mission-control-store';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';

type QuickActionsProps = {
  gatewayActions: MissionControlGatewayAction[];
  runGatewayAction: (action: MissionControlGatewayAction) => Promise<void>;
  actionLoading: string | null;
  restartAvailable: boolean;
};

export function GatewayRestartConfirmationDialog({
  open,
  onCancel,
  onConfirm,
  returnFocusTarget,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  returnFocusTarget?: HTMLElement | null;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableButtons = () => [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const focusFirst = () => focusableButtons()[0]?.focus();
    const onFocusIn = (event: FocusEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(event.target as Node)) focusFirst();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const buttons = focusableButtons();
      if (!buttons.length) return;
      const activeIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.shiftKey && activeIndex <= 0) {
        event.preventDefault();
        buttons.at(-1)?.focus();
      } else if (!event.shiftKey && (activeIndex < 0 || activeIndex === buttons.length - 1)) {
        event.preventDefault();
        buttons[0].focus();
      }
    };

    focusFirst();
    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      window.removeEventListener('keydown', onKeyDown, true);
      const target = returnFocusTarget ?? previousFocus;
      window.requestAnimationFrame(() => {
        if (target?.isConnected) target.focus();
      });
    };
  }, [open, returnFocusTarget]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" role="alertdialog" aria-modal="true" aria-labelledby="restart-gateway-title" aria-describedby="restart-gateway-description">
      <div ref={dialogRef} className="w-full max-w-md rounded-lg border border-border bg-surface p-5 shadow-xl">
        <h3 id="restart-gateway-title" className="text-base font-semibold text-text">{t('overview.restartConfirmTitle')}</h3>
        <p id="restart-gateway-description" className="mt-2 text-sm text-text-muted">{t('overview.restartConfirmDescription')}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="danger" size="sm" onClick={onConfirm}>{t('overview.restartConfirmAction')}</Button>
        </div>
      </div>
    </div>
  );
}

export function useGatewayRestartAction(
  gatewayActions: MissionControlGatewayAction[],
  runGatewayAction: (action: MissionControlGatewayAction) => Promise<void>,
  actionLoading: string | null,
  onResult?: (result: 'success' | 'error' | 'unknown') => void,
  available = true,
) {
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<'success' | 'error' | 'unknown' | null>(null);
  const inFlight = useRef(false);
  const action = available ? gatewayActions.find((candidate) => candidate.id === 'restart-gateway') : undefined;

  const request = useCallback(() => {
    if (!available || !action || actionLoading || inFlight.current) return;
    setResult(null);
    setConfirmationOpen(true);
  }, [action, actionLoading, available]);
  const cancel = useCallback(() => {
    if (!pending) setConfirmationOpen(false);
  }, [pending]);
  const confirm = useCallback(async () => {
    if (!action || actionLoading || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setConfirmationOpen(false);
    setResult(null);
    try {
      await runGatewayAction(action);
      setResult('success');
      onResult?.('success');
    } catch (error) {
      const unknown = error instanceof Error
        && ['GatewayActionOutcomeUnknownError', 'TypeError', 'AbortError', 'TimeoutError'].includes(error.name);
      const outcome = unknown ? 'unknown' : 'error';
      setResult(outcome);
      onResult?.(outcome);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, [action, actionLoading, onResult, runGatewayAction]);

  return { action, confirmationOpen, pending, result, request, cancel, confirm };
}

export function QuickActions({
  gatewayActions,
  runGatewayAction,
  actionLoading,
  restartAvailable,
}: QuickActionsProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const restart = useGatewayRestartAction(gatewayActions, runGatewayAction, actionLoading, undefined, restartAvailable);
  const refreshAction = gatewayActions.find((a) => a.id === 'refresh');
  const restartAction = restart.action;

  return (
    <Card padding="none">
      <div className="flex items-center justify-between px-3 pt-3 pb-2 border-b border-border-subtle">
        <div className="flex flex-col gap-0.5">
          <span className="eyebrow">{t('overview.controls')}</span>
          <h2 className="text-sm font-semibold text-text">{t('overview.quickActions')}</h2>
        </div>
      </div>

      <div className="p-3 flex flex-wrap items-center gap-2">
        {refreshAction && (
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            loading={actionLoading === 'refresh'}
            onClick={() => void runGatewayAction(refreshAction)}
          >
            Refresh
          </Button>
        )}

        {restartAction && (
          <Button
            variant="secondary"
            size="sm"
            icon={<Rocket className="h-3.5 w-3.5" />}
            loading={restart.pending || actionLoading === 'restart-gateway'}
            disabled={restart.pending || actionLoading === 'restart-gateway'}
            onClick={restart.request}
          >
            Restart gateway
          </Button>
        )}

        <div className="flex-1" />

        <Button
          variant="ghost"
          size="sm"
          icon={<Settings className="h-3.5 w-3.5" />}
          onClick={() => navigate('/config')}
        >
          Settings
        </Button>
      </div>

      {restart.result && (
        <p className={`px-3 pb-3 text-xs ${restart.result === 'success' ? 'text-positive' : restart.result === 'unknown' ? 'text-warning' : 'text-negative'}`} role={restart.result === 'success' ? 'status' : 'alert'}>
          {restart.result === 'success' ? t('overview.restartSuccess') : restart.result === 'unknown' ? t('overview.restartUnknown') : t('overview.restartError')}
        </p>
      )}

      <GatewayRestartConfirmationDialog
        open={restart.confirmationOpen}
        onCancel={restart.cancel}
        onConfirm={() => void restart.confirm()}
      />
    </Card>
  );
}
