import { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff, Loader2 } from 'lucide-react';
import { useMissionControl } from '../lib/mission-control-store';
import { useI18n } from '../lib/i18n';
import { getPushState, pushSupported, subscribeToPush, unsubscribeFromPush, type PushSubscriptionState } from '../lib/push-client';

/**
 * Push notifications toggle. Shows an on/off switch for Web Push on this
 * device. When enabled, requests permission and registers the subscription
 * with the backend so Hermes responses can arrive as system notifications
 * while the app is in the background or closed.
 */
export function PushToggle() {
  const { t } = useI18n();
  const { storedToken } = useMissionControl();
  const [state, setState] = useState<PushSubscriptionState | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void getPushState().then(setState);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const unsupported = !pushSupported() || state?.status === 'unsupported';
  const subscribed = state?.status === 'subscribed';
  const disabled = busy || !state || unsupported || state.status === 'denied';

  const toggle = async () => {
    if (disabled) return;
    setBusy(true);
    try {
      const next = subscribed
        ? await unsubscribeFromPush(storedToken)
        : await subscribeToPush(storedToken);
      setState(next);
    } finally {
      setBusy(false);
    }
  };

  const title = subscribed
    ? t('push.onTitle')
    : unsupported || state?.status === 'denied'
      ? t('push.blocked')
      : t('push.enable');

  return (
    <button
      className="pill pill-subtle pill-button side-action-button push-toggle"
      type="button"
      onClick={() => void toggle()}
      disabled={disabled}
      aria-label={title}
      title={title}
      aria-pressed={subscribed}
    >
      {busy ? (
        <Loader2 size={16} className="chat-spin" />
      ) : subscribed ? (
        <Bell size={16} />
      ) : (
        <BellOff size={16} />
      )}
      <span className="push-toggle-label">{t('push.label')}</span>
      <span className="push-toggle-state" aria-hidden="true" />
    </button>
  );
}
