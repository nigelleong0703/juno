"""Out-of-process (cross-origin) iframes: Google sign-in, payment fields, captchas.

Chromium runs a cross-site iframe in another renderer, so it is missing from the tab's own frame
tree and accessibility tree. It is its own CDP target ("iframe"), reachable from the tab's session
through flattened auto-attach: Target.setAutoAttach {flatten: true} attaches every child frame
target and its commands go over the same websocket with a sessionId. A Session below is used like a
Cdp for reading (AX tree, frame tree, box model of its own nodes). Its CSS pixels start at the
iframe's content box inside its parent, so `offset` (the sum along the iframe chain, from
DOM.getFrameOwner + DOM.getBoxModel in each parent) maps them into the tab's viewport, where input
is dispatched (Chromium routes a page-level mouse event to the iframe under it) and where
agent_browser_bounds maps to screen pixels. Assumes untransformed, unscaled iframes.
"""
from typing import Any, Dict, List, Optional, Tuple

from agent_browser_cdp import Cdp, HelperError

# Bounded so a page full of ad iframes stays inside the request budget.
MAX_OOPIFS = 12


class Session(object):
    def __init__(self, page, session, target, offset):
        # type: (Cdp, str, str, Tuple[float, float]) -> None
        self.page = page
        self.session = session
        self.target = target
        self.offset = offset
    def send(self, method, params=None):
        # type: (str, Optional[Dict[str, Any]]) -> Dict[str, Any]
        return self.page.send(method, params, self.session)


def owner_offset(parent, frame_id):
    # type: (Any, str) -> Tuple[float, float]
    """Where a child frame's viewport starts, in the tab's CSS pixels."""
    owner = parent.send("DOM.getFrameOwner", {"frameId": frame_id}).get("backendNodeId")
    box = parent.send("DOM.getBoxModel", {"backendNodeId": owner}).get("model") or {}
    quad = box.get("content")
    if not isinstance(quad, list) or len(quad) < 8:
        raise HelperError("iframe is not rendered")
    return (parent.offset[0] + min(float(quad[i]) for i in (0, 2, 4, 6)),
            parent.offset[1] + min(float(quad[i]) for i in (1, 3, 5, 7)))


def _session_id(view):
    # type: (Any) -> Optional[str]
    return view.session if isinstance(view, Session) else None


def oopif_sessions(page):
    # type: (Cdp) -> List[Session]
    """Attach to the tab's cross-origin iframes (nested ones too), breadth first, bounded.

    Once per connection: a second Target.setAutoAttach reports nothing already attached."""
    cached = getattr(page, "oopifs", None)
    if cached is not None:
        return cached
    out = []  # type: List[Session]
    page.oopifs = out
    parents = [page]  # type: List[Any]
    while parents and len(out) < MAX_OOPIFS:
        parent = parents.pop(0)
        sid = _session_id(parent)
        page.send("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": False, "flatten": True}, sid)
        attached = [e for e in page.events if e.get("method") == "Target.attachedToTarget"
                    and (e.get("sessionId") or None) == sid]
        for event in attached:
            page.events.remove(event)
            params = event.get("params") or {}
            info = params.get("targetInfo") or {}
            if info.get("type") != "iframe" or len(out) >= MAX_OOPIFS:
                continue
            try:
                child = Session(page, params["sessionId"], info["targetId"], owner_offset(parent, info["targetId"]))
                child.send("DOM.enable")
            except (HelperError, KeyError, TypeError, ValueError):
                continue  # not rendered (display:none) or gone meanwhile: nothing to act on
            out.append(child)
            parents.append(child)
    return out


def view_for(page, oopif):
    # type: (Cdp, Optional[str]) -> Any
    """The page itself, or the session of the cross-origin iframe a ref was minted in."""
    if not oopif:
        return page
    for child in oopif_sessions(page):
        if child.target == oopif:
            return child
    raise HelperError("stale ref: its iframe is gone; take a fresh browser.snapshot")
