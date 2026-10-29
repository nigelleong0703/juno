"""CDP transport for agent-browser: one page session, truthful errors."""
import json
import time
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple

from websocket import create_connection

REQUEST_BUDGET_S = 10.0
MAX_NODES = 200
MAX_NAME_LEN = 120
MAX_TEXT_LEN = 20000


class HelperError(Exception):
    """A truthful failure: the caller sees ok:false, never a receipt."""


class DialogOpen(HelperError):
    """A native dialog opened on the page while waiting on it: the renderer is blocked until it is answered."""
    def __init__(self, dialog):
        # type: (Dict[str, Any]) -> None
        HelperError.__init__(self, "a %s dialog is open on the page" % dialog.get("type", "native"))
        self.dialog = dialog


# How often a CDP wait looks for a dialog that opened meanwhile (see Cdp.interrupt).
DIALOG_POLL_S = 0.25


class Cdp:
    """Minimal synchronous CDP client over one page websocket."""
    def __init__(self, url, deadline):
        # type: (str, float) -> None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise HelperError("request exceeded its 10s budget")
        try:
            self.ws = create_connection(url, timeout=max(0.5, min(5.0, remaining)),
                                        suppress_origin=True)
        except Exception as exc:
            raise HelperError("cannot open CDP websocket: %s" % exc)
        self.next_id = 0
        self.events = []  # type: List[Dict[str, Any]]
        self.deadline = deadline
        # Returns the dialog that opened on this page (from the watcher's state), or None. A blocked
        # renderer never answers, so every wait checks it instead of running into the 10 s budget.
        self.interrupt = None  # type: Optional[Callable[[], Optional[Dict[str, Any]]]]
        # A page session is its own view: an out-of-process iframe is a Session (agent_browser_frames)
        # whose CSS pixels are offset inside the tab's viewport; input always goes to the page.
        self.page = self
        self.offset = (0.0, 0.0)
        self.target = None  # type: Optional[str]
    def close(self):
        # type: () -> None
        try:
            self.ws.close()
        except Exception:
            pass
    def _recv(self, timeout):
        # type: (float) -> Optional[Dict[str, Any]]
        self.ws.settimeout(max(0.05, timeout))
        try:
            raw = self.ws.recv()
        except Exception as exc:
            if "timed out" in str(exc).lower():
                return None
            raise HelperError("CDP connection lost: %s" % exc)
        try:
            return json.loads(raw)
        except ValueError:
            raise HelperError("CDP returned a non-JSON frame")
    def _wait(self):
        # type: () -> Optional[Dict[str, Any]]
        remaining = self.deadline - time.monotonic()
        if self.interrupt is None:
            return self._recv(remaining)
        msg = self._recv(min(DIALOG_POLL_S, remaining))
        if msg is None:
            dialog = self.interrupt()
            if dialog is not None:
                raise DialogOpen(dialog)
        return msg
    def _drain(self, rid, method):
        # type: (int, str) -> Dict[str, Any]
        while True:
            if time.monotonic() >= self.deadline:
                raise HelperError("timed out waiting for CDP %s" % method)
            msg = self._wait()
            if msg is None:
                continue
            if msg.get("id") == rid:
                if "error" in msg:
                    err = msg["error"] or {}
                    if isinstance(err, dict):
                        detail = err.get("message", err)
                    else:
                        detail = err
                    raise HelperError("CDP %s failed: %s" % (method, detail))
                result = msg.get("result")
                return result if isinstance(result, dict) else {}
            if "method" in msg:
                self.events.append(msg)
    def send(self, method, params=None, session=None):
        # type: (str, Optional[Dict[str, Any]], Optional[str]) -> Dict[str, Any]
        """One command; `session` addresses a flattened child session (an out-of-process iframe)."""
        if time.monotonic() >= self.deadline:
            raise HelperError("request exceeded its 10s budget")
        self.next_id += 1
        rid = self.next_id
        msg = {"id": rid, "method": method, "params": params or {}}  # type: Dict[str, Any]
        if session:
            msg["sessionId"] = session
        try:
            self.ws.send(json.dumps(msg))
        except Exception as exc:
            raise HelperError("CDP connection lost: %s" % exc)
        return self._drain(rid, method)
    def wait_event(self, method, match):
        # type: (str, Callable[[Dict[str, Any]], bool]) -> Dict[str, Any]
        while True:
            for i, event in enumerate(self.events):
                params = event.get("params", {})
                if event.get("method") == method and match(params):
                    return self.events.pop(i)
            if time.monotonic() >= self.deadline:
                raise HelperError("timed out waiting for %s" % method)
            msg = self._wait()
            if msg is None:
                continue
            if "method" in msg:
                self.events.append(msg)


def fetch_targets(port, deadline, path="/json/list"):
    # type: (int, float, str) -> Any
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise HelperError("request exceeded its 10s budget")
    url = "http://127.0.0.1:%d%s" % (port, path)
    req = urllib.request.Request(url, headers={"Connection": "close"})
    try:
        with urllib.request.urlopen(req, timeout=max(0.5, min(5.0, remaining))) as resp:
            return json.load(resp)
    except HelperError:
        raise
    except Exception as exc:
        raise HelperError("no CDP on 127.0.0.1:%d (%s)" % (port, exc))


def page_targets(port, deadline):
    # type: (int, float) -> List[Dict[str, Any]]
    """Open, attachable page tabs in DevTools order."""
    targets = fetch_targets(port, deadline)
    if not isinstance(targets, list):
        return []
    return [t for t in targets if isinstance(t, dict) and t.get("type") == "page"
            and t.get("webSocketDebuggerUrl") and isinstance(t.get("id"), str)]


def create_tab(port, deadline):
    # type: (int, float) -> str
    """Open a blank tab through the browser endpoint; returns its target id."""
    version = fetch_targets(port, deadline, "/json/version")
    ws_url = version.get("webSocketDebuggerUrl") if isinstance(version, dict) else None
    if not isinstance(ws_url, str) or not ws_url:
        raise HelperError("CDP on 127.0.0.1:%d exposes no browser endpoint" % port)
    browser = Cdp(ws_url, deadline)
    try:
        target = browser.send("Target.createTarget", {"url": "about:blank"}).get("targetId")
    finally:
        browser.close()
    if not isinstance(target, str) or not target:
        raise HelperError("browser did not open a tab")
    while not any(t["id"] == target for t in page_targets(port, deadline)):
        if time.monotonic() >= deadline:
            raise HelperError("new tab never became attachable")
        time.sleep(0.05)
    return target


def connect(port, deadline, want_target=None, dialog_of=None):
    # type: (int, float, Optional[str], Optional[Callable[[str], Optional[Dict[str, Any]]]]) -> Tuple[Cdp, str]
    """A page session on a tab. `dialog_of(target)` reads the watcher's record of an open dialog:
    one already open fails fast (DialogOpen) instead of hanging on a blocked renderer."""
    targets = fetch_targets(port, deadline)
    found = None  # type: Optional[Dict[str, Any]]
    if isinstance(targets, list):
        for target in targets:
            if (isinstance(target, dict) and target.get("type") == "page"
                    and target.get("webSocketDebuggerUrl")
                    and (want_target is None or target.get("id") == want_target)):
                found = target
                break
    if found is None and want_target is not None:
        raise HelperError("ref belongs to a closed tab; take a fresh snapshot")
    if found is None:
        raise HelperError("no open page on 127.0.0.1:%d" % port)
    target_id = str(found.get("id") or "")
    if dialog_of is not None:
        dialog = dialog_of(target_id)
        if dialog is not None:
            raise DialogOpen(dialog)
    cdp = Cdp(found["webSocketDebuggerUrl"], deadline)
    if dialog_of is not None:
        cdp.interrupt = lambda: dialog_of(target_id)
    try:
        cdp.send("Page.enable")
        cdp.send("Page.setLifecycleEventsEnabled", {"enabled": True})
        cdp.send("DOM.enable")
        cdp.send("Accessibility.enable")
        info = cdp.send("Target.getTargetInfo").get("targetInfo", {})
    except DialogOpen:
        cdp.close()
        raise
    except HelperError as exc:
        cdp.close()
        if "Page.enable" in str(exc):
            raise HelperError("the page is not responding (a dialog may have opened before the browser"
                              " helper was watching it); take a computer.screenshot")
        raise HelperError("page detached or closing: %s" % exc)
    if info.get("targetId", "") != target_id:
        cdp.close()
        raise HelperError("page detached or closing: no target id")
    return cdp, target_id


def main_frame(cdp):
    # type: (Cdp) -> Dict[str, Any]
    tree = cdp.send("Page.getFrameTree")
    frame = (tree.get("frameTree") or {}).get("frame")
    if not isinstance(frame, dict):
        raise HelperError("CDP Page.getFrameTree returned no frame")
    return frame


def frame_url(frame):
    # type: (Dict[str, Any]) -> str
    url = frame.get("url", "")
    if not isinstance(url, str):
        url = ""
    fragment = frame.get("urlFragment", "")
    if isinstance(fragment, str) and fragment:
        if not fragment.startswith("#"):
            fragment = "#" + fragment
        url = url.split("#")[0] + fragment
    return url


def page_identity(cdp):
    # type: (Cdp) -> Tuple[str, str]
    url = frame_url(main_frame(cdp))
    info = cdp.send("Target.getTargetInfo").get("targetInfo", {})
    title = info.get("title", "")
    if not isinstance(title, str):
        title = ""
    return url, title
