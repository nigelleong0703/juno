"""bounds: where page controls are on the screen, in VNC framebuffer pixels.

Three uses: the control under a screen point (`point`: the purchase gate on
coordinate clicks, the inverse mapping below), the rect of the element an agent is stuck on (refs given; the
agent still controls the screen, so its tab is brought to the front and the
element scrolled into view), and the tap targets of whatever tab the user is
looking at while they control the screen (no refs; read-only, nothing is
scrolled, focused or minted as a ref).

Coordinate mapping. DOM.getBoxModel returns quads in CSS pixels of the
top-level viewport (already scrolled; same-process iframes included); a node
of a cross-origin iframe is measured in that iframe's session and shifted by
the iframe's offset (agent_browser_frames). To get framebuffer pixels:

  * Page zoom Z = devicePixelRatio / device scale factor. Agent displays run
    Xvfb at 96 dpi and Chromium without --force-device-scale-factor, so the
    device scale factor is 1: screen coordinates (screenX, outerWidth, ...)
    are already framebuffer pixels and Z = devicePixelRatio.
  * The viewport is the lower part of the browser window: the tab strip and
    toolbar sit on top, and a border of equal width (0 when maximized) on the
    left, right and bottom. In framebuffer pixels the viewport is
    iw*Z x ih*Z, its left edge is screenX + (outerWidth - iw*Z) / 2 and its
    top edge is screenY + outerHeight - ih*Z - that same border.
  * A CSS rect (x, y, w, h) is then (left + x*Z, top + y*Z, w*Z, h*Z),
    clipped to the viewport; an element with nothing left is not on screen.
"""
from typing import Any, Dict, List, Optional, Tuple

from agent_browser_cdp import Cdp, HelperError, MAX_NAME_LEN, page_identity
from agent_browser_frames import oopif_sessions
from agent_browser_nav import find_ax_node, interactive_nodes, page_frames
from agent_browser_refs import INTERACTIVE_ROLES, _ax_str, check_fresh

EXPR_WINDOW = ("({sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight,"
               " iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio,"
               " vis: document.visibilityState})")

# Tap targets for one screen: enough for a dense page, bounded so the box
# lookups (one CDP round trip each) stay well inside the request budget.
MAX_ELEMENTS = 300
MAX_BOX_LOOKUPS = 1500


def window_metrics(cdp):
    # type: (Cdp) -> Dict[str, Any]
    res = cdp.send("Runtime.evaluate", {"expression": EXPR_WINDOW, "returnByValue": True})
    value = (res.get("result") or {}).get("value")
    if not isinstance(value, dict):
        raise HelperError("could not read the browser window position")
    for key in ("sx", "sy", "ow", "oh", "iw", "ih", "dpr"):
        if not isinstance(value.get(key), (int, float)) or isinstance(value.get(key), bool):
            raise HelperError("could not read the browser window position")
    return value


def viewport_origin(metrics):
    # type: (Dict[str, Any]) -> Tuple[float, float, float, float, float]
    """(left, top, width, height, zoom) of the viewport in framebuffer pixels."""
    zoom = float(metrics["dpr"]) or 1.0
    width = float(metrics["iw"]) * zoom
    height = float(metrics["ih"]) * zoom
    border = max(0.0, (float(metrics["ow"]) - width) / 2.0)
    left = float(metrics["sx"]) + border
    top = float(metrics["sy"]) + float(metrics["oh"]) - height - border
    return left, top, width, height, zoom


def screen_rect(quad, metrics):
    # type: (Any, Dict[str, Any]) -> Optional[Dict[str, int]]
    """A CSS-pixel box quad as a framebuffer rect clipped to the viewport, or None when off screen."""
    if not isinstance(quad, list) or len(quad) < 8:
        return None
    try:
        xs = [float(quad[i]) for i in (0, 2, 4, 6)]
        ys = [float(quad[i]) for i in (1, 3, 5, 7)]
    except (TypeError, ValueError):
        return None
    left, top, width, height, zoom = viewport_origin(metrics)
    x0 = max(left + min(xs) * zoom, left)
    y0 = max(top + min(ys) * zoom, top)
    x1 = min(left + max(xs) * zoom, left + width)
    y1 = min(top + max(ys) * zoom, top + height)
    x0, y0 = int(round(max(0.0, x0))), int(round(max(0.0, y0)))
    x1, y1 = int(round(x1)), int(round(y1))
    if x1 - x0 < 1 or y1 - y0 < 1:
        return None
    return {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}


def box_quad(view, backend_id):
    # type: (Any, int) -> Any
    """A node's border quad in the tab's CSS pixels (a cross-origin iframe view adds its offset)."""
    try:
        box = view.send("DOM.getBoxModel", {"backendNodeId": backend_id})
    except HelperError:
        return None  # not rendered (display:none, detached)
    quad = (box.get("model") or {}).get("border")
    if not isinstance(quad, list) or len(quad) < 8:
        return quad
    dx, dy = view.offset
    return [float(v) + (dx if i % 2 == 0 else dy) for i, v in enumerate(quad[:8])]


def visible_elements(cdp):
    # type: (Cdp) -> List[Dict[str, Any]]
    """Interactive AX nodes of this tab that are on screen now; read-only."""
    metrics = window_metrics(cdp)
    out = []  # type: List[Dict[str, Any]]
    lookups = 0
    for view in [cdp] + oopif_sessions(cdp):
        try:
            frames = page_frames(view)
        except HelperError:
            continue
        for entry in interactive_nodes(view, frames):
            if "heading" in entry:
                continue  # a context line, not a tap target
            if len(out) >= MAX_ELEMENTS or lookups >= MAX_BOX_LOOKUPS:
                return out
            lookups += 1
            rect = screen_rect(box_quad(view, entry["node"]), metrics)
            if rect is not None:
                out.append({"rect": rect, "role": entry["role"], "name": entry["name"]})
    return out


def is_visible_tab(cdp):
    # type: (Cdp) -> bool
    try:
        return window_metrics(cdp).get("vis") == "visible"
    except HelperError:
        return False


def ref_element(view, frame_id, loader_id, backend_id, ref):
    # type: (Any, str, str, int, str) -> Dict[str, Any]
    """The rect of one ref, brought on screen first (the agent controls the screen)."""
    check_fresh(view, frame_id, loader_id)
    view.page.send("Page.bringToFront")
    view.send("DOM.scrollIntoViewIfNeeded", {"backendNodeId": backend_id})
    rect = screen_rect(box_quad(view, backend_id), window_metrics(view.page))
    if rect is None:
        raise HelperError("ref %s is not visible on the screen" % ref)
    node = find_ax_node(view, backend_id, frame_id) or {}
    return {"ref": ref, "rect": rect, "role": _ax_str(node.get("role")) or "generic",
            "name": _ax_str(node.get("name"))[:MAX_NAME_LEN]}


def bounds_result(cdp, elements):
    # type: (Any, List[Dict[str, Any]]) -> Dict[str, Any]
    url, title = page_identity(cdp.page)
    return {"ok": True, "action": "bounds", "url": url, "title": title, "elements": elements}


def css_point(x, y, metrics):
    # type: (float, float, Dict[str, Any]) -> Optional[Tuple[float, float]]
    """The inverse of screen_rect: a framebuffer point as the tab's CSS pixels, or None outside the viewport."""
    left, top, width, height, zoom = viewport_origin(metrics)
    if not (left <= x < left + width and top <= y < top + height):
        return None
    return (x - left) / zoom, (y - top) / zoom


# Walking up from the hit node to the control it belongs to (text inside a button, an icon in a link).
MAX_ANCESTORS = 12


def control_label(view, backend_id):
    # type: (Any, int) -> Optional[Dict[str, str]]
    """Role and accessible name of the interactive element containing a DOM node, if any."""
    tree = view.send("Accessibility.getPartialAXTree", {"backendNodeId": backend_id, "fetchRelatives": True})
    nodes = [n for n in tree.get("nodes") or [] if isinstance(n, dict)]
    by_id = dict((n.get("nodeId"), n) for n in nodes)
    node = next((n for n in nodes if n.get("backendDOMNodeId") == backend_id), nodes[-1] if nodes else None)
    for _ in range(MAX_ANCESTORS):
        if node is None:
            return None
        role = _ax_str(node.get("role"))
        if role in INTERACTIVE_ROLES:
            return {"role": role, "name": _ax_str(node.get("name"))[:MAX_NAME_LEN]}
        node = by_id.get(node.get("parentId"))
    return None


def element_at(cdp, x, y):
    # type: (Cdp, float, float) -> Optional[Dict[str, str]]
    """The control a click at framebuffer point (x, y) would hit on this tab, descending into
    cross-origin iframes; None when the point is outside the page or on no control."""
    point = css_point(x, y, window_metrics(cdp))
    if point is None:
        return None
    view = cdp  # type: Any
    for _ in range(4):
        local = {"x": int(point[0] - view.offset[0]), "y": int(point[1] - view.offset[1]),
                 "includeUserAgentShadowDOM": False, "ignorePointerEventsNone": True}
        try:
            backend = view.send("DOM.getNodeForLocation", local).get("backendNodeId")
        except HelperError:
            return None
        if not isinstance(backend, int):
            return None
        frame = (view.send("DOM.describeNode", {"backendNodeId": backend}).get("node") or {}).get("frameId")
        child = next((s for s in oopif_sessions(cdp) if frame and s.target == frame), None)
        if child is None or child is view:
            return control_label(view, backend)
        view = child
    return None


# Enter in a one-line text field submits its form by pressing the form's first submit button (a form with no
# button submits only when it has a single field). Returns that button's accessible name, or null.
FN_DEFAULT_SUBMIT = """function () {
  var f = this.form;
  var t = (this.type || '').toLowerCase();
  if (!f || this.tagName !== 'INPUT' || ['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'week', 'time'].indexOf(t) < 0) return null;
  var els = f.elements;
  for (var i = 0; i < els.length; i++) {
    var e = els[i];
    var et = (e.type || '').toLowerCase();
    var button = e.tagName === 'BUTTON' && et === 'submit';
    var input = e.tagName === 'INPUT' && (et === 'submit' || et === 'image');
    if (!button && !input) continue;
    var name = e.getAttribute('aria-label') || (e.tagName === 'INPUT' ? (e.value || e.alt) : e.innerText) || e.title || '';
    return {name: String(name).replace(/\\s+/g, ' ').trim()};
  }
  return null;
}"""


def focused_submit(cdp):
    # type: (Cdp) -> Optional[Dict[str, str]]
    """The submit button that Enter in the focused text field would press (the tab's own frame only), as role
    and accessible name; None when focus is not in a form's text field or the form has no submit button."""
    try:
        res = cdp.send("Runtime.evaluate", {"expression": "document.activeElement"})
        object_id = (res.get("result") or {}).get("objectId")
        if not isinstance(object_id, str):
            return None
        out = cdp.send("Runtime.callFunctionOn", {"objectId": object_id, "functionDeclaration": FN_DEFAULT_SUBMIT,
                                                  "returnByValue": True})
    except HelperError:
        return None
    value = (out.get("result") or {}).get("value")
    if isinstance(value, dict) and isinstance(value.get("name"), str):
        return {"role": "button", "name": value["name"][:MAX_NAME_LEN]}
    return None


def focused_element(cdp):
    # type: (Cdp) -> Optional[Dict[str, str]]
    """The control that has keyboard focus (what Enter or Space would press), descending into
    cross-origin iframes; None when focus is on no control."""
    view = cdp  # type: Any
    for _ in range(4):
        res = view.send("Runtime.evaluate", {"expression": "document.activeElement"})
        object_id = (res.get("result") or {}).get("objectId")
        if not isinstance(object_id, str):
            return None
        node = view.send("DOM.describeNode", {"objectId": object_id}).get("node") or {}
        backend = node.get("backendNodeId")
        if not isinstance(backend, int):
            return None
        frame = node.get("frameId")
        child = next((s for s in oopif_sessions(cdp) if frame and s.target == frame), None)
        if child is None or child is view:
            return control_label(view, backend)
        view = child
    return None
