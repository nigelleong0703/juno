#!/usr/bin/env python3
"""Redact a structured original-MCP value against the root browser watcher. Never returns secrets."""
import json
import sys
import time

import os
os.environ["AGENT_BROWSER_STATE"] = "/run/juno/browser"
sys.path.insert(0, "/usr/local/bin")
from agent_browser_mask import redact_deep
from agent_browser_watch import ask_watcher, ensure_watcher


def main():
    if len(sys.argv) != 2:
        raise SystemExit("expected one CDP port")
    port = int(sys.argv[1])
    deadline = time.monotonic() + 5.0
    if not ensure_watcher(port, deadline):
        raise SystemExit("browser watcher unavailable")
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise SystemExit("browser watcher unavailable")
    reply = ask_watcher(port, {"op": "secrets"}, remaining)
    values = reply.get("values") if isinstance(reply, dict) else None
    if not isinstance(values, list):
        raise SystemExit("browser watcher returned no secret set")
    secrets = [value for value in values if isinstance(value, str) and value]
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    value = json.load(sys.stdin)
    print(json.dumps(redact_deep(value, secrets), ensure_ascii=False), end="")


if __name__ == "__main__":
    main()
