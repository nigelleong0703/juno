"""Read-model actions: navigate, snapshot, get_text."""
import re
import urllib.parse
from typing import Any, Dict, Iterator, List, Optional, Tuple

from agent_browser_cdp import (Cdp, HelperError, MAX_NAME_LEN, MAX_NODES,
                               MAX_TEXT_LEN, frame_url, main_frame, page_identity)
import agent_browser_mask
from agent_browser_frames import oopif_sessions
from agent_browser_refs import INTERACTIVE_ROLES, _ax_str, _is_disabled, _is_readonly

EXPR_BODY_TEXT = "(document.body ? document.body.innerText : '')"


# Slow sites (heavy travel and shopping pages) may not commit or fire
# DOMContentLoaded inside the request budget. Waiting stops at this many
# seconds before the budget so the helper can still report where the tab is.
LOADING_MARGIN_S = 2.0


def do_navigate(cdp, url, deadline):
    # type: (Cdp, Any, float) -> Dict[str, Any]
    """Navigate and wait for the document; a slow page reports loading: true.

    The navigation keeps going in the browser after the helper returns, so
    "still loading" is truthful, not a failure: the caller snapshots later.
    """
    if not isinstance(url, str):
        raise HelperError("navigate needs a string url")
    parts = urllib.parse.urlparse(url)
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise HelperError("refusing to navigate to non-http(s) URL %r" % (url,))
    before = main_frame(cdp).get("loaderId", "")
    cdp.deadline = deadline - LOADING_MARGIN_S
    loading = False
    try:
        result = cdp.send("Page.navigate", {"url": url})
        if result.get("errorText"):
            raise HelperError("navigation failed: %s" % result["errorText"])
        loader = result.get("loaderId", "")
        frame_id = result.get("frameId", "")
        # NOTE: Page.loadEventFired carries no loaderId, so readiness waits on a
        # lifecycle event tied to this frame and loader instead. A same-document
        # navigation keeps its loader and needs no wait.
        if isinstance(loader, str) and loader and loader != before:
            cdp.wait_event("Page.lifecycleEvent",
                           lambda params: params.get("frameId") == frame_id
                           and params.get("loaderId") == loader
                           and params.get("name") in ("DOMContentLoaded", "load"))
        else:
            # Same-document navigation (e.g. #anchor) keeps its loader; wait
            # for the within-document commit, then report the actual URL.
            current, _current_title = page_identity(cdp)
            if current != url:
                cdp.wait_event("Page.navigatedWithinDocument", lambda params: True)
    except HelperError as exc:
        if "timed out" not in str(exc) and "budget" not in str(exc):
            if str(exc).startswith("navigation failed"):
                raise
            raise HelperError("navigation failed: %s" % exc)
        loading = True
    finally:
        cdp.deadline = deadline
    if loading:
        # Page-domain commands queue behind the unfinished navigation; the
        # target info comes from the browser process and answers right away.
        info = cdp.send("Target.getTargetInfo").get("targetInfo", {})
        current = info.get("url", "") if isinstance(info.get("url"), str) else ""
        # The target title still belongs to the previous page until commit.
        return {"ok": True, "action": "navigate", "url": current, "title": "",
                "loading": True}
    final_url, title = page_identity(cdp)
    final = urllib.parse.urlparse(final_url)
    if final.scheme.lower() not in ("http", "https"):
        raise HelperError("navigation did not land on a web page")
    return {"ok": True, "action": "navigate", "url": final_url, "title": title}


MAX_FRAMES = 20


def _frames(tree, out):
    # type: (Dict[str, Any], List[Dict[str, Any]]) -> None
    """Depth-first frames, main frame first, capped so busy pages stay in budget."""
    frame = tree.get("frame")
    if isinstance(frame, dict) and len(out) < MAX_FRAMES:
        out.append(frame)
    for child in tree.get("childFrames") or []:
        _frames(child, out)


def page_frames(cdp):
    # type: (Any) -> List[Dict[str, Any]]
    frames = []  # type: List[Dict[str, Any]]
    _frames(cdp.send("Page.getFrameTree").get("frameTree") or {}, frames)
    if not frames:
        raise HelperError("CDP Page.getFrameTree returned no frame")
    return frames


MAX_VALUE_LEN = 40
MAX_GROUP_LEN = 40
MAX_HEADINGS = 30
MAX_HEADING_TEXT = 240
MAX_TEXT_TOTAL = 1500
MAX_VALUE_LOOKUPS = 20
CHECKED_ROLES = frozenset(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"])
VALUE_ROLES = frozenset(["textbox", "combobox", "searchbox", "spinbutton"])
GROUP_ROLES = frozenset(["radiogroup", "group", "heading", "form", "region"])
SECRET_NAME_RE = re.compile(r"pass(word|code)?|pwd|card|cvc|cvv|security.?code|otp|one.?time|verification.?code|"
                            r"\bpin\b|secret|ssn", re.IGNORECASE)

FN_SECRET = """function () {
  var t = (this.getAttribute && this.getAttribute('type') || '').toLowerCase();
  var a = (this.getAttribute && this.getAttribute('autocomplete') || '').toLowerCase();
  var n = ((this.getAttribute && this.getAttribute('name')) || '') + ' ' + (this.id || '');
  return {type: t, autocomplete: a, name: n, value: String(this.value == null ? '' : this.value)};
}"""


def _prop(node, name):
    # type: (Dict[str, Any], str) -> Optional[str]
    """One AX property as a lowercase string ("true", "false", "mixed", token), or None when absent."""
    for prop in node.get("properties") or []:
        if isinstance(prop, dict) and prop.get("name") == name:
            val = prop.get("value")
            raw = val.get("value") if isinstance(val, dict) else val
            if isinstance(raw, bool):
                return "true" if raw else "false"
            if isinstance(raw, int):
                return str(raw)
            if isinstance(raw, str):
                return raw.lower()
            return None
    return None


def node_state(node, role):
    # type: (Dict[str, Any], str) -> List[str]
    """Compact state flags of one AX node, in a fixed order."""
    flags = []  # type: List[str]
    if role in CHECKED_ROLES:
        checked = _prop(node, "checked")
        if checked in ("true", "false", "mixed"):
            flags.append({"true": "checked", "false": "unchecked", "mixed": "mixed"}[checked])
    if role in ("option", "tab") and _prop(node, "selected") == "true":
        flags.append("selected")
    expanded = _prop(node, "expanded")
    if expanded in ("true", "false") and (role == "combobox" or _prop(node, "hasPopup") not in (None, "false")):
        flags.append("expanded" if expanded == "true" else "collapsed")
    pressed = _prop(node, "pressed")
    if pressed in ("true", "mixed"):
        flags.append("pressed")
    if _prop(node, "required") == "true":
        flags.append("required")
    invalid = _prop(node, "invalid")
    if invalid not in (None, "false"):
        flags.append("invalid")
    if _is_readonly(node):
        flags.append("readonly")
    if _prop(node, "focused") == "true":
        flags.append("focused")
    return flags


def _short(text, limit):
    # type: (str, int) -> str
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 1] + "\u2026"


def group_name(by_id, node):
    # type: (Dict[str, Dict[str, Any]], Dict[str, Any]) -> str
    """Name of the nearest named radiogroup/group/heading above a node (the question a choice answers)."""
    parent = by_id.get(node.get("parentId"))
    for _ in range(12):
        if parent is None:
            return ""
        if _ax_str(parent.get("role")) in GROUP_ROLES:
            name = _ax_str(parent.get("name")).strip()
            if name:
                return _short(name, MAX_GROUP_LEN)
        parent = by_id.get(parent.get("parentId"))
    return ""


FILLED_FLAG = "filled securely"


def field_value(cdp, node, budget):
    # type: (Any, Dict[str, Any], List[int]) -> Tuple[str, bool]
    """(the current value of a non-secret field, whether the user filled it securely).

    A securely filled field (its value holds a secret of this browser, in the AX tree or the DOM, so a re-mounted
    input that kept the typed text still counts) comes back as (dots, True): the snapshot says it is filled and
    never what it holds. Other secret-looking, masked or unreadable fields come back as ("", False)."""
    raw = _ax_str(node.get("value")).strip()
    if not raw:
        return "", False
    if agent_browser_mask.holds_secret(raw, agent_browser_mask.ACTIVE):
        return agent_browser_mask.DOTS, True
    secretish = bool(SECRET_NAME_RE.search(_ax_str(node.get("name")))) or not raw.strip("\u2022*\u25cf\u00b7 ")
    if budget[0] <= 0:
        return "", False
    budget[0] -= 1
    backend = node.get("backendDOMNodeId")
    try:
        obj = (cdp.send("DOM.resolveNode", {"backendNodeId": backend}).get("object") or {}).get("objectId")
        res = cdp.send("Runtime.callFunctionOn", {"objectId": obj, "functionDeclaration": FN_SECRET,
                                                  "returnByValue": True})
        info = (res.get("result") or {}).get("value") or {}
    except HelperError:
        return "", False
    if agent_browser_mask.ACTIVE and agent_browser_mask.holds_secret(str(info.get("value", "")), agent_browser_mask.ACTIVE):
        return agent_browser_mask.DOTS, True  # e.g. a password input whose AX value is bullets
    if secretish:
        return "", False
    autocomplete = info.get("autocomplete", "")
    if info.get("type") == "password" or autocomplete.startswith("cc-") or "password" in autocomplete \
            or "one-time" in autocomplete or SECRET_NAME_RE.search(info.get("name", "")):
        return "", False
    return _short(raw, MAX_VALUE_LEN), False


def heading_texts(all_ax, by_id, budget):
    # type: (List[Dict[str, Any]], Dict[str, Dict[str, Any]], List[int]) -> Dict[str, str]
    """Prose under each h1-h3 heading, in tree order: nodeId of the heading -> its text.

    Takes the StaticText nodes after a heading up to the next heading of any level, except the text of the
    heading itself and the labels of buttons and links (those already have their own line). One heading keeps
    MAX_HEADING_TEXT characters; `budget` (one-element list, shared across frames) caps the page at MAX_TEXT_TOTAL.
    """
    out = {}  # type: Dict[str, str]
    current = None  # type: Optional[str]
    parts = []  # type: List[str]

    def close():
        # type: () -> None
        if current is not None and parts and budget[0] > 0:
            text = _short(" ".join(parts), min(MAX_HEADING_TEXT, budget[0]))
            budget[0] -= len(text)
            out[current] = text

    for node in all_ax:
        if node.get("ignored"):
            continue
        role = _ax_str(node.get("role"))
        if role == "heading":
            close()
            parts = []
            level = _prop(node, "level")
            current = node.get("nodeId") if level in ("1", "2", "3") and _ax_str(node.get("name")).strip() else None
            continue
        if current is None or role != "StaticText":
            continue
        parent = _ax_str((by_id.get(node.get("parentId")) or {}).get("role"))
        if parent == "heading" or parent in INTERACTIVE_ROLES:
            continue
        name = " ".join(_ax_str(node.get("name")).split())
        if name and (not parts or parts[-1] != name):
            parts.append(name)
    close()
    return out


def interactive_nodes(cdp, frames, oopif=None):
    # type: (Any, List[Dict[str, Any]], Optional[str]) -> Iterator[Dict[str, Any]]
    """Interactive AX nodes of these frames in tree order, once per DOM node.

    Each entry carries its frame, the frame's loader and its DOM node so the
    caller can mint a short ref or measure the node; nodes of a cross-origin
    iframe also carry that iframe's target (`oopif`) and host (`site`). Form
    state (`state` flags, `value`, `group`) rides along, and headings of level
    1-3 come as entries with `heading` (no ref, plus the `text` under them) so the model sees the sections.
    """
    seen = set()
    lookups = [MAX_VALUE_LOOKUPS]
    text_budget = [MAX_TEXT_TOTAL]
    for frame in frames:
        frame_id = frame.get("id", "")
        try:
            tree = cdp.send("Accessibility.getFullAXTree", {"frameId": frame_id})
        except HelperError:
            if frame is frames[0]:
                raise
            continue
        loader_id = frame.get("loaderId", "")
        all_ax = [n for n in tree.get("nodes") or [] if isinstance(n, dict)]
        by_id = dict((n.get("nodeId"), n) for n in all_ax)
        prose = {} if oopif else heading_texts(all_ax, by_id, text_budget)
        for node in all_ax:
            if node.get("ignored"):
                continue
            role = _ax_str(node.get("role"))
            if role == "heading" and not oopif:
                level = _prop(node, "level")
                name = _short(_ax_str(node.get("name")), MAX_NAME_LEN)
                if name and level in ("1", "2", "3"):
                    entry = {"heading": int(level), "name": name, "node": node.get("backendDOMNodeId")}  # type: Dict[str, Any]
                    if node.get("nodeId") in prose:
                        entry["text"] = prose[node.get("nodeId")]
                    yield entry
                continue
            if role not in INTERACTIVE_ROLES:
                continue
            backend = node.get("backendDOMNodeId")
            if not isinstance(backend, int) or isinstance(backend, bool) or backend in seen:
                continue
            seen.add(backend)
            entry = {"frame": frame_id, "loader": loader_id, "node": backend, "role": role,
                     "name": _ax_str(node.get("name"))[:MAX_NAME_LEN], "oopif": oopif}  # type: Dict[str, Any]
            if oopif:
                entry["site"] = urllib.parse.urlparse(frame_url(frames[0])).hostname or ""
            if _is_disabled(node):
                entry["disabled"] = True
            state = node_state(node, role)
            if state:
                entry["state"] = state
            if role in VALUE_ROLES:
                value, filled = field_value(cdp, node, lookups)
                if value:
                    entry["value"] = value
                if filled:
                    entry["state"] = list(entry.get("state") or []) + [FILLED_FLAG]
            if role in ("radio", "checkbox"):
                group = group_name(by_id, node)
                if group:
                    entry["group"] = group
            yield entry


def all_nodes(cdp, frames):
    # type: (Cdp, List[Dict[str, Any]]) -> Iterator[Dict[str, Any]]
    """The tab's own frames, then each cross-origin iframe it could attach to."""
    for entry in interactive_nodes(cdp, frames):
        yield entry
    for child in oopif_sessions(cdp):
        try:
            child_frames = page_frames(child)
        except HelperError:
            continue
        child.read = True
        for entry in interactive_nodes(child, child_frames, child.target):
            yield entry


# Interactive nodes looked at before choosing the MAX_NODES a snapshot lists: a shop's results page has hundreds
# (filter checkboxes, category and footer links) and the products come after them in the tree.
MAX_SCAN = 1500


def layout_positions(view):
    # type: (Any) -> Dict[int, Tuple[float, float, float]]
    """backend node id -> (top, left, bottom) of its layout box in the tab's viewport (CSS px), for every rendered
    node of this view's documents (same-process iframes shifted by their owner's box, a cross-origin iframe session
    by its offset). One DOMSnapshot call; a node that is not rendered (display:none, a closed menu) is missing."""
    try:
        snap = view.send("DOMSnapshot.captureSnapshot", {"computedStyles": []})
    except HelperError:
        return {}
    docs = [d for d in snap.get("documents") or [] if isinstance(d, dict)]
    origins = {0: view.offset}  # type: Dict[int, Tuple[float, float]]
    out = {}  # type: Dict[int, Tuple[float, float, float]]
    for index, doc in enumerate(docs):
        if index not in origins:
            continue  # its owner iframe is not rendered
        nodes, layout = doc.get("nodes") or {}, doc.get("layout") or {}
        backend = nodes.get("backendNodeId") or []
        child_docs = nodes.get("contentDocumentIndex") or {}
        owners = dict(zip(child_docs.get("index") or [], child_docs.get("value") or []))
        ox = origins[index][0] - float(doc.get("scrollOffsetX") or 0)
        oy = origins[index][1] - float(doc.get("scrollOffsetY") or 0)
        for node_index, box in zip(layout.get("nodeIndex") or [], layout.get("bounds") or []):
            if not isinstance(box, list) or len(box) < 4 or not 0 <= node_index < len(backend):
                continue
            top, left = oy + float(box[1]), ox + float(box[0])
            out.setdefault(backend[node_index], (top, left, top + float(box[3])))
            if node_index in owners:
                origins[owners[node_index]] = (left, top)
    return out


def screen_order(position, height):
    # type: (Optional[Tuple[float, float, float]], float) -> Tuple[int, float, float]
    """Sort key: on screen now (top to bottom), then below it (nearest first), then above it, then not rendered."""
    if position is None:
        return (3, 0.0, 0.0)
    top, left, bottom = position
    if bottom > 0 and top < height:
        return (0, top, left)
    return (1, top, left) if top >= height else (2, -top, left)


def pick_nodes(entries, order):
    # type: (List[Dict[str, Any]], Any) -> Tuple[List[Dict[str, Any]], int]
    """(up to MAX_NODES controls and MAX_HEADINGS headings in page order, controls left out).

    Chosen by `order` (what is on screen first, then what follows below it) with named controls before unnamed
    ones within each, so a long filter sidebar or footer early in the tree cannot use up the list."""
    def key(i):
        # type: (int) -> Any
        zone, top, left = order(entries[i])
        return (zone, 0 if entries[i].get("name") else 1, top, left, i)
    keep = set()
    controls = headings = 0
    for i in sorted(range(len(entries)), key=key):
        if "heading" in entries[i]:
            if headings < MAX_HEADINGS:
                headings += 1
                keep.add(i)
        elif controls < MAX_NODES:
            controls += 1
            keep.add(i)
    total = sum(1 for e in entries if "heading" not in e)
    return [entries[i] for i in sorted(keep)], total - controls


def do_snapshot(cdp, target_id):
    # type: (Cdp, str) -> Dict[str, Any]
    """Interactive AX nodes of the main frame, its same-process iframes and its
    cross-origin iframes (attached as child sessions, see agent_browser_frames).
    Cross-origin iframes it could not read are counted for the screenshot fallback.
    On a page with more than MAX_NODES controls, the ones on screen and just below it are listed (pick_nodes) and
    `omitted` counts the rest: scrolling and snapshotting again lists what is further down.
    """
    info = cdp.send("Target.getTargetInfo").get("targetInfo", {})
    if info.get("targetId", "") != target_id:
        raise HelperError("page target changed during snapshot")
    frames = page_frames(cdp)
    url = frame_url(frames[0]) or info.get("url", "")
    if not isinstance(url, str):
        url = ""
    title = info.get("title", "")
    if not isinstance(title, str):
        title = ""
    entries = []  # type: List[Dict[str, Any]]
    scanned = 0
    for entry in all_nodes(cdp, frames):
        if "heading" not in entry:
            if scanned >= MAX_SCAN:
                break
            scanned += 1
        entries.append(entry)
    order = lambda _entry: (0, 0.0, 0.0)  # a page that fits keeps plain page order
    if scanned > MAX_NODES:
        views = dict((child.target, child) for child in oopif_sessions(cdp))
        positions = {}  # type: Dict[Any, Dict[int, Tuple[float, float, float]]]
        height = float((cdp.send("Page.getLayoutMetrics").get("cssVisualViewport") or {}).get("clientHeight") or 0)

        def order(entry):
            # type: (Dict[str, Any]) -> Tuple[int, float, float]
            target = entry.get("oopif")
            if target not in positions:
                positions[target] = layout_positions(views.get(target, cdp) if target else cdp)
            return screen_order(positions[target].get(entry.get("node")), height)
    entries, omitted = pick_nodes(entries, order)
    for entry in entries:
        if "heading" in entry:
            entry.pop("node", None)
    # Cross-origin iframes are their own "iframe" targets whose parent is this tab.
    direct = sum(1 for target in cdp.send("Target.getTargets").get("targetInfos") or []
                 if isinstance(target, dict) and target.get("type") == "iframe"
                 and target.get("parentId") == target_id)
    read = sum(1 for child in oopif_sessions(cdp) if getattr(child, "read", False))
    result = {"ok": True, "action": "snapshot", "url": url, "title": title,
              "nodes": entries, "crossOriginFrames": max(0, direct - read)}  # type: Dict[str, Any]
    if omitted:
        result["omitted"] = omitted
    return result


def find_ax_node(cdp, backend_id, frame_id):
    # type: (Any, int, str) -> Optional[Dict[str, Any]]
    """The AX node of one DOM node: asked for directly (getPartialAXTree), else found in its frame's tree.

    The direct ask is cheaper and does not depend on the whole tree being built yet (a cross-origin
    iframe that just loaded once listed a node in a snapshot but not in a full tree read right after)."""
    try:
        partial = cdp.send("Accessibility.getPartialAXTree", {"backendNodeId": backend_id, "fetchRelatives": False})
    except HelperError:
        partial = {}
    for node in partial.get("nodes", []) or []:
        if isinstance(node, dict) and node.get("backendDOMNodeId") == backend_id:
            return node
    tree = cdp.send("Accessibility.getFullAXTree", {"frameId": frame_id})
    for node in tree.get("nodes", []) or []:
        if isinstance(node, dict) and node.get("backendDOMNodeId") == backend_id:
            return node
    return None


def do_get_text(cdp):
    # type: (Cdp) -> Dict[str, Any]
    res = cdp.send("Runtime.evaluate",
                   {"expression": EXPR_BODY_TEXT, "returnByValue": True})
    value = (res.get("result") or {}).get("value")
    if not isinstance(value, str):
        raise HelperError("could not read page text")
    url, title = page_identity(cdp)
    return {"ok": True, "action": "get_text", "url": url, "title": title,
            "text": value[:MAX_TEXT_LEN]}
