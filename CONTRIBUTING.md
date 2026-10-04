# Contributing to Hermes Mission Control

Thanks for your interest in improving Mission Control.

## Scope

Mission Control is a **standalone satellite application** in its own repository (this repo). It must not modify Hermes core files (`hermes_cli/`, `gateway/`, `pyproject.toml`, etc.) and ships no patches for them. Mission Control-owned backend logic lives in the telemetry sidecar (`server/`, port `8765`). It may use the documented Hermes interfaces listed in [docs/runbooks/upgrade-compatibility.md](docs/runbooks/upgrade-compatibility.md); adding a new dependency on Hermes internals needs a fallback path and an entry in that list.

## Before you start

- Open an issue or discussion for large changes.
- New data sources go into the sidecar (`server/`), not into Hermes.
- Match the existing TypeScript/React patterns and Tailwind conventions.
- Node.js >= 22.12 (the TS test suites need native type stripping), Python >= 3.10.
- Before submitting, run what CI runs: `pnpm typecheck`, `pnpm build`, `pnpm test:frontend`, and `pnpm test` (Python suites). The full list is in the README, section "Testing".
- New tests must **call** the logic under test. Do not assert on source text with `readFileSync` + `includes`: those tests pass when the wiring is subtly wrong, fail on a correct refactor, and cannot run against a bundled artifact.
- New sidecar routes go into [docs/api.md](docs/api.md); new environment variables go into `.env.example` and `deploy/systemd/env.template`.

## Development

```bash
pnpm install
cp .env.example .env            # set MISSION_CONTROL_TOKEN
export MISSION_CONTROL_ENV_FILE="$PWD/.env"
scripts/run-dashboard-api.sh    # separate terminal; needs a local Hermes install
pnpm dev:full
```

The telemetry server is a Python sidecar in `server/`. It does not hot-reload; restart it after backend changes.

## Pull requests

1. Keep commits focused and the diff minimal.
2. Do not include `.env`, tokens, personal paths, or private hostnames/IPs (use placeholders such as `~/Projects/...` and `100.x.y.z`).
3. Verify the dashboard still loads on both desktop and mobile widths.
