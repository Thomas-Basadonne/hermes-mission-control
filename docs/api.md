# HTTP API

Mission Control exposes its own API from the telemetry sidecar
(`server/local_telemetry_server.py`, default `127.0.0.1:8765`). The browser
reaches it through the Vite proxy at `/api/local/*`. Everything else under
`/api/*` (including the `/api/ws` JSON-RPC socket) belongs to the Hermes
dashboard API and is documented by Hermes.

This page lists every sidecar route at the time of writing. The source of truth
is the `do_GET` / `do_POST` / `do_PUT` / `do_PATCH` / `do_DELETE` handlers in
`server/local_telemetry_server.py`.

## Conventions

- **Auth.** Send `Authorization: Bearer <MISSION_CONTROL_TOKEN>` (the sidecar
  also accepts `API_SERVER_KEY` when `MISSION_CONTROL_TOKEN` is unset). Missing
  or wrong tokens return `401` with `{"error": "invalid_api_key"}`. Exceptions
  are marked **open** below.
- **Read-only mode.** With `MISSION_CONTROL_READ_ONLY=1`, every `PUT`, `PATCH`,
  and `DELETE`, and every `POST` except `/api/local/terminal/ticket` and
  `/api/local/client-diagnostics`, returns `403 {"error": "read_only_mode"}`.
- **Errors.** JSON bodies of the form `{"error": "<code>", "detail": "<text>"}`.
  Unknown paths return `404 {"error": "not_found"}`.
- **CORS.** See [telemetry.md](telemetry.md#cors-origin-enforcement).

## Health

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | open | Liveness: `{ok, service, source, push}` |
| GET | `/api/local/health` | open | Same payload, under the proxied prefix |

## System, runtime, and usage

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/local/system` | CPU, memory, disk, thermal (see [telemetry.md](telemetry.md#thermal-telemetry)) |
| GET | `/api/local/status` | Gateway/runtime status and active model |
| GET | `/api/local/model/info` | Model details |
| GET | `/api/local/provider-usage` | Normalized provider usage (see [telemetry.md](telemetry.md#provider-usage-codexbar--nous-portal)) |
| GET | `/api/local/provider-usage/catalog` | Sanitized CodexBar provider catalog plus Mission Control-native providers; `?refresh=1` requests a rate-limited discovery |
| PUT | `/api/local/provider-usage/selection` | Save the selected collectable provider IDs (`{"selectedProviders":[...]}`); rejected in read-only mode |
| GET | `/api/local/sessions` | Session list |
| GET | `/api/local/sessions/usage` | Session token/cost usage |
| GET | `/api/local/logs` | Tail of recent Hermes log files (`maxFiles`, `maxLines`) |
| POST | `/api/local/gateway/restart` | Runs `hermes gateway restart` (requires the `hermes` CLI on `PATH`); answers `202` |

## Agents and traces

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/local/mission-control/agents` | Agent snapshot, including the `capabilities` object ([contract](contracts/compatibility-matrix.md)) |
| GET | `/api/local/mission-control/sessions` | Paged sessions for the Agents view (`limit`, `offset`, `profile`, `session_id`) |
| GET | `/api/local/mission-control/agents/trace` | Trace for one session ([contract](contracts/mission-control-trace-v1.json)) |
| GET | `/api/local/mission-control/agents/trace/stream` | Same trace as Server-Sent Events (`event: trace`) |

## Configuration, tools, skills, memory

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/local/config` | Hermes `config.yaml` (raw text plus parsed view) |
| PUT | `/api/local/config` | Replace `config.yaml`. The YAML is validated, a `config.yaml.bak.<timestamp>` backup is written, then the file is replaced atomically |
| GET | `/api/local/tools` | Tool inventory (see [tools.md](tools.md)) |
| GET | `/api/local/skills` | Installed skills |
| GET | `/api/local/skills/catalog` | Installable skills catalog |
| GET | `/api/local/skills/files` | File tree of one skill (`skill`) |
| POST | `/api/local/skills/install` | Runs `hermes skills install <identifier> --yes` (`{"identifier"}`) |
| POST | `/api/local/profile/skills/install` | Installs a skill into one profile (`{"profile", "identifier"}`) |
| POST | `/api/local/skills/toggle` | Enables or disables a skill in `config.yaml` (`skills.disabled`) |
| GET | `/api/local/memory/honcho` | Honcho status (see [honcho.md](honcho.md)) |
| POST | `/api/local/memory/honcho/local-identity` | Configures the local Honcho peer (`{"peerName"}`) |

## Cron

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/local/cron/jobs` | List jobs |
| GET | `/api/local/cron/jobs/:id` | Job detail |
| POST | `/api/local/cron/jobs` | Create a job |
| POST | `/api/local/cron/jobs/:id/pause` | Pause (`{"reason"?, "profile"?}`) |
| POST | `/api/local/cron/jobs/:id/resume` | Resume (`{"profile"?}`) |
| POST | `/api/local/cron/jobs/:id/run` | Run now (`{"profile"?}`) |
| PATCH | `/api/local/cron/jobs/:id` | Update a job |
| DELETE | `/api/local/cron/jobs/:id` | Delete a job |

Cron operations go through the Hermes core cron module (`server/cron_bridge.py`).

## Kanban

All routes live under `/api/local/kanban/` and accept `?board=<slug>`. Full
list in [kanban.md](kanban.md#architecture).

## Chat, Bot Mode, and Rooms

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/local/chat/transcript`, `/api/local/chat/canonical` | Stored transcript for a session (`profile`, `session_id`, `session_key`) |
| GET | `/api/local/chat/timestamps`, `/api/local/chat/message-timestamps` | Per-message timestamps for a session |
| GET | `/api/local/chat/sync/stream` | Cross-device chat sync, Server-Sent Events (`client_id`, `session_id`, `since`) |
| GET | `/api/local/chat/sync/stats` | Sync relay counters |
| POST | `/api/local/chat/sync/publish` | Publish a sync envelope to other devices |
| GET, POST | `/api/local/chat/presence` | Runtime presence per session |
| POST | `/api/local/chat/title` | Store an MC-side session title |
| GET | `/api/local/chat/handoffs`, `/api/local/chat/handoffs/all` | Bot handoffs (by `session_id`, or all) |
| POST | `/api/local/chat/handoffs` | Record a handoff |
| POST | `/api/local/chat/handoffs/claim` | Claim a pending handoff |
| GET, POST | `/api/local/chat/last` | Cross-device last-chat pointer (POST is compare-and-swap, `409` on conflict) |
| GET, POST | `/api/local/room/last` | Cross-device last-room pointer (same CAS rules) |
| GET, POST, DELETE | `/api/local/room/vault` | Optional room → vault routing map (see [rooms.md](rooms.md#room-creation-and-the-vault-destination)) |
| GET | `/api/local/room/tools` | Read-only tool/reasoning traces for a room (`room_id`, `max_age`) |

Details: [chat.md](chat.md), [bot-mode.md](bot-mode.md), [rooms.md](rooms.md).

## Whiteboard (tldraw Agent Mode)

| Method | Path | Purpose |
|--------|------|---------|
| GET, POST | `/api/local/chat/whiteboard` | Session-bound whiteboard state and agent command queue |
| GET, POST | `/api/local/chat/canvas/:addon` | Canvas add-on protocol dispatch (registered with `register_canvas_handler`) |

See [tldraw-feature-matrix.md](tldraw-feature-matrix.md).

## Browser terminal

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/local/terminal/ticket` | Exchanges the bearer token for a single-use ticket valid for 30 seconds |

The terminal itself is a WebSocket served by `server/terminal_server.py` on
`MISSION_CONTROL_TERMINAL_HOST:MISSION_CONTROL_TERMINAL_PORT` (default
`127.0.0.1:8766`) and proxied by Vite at `/api/terminal?ticket=<ticket>`. A
valid ticket opens an interactive shell (`zsh` or `bash`) as the user running
the sidecar. Invalid tickets are closed with code `4401`.

## Web Push (optional)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/local/push/vapid-public-key` | Public VAPID key for `pushManager.subscribe()` |
| GET, POST, DELETE | `/api/local/push/subscriptions` | List, add, remove push subscriptions |
| POST | `/api/local/push/send` | Send a push notification to all subscriptions |

See [telemetry.md](telemetry.md#web-push-optional).

## Diagnostics and plugins

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/local/client-diagnostics` | bearer header **or** `_accessToken` in the JSON body | Appends browser reload breadcrumbs to `<hermes home>/logs/mission-control-client.log` (the token is never written) |
| GET | `/api/local/plugins` | bearer | Loaded plugin manifests |
| GET, POST | `/api/local/<plugin path>` | bearer | Any route declared by an installed plugin (see [plugins.md](plugins.md)) |
