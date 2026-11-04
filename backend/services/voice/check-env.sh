#!/bin/sh
# Refuse to start with a clear message when a required credential is missing.
missing=""
for name in LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET LIVEKIT_VOICE_AGENT_NAME ELEVENLABS_API_KEY FISH_API_KEY FISH_VOICE_ID INTERNAL_AGENTD_TOKEN JUNO_AGENTD_URL; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || missing="$missing $name"
done
if [ -n "$missing" ]; then
  echo "voice worker: not configured, missing:$missing (set them in deploy/.env; see deploy/README.md, Voice calls)" >&2
  exit 64
fi
exec python worker.py start
