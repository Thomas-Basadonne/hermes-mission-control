#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091 # path is runtime-computed via SCRIPT_DIR
source "$SCRIPT_DIR/lib/env.sh"
load_mission_control_env

# This shared writer refreshes CodexBar-backed providers only. The telemetry
# sidecar collects Nous separately, using Hermes to refresh its portal session.
exec python3 "$SCRIPT_DIR/update-provider-usage.py"
