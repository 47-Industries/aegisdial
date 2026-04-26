#!/usr/bin/env bash
# ============================================================================
#  setup-fly-secrets.sh — push every variable from .env.production to Fly
#
#  Usage:
#    bash scripts/setup-fly-secrets.sh [--app aegisdial-api] [--dry-run]
#
#  Prerequisites:
#    - flyctl on $PATH (or run `export PATH="$HOME/.fly/bin:$PATH"`)
#    - `fly apps create aegisdial-api --org personal` has been run
#    - `.env.production` exists with real values (copy from template)
# ============================================================================
set -euo pipefail

APP="aegisdial-api"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^#//'
      exit 0 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

cd "$(dirname "$0")/.."
ENV_FILE=".env.production"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy from .env.production.template and fill it in."
  exit 1
fi

if ! command -v fly >/dev/null 2>&1; then
  echo "flyctl not on PATH. Try: export PATH=\"\$HOME/.fly/bin:\$PATH\""
  exit 1
fi

# Build an array of KEY=VALUE pairs, skipping comments + blanks + TODO.
declare -a PAIRS=()
while IFS= read -r line; do
  # strip whitespace, skip blanks + comments
  [[ -z "${line// }" ]] && continue
  [[ "$line" =~ ^[[:space:]]*# ]] && continue

  # Support multi-line values for APNS_KEY_P8 wrapped in double quotes
  if [[ "$line" =~ ^([A-Z_][A-Z_0-9]*)=\"(.*)$ ]] && [[ ! "${BASH_REMATCH[2]}" =~ \"$ ]]; then
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"$'\n'
    while IFS= read -r cont; do
      if [[ "$cont" =~ \"$ ]]; then
        val+="${cont%\"}"
        break
      fi
      val+="$cont"$'\n'
    done
    PAIRS+=("$key=$val")
    continue
  fi

  # Normal KEY=VALUE
  if [[ "$line" =~ ^([A-Z_][A-Z_0-9]*)=(.*)$ ]]; then
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    # Strip surrounding double quotes
    val="${val%\"}"
    val="${val#\"}"
    # Skip unfilled TODOs
    if [[ "$val" == TODO* ]] || [[ "$val" =~ TODO_ ]]; then
      echo "  skip (unfilled): $key"
      continue
    fi
    # Skip empty values
    [[ -z "$val" ]] && continue
    PAIRS+=("$key=$val")
  fi
done < "$ENV_FILE"

echo "Found ${#PAIRS[@]} secrets to set on $APP"
if $DRY_RUN; then
  for p in "${PAIRS[@]}"; do echo "  - ${p%%=*}"; done
  exit 0
fi

# Push all at once so there's only one redeploy.
echo "Setting secrets on $APP (single redeploy)..."
fly secrets set --app "$APP" --stage "${PAIRS[@]}" >/dev/null

echo
echo "Staged. Now run:"
echo "  fly deploy --app $APP"
