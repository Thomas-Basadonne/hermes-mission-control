# Security Policy

## Scope

Mission Control is a local-first dashboard. Its telemetry sidecar can read
system metrics, Hermes session metadata, transcripts, logs, and configuration,
and it can change state on the host (see below). Treat it as a trusted-network
application, never as a public internet service.

## What the access token can do

Anyone holding `MISSION_CONTROL_TOKEN` can:

- open an **interactive shell** as the user running the sidecar, through the
  browser terminal (`/api/local/terminal/ticket` + the WebSocket on `:8766`);
- replace Hermes `config.yaml` (`PUT /api/local/config`, with an automatic
  backup) and enable or disable skills;
- install skills (`hermes skills install`), create, edit, run, or delete cron
  jobs, and create or modify Kanban boards and tasks;
- restart the Hermes gateway (`POST /api/local/gateway/restart`);
- send Web Push notifications to every subscribed device;
- call any endpoint of an installed plugin.

Treat the token as a shell credential. The complete route list is in
[docs/api.md](docs/api.md).

Routes that need no token: `GET /health` and `GET /api/local/health` (liveness
only, no secrets).

`MISSION_CONTROL_READ_ONLY=1` rejects mutating HTTP requests on the sidecar,
including terminal ticket issuance, and the terminal WebSocket refuses to spawn
a new shell while it is set. Shells opened before read-only was enabled keep
running until they exit. Read-only mode is a policy boundary for a trusted
token holder, not an authentication layer: protect the token itself.

## Supported versions

Only the latest commit on `main` is supported for security fixes.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Report it privately through GitHub's **Report a vulnerability** flow, or contact the repository maintainer through the private contact method shown on the GitHub profile.

Include:

- affected version or commit;
- reproducible steps or a minimal proof of concept;
- impact and expected severity;
- any suggested mitigation.

You should receive an acknowledgement within seven days. Please allow time for a fix before public disclosure.

## Deployment guidance

- Never commit `.env` or bearer tokens.
- Use a strong random `MISSION_CONTROL_TOKEN` (`openssl rand -base64 32`).
- Keep the telemetry sidecar (`:8765`) and the terminal socket (`:8766`) on
  loopback; let browsers reach them through the Vite proxy or a reverse proxy.
- Do not expose any Mission Control port directly to the public internet. Use a
  private network such as Tailscale.
- Leave `VITE_MISSION_CONTROL_TOKEN` empty when the UI is reachable from other
  machines: Vite embeds it in the JavaScript bundle served to every visitor.
- Set `MISSION_CONTROL_ALLOWED_ORIGIN` when the frontend has a fixed origin.
- Install only plugins you trust: plugin backends run inside the sidecar
  process with its privileges.
