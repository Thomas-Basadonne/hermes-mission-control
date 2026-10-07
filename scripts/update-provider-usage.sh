#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091 # path is runtime-computed via SCRIPT_DIR
source "$SCRIPT_DIR/lib/env.sh"
load_mission_control_env

# This shared writer refreshes selected CodexBar and native Nous providers
# through the same snapshot manager. Nous session refresh is delegated to Hermes.
exec python3 "$SCRIPT_DIR/update-provider-usage.py"
