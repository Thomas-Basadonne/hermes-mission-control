# Mission Control — Secrets & Environment File Guide

This document explains how to create the runtime environment file for a
Mission Control deployment and how to obtain each secret it contains.

**The only secret-bearing artifact that may live in this repository is
`deploy/systemd/env.template`. No real secrets are ever committed.** The
template contains placeholders only. The real file lives outside the repo, on
the deployment host, at:

    ~/.hermes/mission-control.env

This is the path the systemd units (`EnvironmentFile=-%h/.hermes/mission-control.env`)
and the launcher scripts (`scripts/lib/env.sh`) read by default. Set
`MISSION_CONTROL_ENV_FILE` to use another path with the launcher scripts.

## Creating the environment file

On the deployment host (Linux/macOS alike):

```bash
install -d -m 700 "$HOME/.hermes"
install -m 600 deploy/systemd/env.template "$HOME/.hermes/mission-control.env"
```

Then edit `~/.hermes/mission-control.env` and replace every
`change_me_*` placeholder and empty optional value.

Requirements enforced by the deployment (systemd user units and launcher
scripts):

| Requirement | Command |
|---|---|
| File location | `~/.hermes/mission-control.env` (outside the repo) |
| Ownership | the deploying user (the user that runs the services) |
| Permissions | `600` (`-rw-------`) |
| Directory permissions | `700` on `~/.hermes` recommended |

```bash
chown "$USER:$USER" ~/.hermes/mission-control.env
chmod 600 ~/.hermes/mission-control.env
```

Verify:

```bash
ls -l ~/.hermes/mission-control.env   # -rw------- 1 <user> <group> ...
```

## Why 600 and outside the repo

- The file contains bearer tokens and a VAPID private key — credentials that
  let anyone with read access impersonate the operator of the control plane.
- `600` ensures only the owning user can read it; the directory `700` keeps
  other local users from even listing it.
- Keeping it outside the repository makes it impossible to accidentally
  `git add`/commit secrets, and lets the same repo deploy to multiple hosts
  with different credentials.
- The repo's `.gitignore` additionally ignores `.env`, `.env.*` (except
  `.env.example`) so even a local env file at the repo root stays untracked.

## Every variable and how to obtain it

### Authentication

| Variable | Required | How to generate / obtain |
|---|---|---|
| `MISSION_CONTROL_TOKEN` | yes | `openssl rand -base64 32`. This is the bearer token for every `/api/local/*` telemetry endpoint. |
| `HERMES_DASHBOARD_SESSION_TOKEN` | no | Token the Hermes dashboard API accepts. `scripts/run-dashboard-api.sh` defaults it to `MISSION_CONTROL_TOKEN`; keep them equal. |
| `VITE_MISSION_CONTROL_TOKEN` | no | Same value as `MISSION_CONTROL_TOKEN`. Bootstraps the browser's `localStorage` on first visit. It is baked into the client bundle, so leave it empty when the UI is reachable from other machines and enter the token on the lock screen. |
| `API_SERVER_KEY` | no | Legacy fallback name read by the telemetry server and terminal only when `MISSION_CONTROL_TOKEN` is unset. The dashboard API does not read it. |

Use one random value for every token variable you set. Treat it as a password
and as a shell credential (it opens the browser terminal): never log it, never
commit it, rotate it with `openssl rand -base64 32` if it leaks, and update
every copy together.

### Telemetry server (no secrets — operational knobs)

| Variable | Default | Purpose |
|---|---|---|
| `MISSION_CONTROL_LOCAL_TELEMETRY_HOST` | `0.0.0.0` | Bind address. `0.0.0.0` needed for Tailscale/LAN access; `127.0.0.1` for local-only. |
| `MISSION_CONTROL_LOCAL_TELEMETRY_PORT` | `8765` | Sidecar port. |
| `MISSION_CONTROL_DEV_HOSTS` | *(empty)* | Comma-separated Tailscale/LAN IPs allowed by the Vite dev server (`MISSION_CONTROL_ALLOWED_HOSTS` if set). |
| `MISSION_CONTROL_ALLOWED_ORIGIN` | *(empty)* | CORS allowlist; when empty the server mirrors the request Origin. |
| `MISSION_CONTROL_READ_ONLY` | *(empty)* | `1`/`true`/`yes` rejects mutating requests. |
| `MISSION_CONTROL_LOCAL_TELEMETRY_URL` | `http://127.0.0.1:8765` | Vite proxy target for `/api/local`. |
| `HERMES_DASHBOARD_URL` | `http://127.0.0.1:9119` | Vite proxy target for `/api` and `/api/ws` (dashboard API). |
| `MISSION_CONTROL_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Strict Vite `allowedHosts` list. |

### Web Push (optional)

| Variable | Required for push | How to generate / obtain |
|---|---|---|
| `MISSION_CONTROL_VAPID_PUBLIC_KEY` | yes | VAPID public key. |
| `MISSION_CONTROL_VAPID_PRIVATE_KEY` | yes | VAPID private key. |
| `MISSION_CONTROL_VAPID_CONTACT` | yes | `mailto:` or URL identifying you as the push sender. |

Generate a VAPID keypair with `pywebpush`:

```bash
python3 -c "from py_vapid import Vapid01; v=Vapid01(); v.generate_keys(); \
print('public :', v.public_key.decode()); \
print('private:', v.private_key.decode())"
```

If either VAPID key is missing, Web Push degrades gracefully to "disabled" —
the rest of Mission Control keeps working. The contact is required by push
services (Chrome/Firefox) at subscription time.

Optional push-proxy knobs (defaults point at the Vite dev server, which
proxies `/api/ws` to the dashboard API):

| Variable | Default |
|---|---|
| `MISSION_CONTROL_GATEWAY_WS_URL` | `ws://127.0.0.1:5174/api/ws` |
| `MISSION_CONTROL_GATEWAY_ROOT_URL` | `http://127.0.0.1:5174/api/gateway-root` |
| `MISSION_CONTROL_WS_RECONNECT_DELAY` | `5` (seconds) |

### Plugins

Plugins (for example an external Curate plugin) are activated by presence, not
by an environment variable: install them under `~/.hermes/mc-plugins/<id>/`
(see [docs/plugins.md](../../docs/plugins.md)). Any environment a plugin needs
is documented by that plugin.

## Where the file is consumed

- **systemd user units** (`systemd/*.service`): loaded via
  `EnvironmentFile=-%h/.hermes/mission-control.env`.
- **Launcher scripts** (`scripts/run-local-telemetry.sh`,
  `scripts/run-dashboard-api.sh`, smoke scripts): source
  `$MISSION_CONTROL_ENV_FILE`, or `~/.hermes/mission-control.env` when it is
  unset. They never read `<repo>/.env`.
- **Vite**: reads `<repo>/.env` and the process environment only.

## Rotation checklist

1. `openssl rand -base64 32` → new `MISSION_CONTROL_TOKEN`.
2. Update every other copy (`HERMES_DASHBOARD_SESSION_TOKEN`, `VITE_MISSION_CONTROL_TOKEN`, `API_SERVER_KEY`) that you set.
3. `chmod 600` / `chown` if the file was touched by a different user.
4. Restart services: `systemctl --user restart mission-control.target`.
5. Browsers with an old `localStorage` token will 401 until the new token is
   re-entered or the page is hard-refreshed with the new
   `VITE_MISSION_CONTROL_TOKEN` baked in.
