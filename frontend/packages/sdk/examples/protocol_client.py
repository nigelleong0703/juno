"""One chat turn with Juno from Python, over `juno serve` (see ../PROTOCOL.md).

  pnpm --filter @juno/sdk build
  JUNO_BASE_URL=... JUNO_TOKEN=... JUNO_AGENT_ID=... python3 examples/protocol_client.py
Set JUNO_CLI to the juno command when it is not packages/sdk/dist/cli.js.
"""

import json
import os
import subprocess

# The server comes from JUNO_BASE_URL and JUNO_TOKEN, which the child process inherits.
cmd = ["node", os.environ.get("JUNO_CLI", "dist/cli.js"), "serve"]
proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8")
next_id = 0


def call(method, params=None):
    """Writes one request and returns its id."""
    global next_id
    next_id += 1
    proc.stdin.write(json.dumps({"id": next_id, "method": method, "params": params or {}}) + "\n")
    proc.stdin.flush()
    return next_id


def result_of(request_id):
    """Reads lines until this request's answer arrives; notifications seen meanwhile are skipped."""
    while True:
        message = json.loads(proc.stdout.readline())
        if message.get("id") == request_id:
            if "error" in message:
                raise SystemExit(f"{message['error']['code']}: {message['error']['message']}")
            return message["result"]


result_of(call("initialize", {"protocolVersion": 1}))
chat_id = result_of(call("chat.open", {"agentId": os.environ["JUNO_AGENT_ID"]}))["chatId"]
turn = result_of(call("chat.send", {"chatId": chat_id, "text": "What can you help me with today?"}))["turnId"]

while True:
    message = json.loads(proc.stdout.readline())
    if message.get("method") == "turn.failed":
        raise SystemExit(f"turn failed: {message['params']['error']}")
    if message.get("method") != "event" or message["params"]["turn"] != turn:
        continue
    event = message["params"]["event"]
    if event["type"] == "text-delta":
        print(event["text"], end="", flush=True)
    elif event["type"] == "request":
        # This client denies every approval. A real client asks its owner here.
        call("chat.resolve", {"requestId": event["request"]["id"], "decision": {"action": "deny"}})
    elif event["type"] == "done":
        print(f"\n[run {event['run']['status']}]")
        break

result_of(call("shutdown"))
proc.stdin.close()
proc.wait()
