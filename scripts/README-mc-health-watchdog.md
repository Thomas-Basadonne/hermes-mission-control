# Mission Control no-agent health watchdog

Read-only health checks for the current macOS MC stack. Implementation lives in
`scripts/mc_health_watchdog.py`; Hermes runs the thin host wrapper
`$HERMES_HOME/scripts/mc-health-watchdog.py` using its own Python runtime.
`websockets` is provided by that runtime; do not install into Hermes with raw pip.

## Checks

- Vite `:5174`: MC HTML root and compiled JavaScript bootstrap.
- Dashboard API `:9119`: authenticated status JSON, direct and through the Vite
  proxy; both must identify the same Hermes installation.
- Messaging gateway must be running.
- MC-owned telemetry `:8765`: healthy service, direct and through Vite.
- Live CPU/RAM/disk payload, cron inventory/count consistency, canonical sessions
  API (`limit=1`, no session creation), provider-usage cache availability.
- Authenticated WebSocket through `/api/ws`, including `gateway.ready`; no agent
  or chat turn is started.
- Running LaunchAgents/PIDs for frontend, dashboard API and telemetry.

A HTTP 200 that contains SPA HTML instead of API JSON is **not** healthy. The
`:9119/health` route is not used: on this installation it returns SPA HTML.
Credentials are read from the frontend LaunchAgent, never printed or saved.
Targets are loopback-only; redirects and environment HTTP proxies are disabled.

## Schedule and Telegram

Native Hermes cron `mc-health-watchdog`, every five minutes, `no_agent=true`.
Success/recovery and failure delivery both explicitly target the configured
owner Telegram home chat. The first run emits an activation report; subsequent
healthy runs emit no stdout, so they generate no routine Telegram message.
Recovery emits one report. A failed run always exits nonzero and emits only
stable failure diagnostics; native Hermes incidents dedupe repeated failures and
re-alert every `cron.failure_repeat_alert_hours` (currently six hours).
Delivery uses the native Hermes scheduler/outbox, not a second bot client.

Full Markdown and JSON reports are atomically replaced under
`$HERMES_HOME/run/mc-health-watchdog.{md,json}`, with file mode `0600`.
An exclusive lock prevents concurrent state writes; the CLI has a 100-second
budget in addition to per-request timeouts. No restart, repair, completion,
learning, candidate mutation or synthetic user message is performed.

## Validation

```sh
python3 scripts/mc_health_watchdog.py --preview
python3 -m unittest discover -s tests -p 'test_mc_health_watchdog.py' -v
```

`--preview` does not write report state or deliver Telegram messages. Tests use
real local HTTP/WebSocket servers and temporary report homes. They verify
payload/auth failures, SPA fallbacks, initial/silent/failure/recovery transitions,
stable failure output and private persistence. Use the Hermes Python runtime.

## Limits

This checks MC availability, not every plugin or external model/provider. Provider
usage is a cache-availability check, not a quota or freshness guarantee. It does
not render the UI in a browser, invoke LLMs, or simulate a complete chat turn.
A Hermes cron cannot alert if its own scheduler is stopped. Monitoring that
failure requires an independent launchd/external watchdog, not this cron.

Do not restart the shared dashboard API or gateway to test failure handling:
they host active sessions. Do not add MC-specific checker logic to Hermes core.
