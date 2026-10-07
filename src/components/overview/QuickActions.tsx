import { useRef, useState } from 'react';
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
};

export function QuickActions({
  gatewayActions,
  runGatewayAction,
  actionLoading,
}: QuickActionsProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [restartConfirmationOpen, setRestartConfirmationOpen] = useState(false);
  const [restartPending, setRestartPending] = useState(false);
  const [restartResult, setRestartResult] = useState<'success' | 'error' | null>(null);
  const restartInFlight = useRef(false);
  const refreshAction = gatewayActions.find((a) => a.id === 'refresh');
  const restartAction = gatewayActions.find((a) => a.id === 'restart-gateway');

  const confirmRestart = async () => {
    if (!restartAction || restartInFlight.current) return;
    restartInFlight.current = true;
    setRestartConfirmationOpen(false);
    setRestartPending(true);
    setRestartResult(null);
    try {
      await runGatewayAction(restartAction);
      setRestartResult('success');
    } catch {
      setRestartResult('error');
    } finally {
      restartInFlight.current = false;
      setRestartPending(false);
    }
  };

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
            loading={restartPending || actionLoading === 'restart-gateway'}
            disabled={restartPending || actionLoading === 'restart-gateway'}
            onClick={() => { setRestartResult(null); setRestartConfirmationOpen(true); }}
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

      {restartResult && (
        <p className={`px-3 pb-3 text-xs ${restartResult === 'success' ? 'text-positive' : 'text-negative'}`} role={restartResult === 'error' ? 'alert' : 'status'}>
          {restartResult === 'success' ? t('overview.restartSuccess') : t('overview.restartError')}
        </p>
      )}

      {restartConfirmationOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="alertdialog" aria-modal="true" aria-labelledby="restart-gateway-title" aria-describedby="restart-gateway-description">
          <div className="w-full max-w-md rounded-lg border border-border bg-surface p-5 shadow-xl">
            <h3 id="restart-gateway-title" className="text-base font-semibold text-text">{t('overview.restartConfirmTitle')}</h3>
            <p id="restart-gateway-description" className="mt-2 text-sm text-text-muted">{t('overview.restartConfirmDescription')}</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setRestartConfirmationOpen(false)}>{t('common.cancel')}</Button>
              <Button variant="danger" size="sm" onClick={() => void confirmRestart()}>{t('overview.restartConfirmAction')}</Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
