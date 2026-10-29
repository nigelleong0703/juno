"""Browser watcher: one long-lived process per CDP port that sees what a page does between helper calls.

Why it exists. Each agent-browser call is its own short process, but a page can open a native
dialog (alert/confirm/prompt/beforeunload) at any time, for example after an XHR that follows
"Add to cart". While a dialog is open the renderer is blocked: Page.enable, Runtime.evaluate and
input events all hang. Chromium only reports a dialog (Page.javascriptDialogOpening) to sessions
that had the Page domain enabled when it opened, and only such a session can answer it
(Page.handleJavaScriptDialog says "No dialog is showing" to a later one). So this watcher keeps
the Page domain enabled on every tab, the way Playwright's persistent connection does (each tab is
attached explicitly with Target.attachToTarget on Target.targetCreated; browser-level auto-attach
stalled window.open popups at an empty URL in tests), and:

  * records the open dialog per tab in the port state file (agent_browser_refs.port_state), where
    every helper call checks it before touching the page and while waiting on CDP;
  * accepts a plain alert() at once (it has one button and only shows a message; leaving it open
    would block the page) and queues its message so the next helper result reports it.
    confirm/prompt/beforeunload are never answered here: they may confirm something destructive,
    so the agent decides through browser.dialog (the purchase gate sees the message);
  * records tabs that open (with their opener: window.open, target=_blank, OAuth popups) and close,
    so the helper reports them and follows a popup, then returns to its opener when it closes;
  * answers browser.dialog requests from the helper over a unix socket next to the state file;
  * holds the values of secure fills (agent_browser_mask) in memory only, runs the masking script in an isolated
    world on every tab it watches (also on later pages), and hands the values to the helper so it can redact them.

It exits when Chromium's endpoint closes; the next helper call starts a new one.
"""
import fcntl
import json
import os
import socket
import subprocess
import sys
import threading
import time
from typing import Any, Dict, List, Optional

from agent_browser_cdp import HelperError, fetch_targets
from agent_browser_mask import MAX_SECRETS, WORLD, clean_values, mask_script
from agent_browser_refs import STATE_ROOT, port_state

MAX_EVENTS = 50
MAX_MESSAGE = 500


def sock_path(port):
    # type: (int) -> str
    return os.path.join(STATE_ROOT, "%d.sock" % port)


def pid_path(port):
    # type: (int) -> str
    return os.path.join(STATE_ROOT, "%d.watch.pid" % port)


def watcher_alive(port):
    # type: (int) -> bool
    """A watcher answers on its socket. (A pid check is not enough: under a container init that
    never reaps, a dead watcher stays a zombie whose pid still exists.)"""
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(0.5)
    try:
        probe.connect(sock_path(port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


def ensure_watcher(port, deadline):
    # type: (int, float) -> bool
    """Start the watcher for this port unless one runs; True once it is attached."""
    if watcher_alive(port):
        return True
    os.makedirs(STATE_ROOT, mode=0o700, exist_ok=True)
    log = open(os.path.join(STATE_ROOT, "%d.watch.log" % port), "a")
    subprocess.Popen([sys.executable, os.path.abspath(__file__), str(port)], stdin=subprocess.DEVNULL,
                     stdout=log, stderr=log, close_fds=True, start_new_session=True)
    log.close()
    wait_until = min(deadline - 1.0, time.monotonic() + 2.0)
    while time.monotonic() < wait_until:
        if watcher_alive(port):
            return True
        time.sleep(0.05)
    return False


def ask_watcher(port, request, timeout):
    # type: (int, Dict[str, Any], float) -> Dict[str, Any]
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(max(0.5, timeout))
    try:
        client.connect(sock_path(port))
        client.sendall((json.dumps(request) + "\n").encode("utf-8"))
        data = b""
        while not data.endswith(b"\n"):
            chunk = client.recv(65536)
            if not chunk:
                break
            data += chunk
    except OSError as exc:
        raise HelperError("the browser watcher did not answer: %s" % exc)
    finally:
        client.close()
    try:
        reply = json.loads(data.decode("utf-8"))
    except ValueError:
        raise HelperError("the browser watcher sent no answer")
    if not reply.get("ok"):
        raise HelperError(reply.get("error") or "the browser watcher refused")
    return reply


class Watcher(object):
    def __init__(self, port):
        # type: (int) -> None
        from websocket import create_connection
        version = fetch_targets(port, time.monotonic() + 5.0, "/json/version")
        self.port = port
        self.ws = create_connection(version["webSocketDebuggerUrl"], suppress_origin=True, timeout=None)
        self.lock = threading.Lock()
        self.next_id = 0
        self.waiting = {}  # type: Dict[int, Any]
        self.sessions = {}  # type: Dict[str, str]  session id -> target id
        self.openers = {}  # type: Dict[str, str]  target id -> opener target id
        self.ready = False
        self.secrets = []  # type: List[str]  filled secure values; never written anywhere
        self.mask_ids = {}  # type: Dict[str, str]  session id -> registered masking script
        self.mask_lock = threading.Lock()

    def send(self, method, params=None, session=None, wait=0.0):
        # type: (str, Optional[Dict[str, Any]], Optional[str], float) -> Dict[str, Any]
        with self.lock:
            self.next_id += 1
            rid = self.next_id
            msg = {"id": rid, "method": method, "params": params or {}}  # type: Dict[str, Any]
            if session:
                msg["sessionId"] = session
            box = {"event": threading.Event()}  # type: Dict[str, Any]
            self.waiting[rid] = box
            self.ws.send(json.dumps(msg))
        if wait <= 0 or not box["event"].wait(wait):
            return {}
        if "error" in box:
            raise HelperError(str((box["error"] or {}).get("message", box["error"])))
        return box.get("result") or {}

    def record(self, change):
        # type: (Any) -> None
        with port_state(self.port) as state:
            change(state)

    def event(self, state, entry):
        # type: (Dict[str, Any], Dict[str, Any]) -> None
        state["seq"] = state.get("seq", 0) + 1
        entry["seq"] = state["seq"]
        events = state.setdefault("events", [])
        events.append(entry)
        del events[:-MAX_EVENTS]

    def on_event(self, msg):
        # type: (Dict[str, Any]) -> None
        method = msg.get("method")
        params = msg.get("params") or {}
        target = self.sessions.get(msg.get("sessionId") or "", "")
        if method == "Target.attachedToTarget":
            info = params.get("targetInfo") or {}
            if info.get("type") == "page":
                self.sessions[params["sessionId"]] = info.get("targetId", "")
                # No wait: on a page whose dialog opened before we attached this never answers.
                self.send("Page.enable", session=params["sessionId"])
                if self.secrets:
                    # The reader thread must not wait for replies, so a late tab gets its mask from a thread.
                    threading.Thread(target=self.install_mask, args=(params["sessionId"],), daemon=True).start()
        elif method == "Target.targetCreated":
            info = params.get("targetInfo") or {}
            if info.get("type") == "page":
                self.send("Target.attachToTarget", {"targetId": info.get("targetId"), "flatten": True})
            if info.get("type") == "page" and info.get("openerId"):
                self.openers[info["targetId"]] = info["openerId"]
                if not self.ready:
                    return  # an existing tab listed at start, not one that just opened
                self.record(lambda s: self.event(s, {"kind": "opened", "target": info["targetId"],
                                                     "opener": info["openerId"]}))
        elif method == "Target.targetDestroyed":
            tid = params.get("targetId", "")
            opener = self.openers.pop(tid, None)
            def closed(state):
                # type: (Dict[str, Any]) -> None
                state.get("dialogs", {}).pop(tid, None)
                if opener:
                    handle = next((h for h, t in state.get("tabs", {}).items() if t == tid), "")
                    self.event(state, {"kind": "closed", "target": tid, "opener": opener, "handle": handle})
            self.record(closed)
        elif method == "Page.javascriptDialogOpening" and target:
            self.on_dialog(msg["sessionId"], target, params)
        elif method == "Page.javascriptDialogClosed" and target:
            self.record(lambda s: s.get("dialogs", {}).pop(target, None))

    def on_dialog(self, session, target, params):
        # type: (str, str, Dict[str, Any]) -> None
        kind = params.get("type") if params.get("type") in ("alert", "confirm", "prompt", "beforeunload") else "alert"
        message = str(params.get("message") or "")[:MAX_MESSAGE]
        if kind == "alert":
            self.send("Page.handleJavaScriptDialog", {"accept": True}, session)
            self.record(lambda s: self.event(s, {"kind": "alert", "target": target, "message": message}))
            return
        dialog = {"type": kind, "message": message, "url": str(params.get("url") or "")}
        if kind == "prompt":
            dialog["defaultPrompt"] = str(params.get("defaultPrompt") or "")[:MAX_MESSAGE]
        self.record(lambda s: s.setdefault("dialogs", {}).__setitem__(target, dialog))

    def install_mask(self, session):
        # type: (str) -> None
        """(Re)register the masking script, with all secrets so far, in this tab's isolated world."""
        with self.mask_lock:
            old = self.mask_ids.get(session)
            if old:
                try:
                    self.send("Page.removeScriptToEvaluateOnNewDocument", {"identifier": old}, session, wait=3.0)
                except HelperError:
                    pass
            added = self.send("Page.addScriptToEvaluateOnNewDocument",
                              {"source": mask_script(self.secrets), "worldName": WORLD, "runImmediately": True},
                              session, wait=5.0)
            if added.get("identifier"):
                self.mask_ids[session] = added["identifier"]
            else:
                raise HelperError("a tab did not take the secure-input mask")

    def mask(self, values):
        # type: (List[str]) -> Dict[str, Any]
        for value in values:
            if value not in self.secrets:
                self.secrets.append(value)
        del self.secrets[:-MAX_SECRETS]
        tabs = set(t["id"] for t in fetch_targets(self.port, time.monotonic() + 5.0) if isinstance(t, dict))
        for session, target in list(self.sessions.items()):
            if target in tabs:
                self.install_mask(session)
        return {"ok": True}

    def handle(self, request):
        # type: (Dict[str, Any]) -> Dict[str, Any]
        if request.get("op") == "mask":
            return self.mask(clean_values(request.get("values")))
        if request.get("op") == "secrets":
            return {"ok": True, "values": list(self.secrets)}
        target = request.get("target")
        session = next((sid for sid, tid in self.sessions.items() if tid == target), None)
        if session is None:
            raise HelperError("this tab is not watched; take a computer.screenshot")
        params = {"accept": bool(request.get("accept"))}  # type: Dict[str, Any]
        if isinstance(request.get("promptText"), str):
            params["promptText"] = request["promptText"]
        self.send("Page.handleJavaScriptDialog", params, session, wait=3.0)
        self.record(lambda s: s.get("dialogs", {}).pop(target, None))
        return {"ok": True}

    def serve(self):
        # type: () -> None
        path = sock_path(self.port)
        try:
            os.unlink(path)
        except OSError:
            pass
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(path)
        os.chmod(path, 0o600)
        server.listen(4)
        while True:
            conn, _addr = server.accept()
            try:
                conn.settimeout(5.0)
                line = conn.makefile("r").readline()
                if not line:
                    continue  # a liveness probe (watcher_alive)
                try:
                    reply = self.handle(json.loads(line))
                except (HelperError, ValueError) as exc:
                    reply = {"ok": False, "error": str(exc)}
                conn.sendall((json.dumps(reply) + "\n").encode("utf-8"))
            except OSError:
                pass
            finally:
                conn.close()

    def run(self):
        # type: () -> None
        def fresh(state):
            # type: (Dict[str, Any]) -> None
            state["dialogs"] = {}  # a dialog recorded by an earlier watcher is no longer known
        self.record(fresh)
        reader = threading.Thread(target=self.read_loop)
        reader.daemon = True
        reader.start()
        self.send("Target.setDiscoverTargets", {"discover": True}, wait=2.0)
        self.ready = True
        server = threading.Thread(target=self.serve)
        server.daemon = True
        server.start()
        while not os.path.exists(sock_path(self.port)):
            time.sleep(0.02)
        with open(pid_path(self.port), "w") as handle:
            handle.write(str(os.getpid()))
        reader.join()

    def read_loop(self):
        # type: () -> None
        while True:
            try:
                msg = json.loads(self.ws.recv())
            except Exception:
                return  # Chromium went away: exit; the next helper call starts a new watcher
            if "id" in msg:
                box = self.waiting.pop(msg["id"], None)
                if box is not None:
                    box.update({k: msg[k] for k in ("result", "error") if k in msg})
                    box["event"].set()
            elif "method" in msg:
                try:
                    self.on_event(msg)
                except Exception as exc:  # one bad event must not stop the watcher
                    print("watcher event %s failed: %s" % (msg.get("method"), exc), flush=True)


def main():
    # type: () -> int
    port = int(sys.argv[1])
    # One watcher per port for its whole life: two helper calls may both start one.
    guard = open(os.path.join(STATE_ROOT, "%d.watch.lock" % port), "a")
    try:
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return 0
    try:
        Watcher(port).run()
    finally:
        try:
            with open(pid_path(port)) as handle:
                mine = handle.read().strip() == str(os.getpid())
        except OSError:
            mine = False
        # A newer watcher may already own these paths; only clean up our own.
        for path in ((pid_path(port), sock_path(port)) if mine else ()):
            try:
                os.unlink(path)
            except OSError:
                pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
