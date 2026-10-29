#!/usr/bin/env bash
# Generates the production secrets into the server env file, once.
# Usage: scripts/deploy/secrets.sh [env-file]   (default: ~/.config/juno/server.env)
#
# A secret that is already in the file is never touched. A key that is present but empty stops the script:
# fill it in or delete the line, then run again. The file is created with mode 600 if it does not exist.
set -euo pipefail

env_file="${1:-$HOME/.config/juno/server.env}"
mkdir -p "$(dirname "$env_file")"
if [ ! -e "$env_file" ]; then
  (umask 077 && : > "$env_file")
fi
chmod 600 "$env_file"

# name:generator. SECRETS_KEY must be 32 random bytes in base64 (see packages/juno-agent/src/contracts/secrets.ts).
secrets=(
  "SECRETS_KEY:openssl rand -base64 32"
  "SCREEN_TICKET_SECRET:openssl rand -hex 32"
  "ARTIFACT_URL_SECRET:openssl rand -hex 32"
  "SPACE_URL_SECRET:openssl rand -hex 32"
  "COMPUTERD_TOKEN:openssl rand -hex 32"
  "INTERNAL_AGENTD_TOKEN:openssl rand -hex 32"
  "BETTER_AUTH_SECRET:openssl rand -hex 32"
)

for entry in "${secrets[@]}"; do
  name="${entry%%:*}"
  generator="${entry#*:}"
  if grep -Eq "^${name}=.+" "$env_file"; then
    echo "kept    $name (already set)"
  elif grep -q "^${name}=" "$env_file"; then
    echo "error: $name is present but empty in $env_file; fill it in or delete the line" >&2
    exit 1
  else
    printf '%s=%s\n' "$name" "$($generator)" >> "$env_file"
    echo "created $name"
  fi
done

echo
echo "WARNING: SECRETS_KEY cannot be rotated. Changing or losing it makes every stored encrypted value" >&2
echo "(MCP credentials) unreadable. Back up $env_file." >&2
