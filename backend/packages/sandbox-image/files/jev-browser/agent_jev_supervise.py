#!/usr/bin/env python3
"""Root-only supervisor for the original jev-browser MCP on an agent's existing Chromium."""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse

# This must precede importing the watcher/ref modules: STATE_ROOT is captured at import time.
os.environ["AGENT_BROWSER_STATE"] = "/run/juno/browser"
sys.path.insert(0, "/usr/local/bin")
from agent_browser_mask import redact_deep
from agent_browser_watch import ask_watcher, ensure_watcher


def fail(message):
    sys.stderr.write("jev supervisor: " + str(message) + "\n")
    sys.stderr.flush()
    sys.exit(1)


def read_cdp():
    explicit = os.environ.get("JUNO_JEV_CDP", "")
    try:
        parsed = urllib.parse.urlparse(explicit)
        port = int(parsed.port or 0)
    except Exception:
        fail("no live Chromium for this agent")
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.username
            or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/")
            or port <= 0 or port > 65535):
        fail("no live Chromium for this agent")
    return "http://127.0.0.1:" + str(port), port


def watcher_secrets(port):
    deadline = time.monotonic() + 5.0
    try:
        if not ensure_watcher(port, deadline):
            fail("watcher unavailable")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            fail("watcher unavailable")
        reply = ask_watcher(port, {"op": "secrets"}, remaining)
    except SystemExit:
        raise
    except Exception:
        fail("watcher unavailable")
    values = reply.get("values") if isinstance(reply, dict) else None
    if not isinstance(values, list):
        fail("watcher unavailable")
    return [value for value in values if isinstance(value, str) and value]


def redact_value(port, value):
    try:
        return redact_deep(value, watcher_secrets(port))
    except SystemExit:
        raise
    except Exception:
        fail("redaction failed")


def redact_native_value(port, value):
    """Native state is sometimes a JSON string; redact its structure, including exact short values."""
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            parsed = None
        if isinstance(parsed, (dict, list)):
            try:
                return json.dumps(redact_deep(parsed, watcher_secrets(port)), separators=(",", ":"))
            except SystemExit:
                raise
            except Exception:
                fail("redaction failed")
    return redact_value(port, value)


def redact_frame(port, frame):
    if not isinstance(frame, dict):
        return frame
    if frame.get("method") == "juno/jev":
        params = frame.get("params")
        if isinstance(params, dict):
            outgoing = dict(params)
            for key in ("state", "questions"):
                if key in outgoing:
                    outgoing[key] = redact_native_value(port, outgoing[key])
            frame["params"] = outgoing
    for key in ("result", "error"):
        if key in frame:
            frame[key] = redact_value(port, frame[key])
    return frame


def pump_stdin(child):
    try:
        while True:
            line = sys.stdin.buffer.readline()
            if not line:
                break
            child.stdin.write(line)
            child.stdin.flush()
    except Exception:
        fail("supervisor input failed")
    finally:
        try:
            child.stdin.close()
        except Exception:
            pass


def main():
    endpoint, port = read_cdp()
    env = dict(os.environ)
    env["JUNO_JEV_CDP"] = endpoint
    env["AGENT_BROWSER_STATE"] = "/run/juno/browser"
    env["JEV_BROWSER_NO_INSTALL"] = "1"
    env["JEV_BROWSER_MCP"] = "1"
    if not env.get("TYPESAFE_API_KEY"):
        env["TYPESAFE_API_KEY"] = "placeholder-juno-relay-not-a-key"
    command = [
        "/usr/bin/node",
        "--import",
        "/opt/juno/jev-browser/jev-preload.mjs",
        "/opt/juno/jev-browser/upstream/bin/jev-browser-mcp.mjs",
    ]
    child = subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr,
        env=env, bufsize=1,
    )
    if child.stdin is None or child.stdout is None:
        fail("supervisor pipe failed")
    threading.Thread(target=pump_stdin, args=(child,), daemon=True).start()
    out = sys.stdout
    try:
        for raw in child.stdout:
            try:
                line = raw.decode("utf-8", "replace")
            except Exception:
                continue
            stripped = line.strip()
            if not stripped:
                continue
            try:
                frame = json.loads(stripped)
            except Exception:
                out.write(str(redact_value(port, line)) + "\n")
                out.flush()
                continue
            out.write(json.dumps(redact_frame(port, frame)) + "\n")
            out.flush()
    finally:
        try:
            child.wait(timeout=5)
        except Exception:
            try:
                child.kill()
            except Exception:
                pass
    sys.exit(child.returncode or 0)


if __name__ == "__main__":
    main()
