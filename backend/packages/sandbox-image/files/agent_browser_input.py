"""Write-model actions: click, type and fill_secret via native input, with explicit HTML option selection."""
import re
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Optional, Tuple

from agent_browser_cdp import (Cdp, HelperError, MAX_TEXT_LEN, page_identity)
from agent_browser_nav import find_ax_node
from agent_browser_select import select_option
from agent_browser_refs import _ax_str, _is_disabled, _is_readonly, check_fresh

EXPR_VISIBLE = "document.visibilityState"


def ensure_visible(cdp):
    # type: (Cdp) -> None
    cdp.send("Page.bringToFront")
    try:
        res = cdp.send("Runtime.evaluate",
                       {"expression": EXPR_VISIBLE, "returnByValue": True})
    except HelperError as exc:
        raise HelperError("cannot confirm page visibility: %s" % exc)
    state = (res.get("result") or {}).get("value")
    if state != "visible":
        raise HelperError("page is not visible; native input cannot be delivered")


def point_for(cdp, backend_id):
    # type: (Any, int) -> Tuple[float, float]
    """The centre of a node in the tab's CSS pixels (an iframe view adds its offset)."""
    cdp.send("DOM.scrollIntoViewIfNeeded", {"backendNodeId": backend_id})
    box = cdp.send("DOM.getBoxModel", {"backendNodeId": backend_id})
    model = box.get("model") or {}
    quad = model.get("content")
    if not isinstance(quad, list) or len(quad) < 8:
        raise HelperError("element has no clickable box (not visible)")
    try:
        xs = [float(quad[0]), float(quad[2]), float(quad[4]), float(quad[6])]
        ys = [float(quad[1]), float(quad[3]), float(quad[5]), float(quad[7])]
    except (TypeError, ValueError):
        raise HelperError("element has no clickable box (not visible)")
    return (cdp.offset[0] + (min(xs) + max(xs)) / 2.0,
            cdp.offset[1] + (min(ys) + max(ys)) / 2.0)


def do_click(view, frame_id, loader_id, backend_id):
    # type: (Any, str, str, int) -> Dict[str, Any]
    """Native click at the node's centre; `view` is the tab or a cross-origin iframe session."""
    page = view.page
    check_fresh(view, frame_id, loader_id)
    ensure_visible(page)
    if select_option(view, backend_id):
        url, title = page_identity(page)
        return {"ok": True, "action": "click", "url": url, "title": title, "clicked": True}
    x, y = point_for(view, backend_id)
    page.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
    page.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y,
                                             "button": "left", "clickCount": 1})
    page.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y,
                                             "button": "left", "clickCount": 1})
    url, title = page_identity(page)
    return {"ok": True, "action": "click", "url": url, "title": title,
            "clicked": True}


EDITABLE_ROLES = frozenset(["textbox", "searchbox", "spinbutton"])


def _has_editable(node):
    # type: (Dict[str, Any]) -> bool
    """Chrome marks text-entry nodes with an "editable" property (plaintext/richtext)."""
    for prop in node.get("properties") or []:
        if isinstance(prop, dict) and prop.get("name") == "editable":
            return bool(_ax_str(prop.get("value")))
    return False


def check_writable(node):
    # type: (Dict[str, Any]) -> None
    role = _ax_str(node.get("role"))
    # An <input role=combobox> (search boxes, airport pickers) is a text field too.
    if role not in EDITABLE_ROLES and not (role == "combobox" and _has_editable(node)):
        raise HelperError("target is not an editable field (role %r)" % (role,))
    if _is_disabled(node):
        raise HelperError("target is disabled")
    if _is_readonly(node):
        raise HelperError("target is readonly")


def _replace_text(view, frame_id, loader_id, backend_id, insert):
    # type: (Any, str, str, int, str) -> None
    """Focus an editable field and replace its content with `insert` via native input.

    The field is found and focused in its own frame's session; keys go to the tab, which
    delivers them to the focused frame (also a cross-origin one)."""
    check_fresh(view, frame_id, loader_id)
    before = find_ax_node(view, backend_id, frame_id)
    if before is None:
        raise HelperError("target not found; take a fresh snapshot")
    check_writable(before)
    cdp = view.page
    ensure_visible(cdp)
    view.send("DOM.scrollIntoViewIfNeeded", {"backendNodeId": backend_id})
    view.send("DOM.focus", {"backendNodeId": backend_id})
    # Platform-neutral select-all edit command: a Ctrl+A chord is select-all
    # on Linux but beginning-of-line on macOS, and leaves modifier state
    # behind. Validated actual behavior: commands selectAll replaces exactly.
    cdp.send("Input.dispatchKeyEvent",
             {"type": "keyDown", "commands": ["selectAll"]})
    if insert:
        cdp.send("Input.insertText", {"text": insert})
        return
    # Portable key events: no OS-specific nativeVirtualKeyCode; the
    # keyUp carries modifiers 0 so no chord state lingers.
    cdp.send("Input.dispatchKeyEvent",
             {"type": "keyDown", "key": "Backspace", "code": "Backspace",
              "windowsVirtualKeyCode": 8})
    cdp.send("Input.dispatchKeyEvent",
             {"type": "keyUp", "key": "Backspace", "code": "Backspace",
              "windowsVirtualKeyCode": 8, "modifiers": 0})


_NUMERIC_RE = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$")

# The field's own DOM string value. Compared locally only, never returned or
# raised, so verifying a typed value cannot leak it into results or errors.
FN_VALUE_STRING = "function () { return typeof this.value === 'string' ? this.value : null; }"


def _ax_scalar(value):
    # type: (Any) -> Any
    """The AX value payload only: a string or a number, else None.

    The wrapper ({"type": ..., "value": ...}) is never stringified as a whole,
    and a boolean never counts as text or as a number.
    """
    raw = value.get("value") if isinstance(value, dict) else value
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (str, int, float)):
        return raw
    return None


def _spin_equal(seen, insert):
    # type: (Any, str) -> bool
    """Whether typed text holds the same spinbutton number ("0900" reads back
    as 900). Exact decimal comparison: no float overflow to inf, no precision
    loss on large integers, and booleans never count."""
    if isinstance(seen, bool) or not isinstance(insert, str):
        return False
    text = insert.strip()
    if not _NUMERIC_RE.match(text):
        return False
    try:
        want = Decimal(text)
    except InvalidOperation:
        return False
    if not want.is_finite():
        return False
    if isinstance(seen, bool):
        return False
    if isinstance(seen, (int, float)):
        try:
            got = Decimal(str(seen))
        except InvalidOperation:
            return False
        return bool(got.is_finite() and got == want)
    if isinstance(seen, str):
        other = seen.strip()
        if not _NUMERIC_RE.match(other):
            return False
        try:
            got = Decimal(other)
        except InvalidOperation:
            return False
        return bool(got.is_finite() and got == want)
    return False


def _dom_string(view, backend_id):
    # type: (Any, int) -> Optional[str]
    """The field's own DOM string value, or None when it cannot be read."""
    resolved = view.send("DOM.resolveNode", {"backendNodeId": backend_id})
    object_id = (resolved.get("object") or {}).get("objectId")
    if not isinstance(object_id, str):
        return None
    try:
        res = view.send("Runtime.callFunctionOn", {"objectId": object_id,
                                                   "functionDeclaration": FN_VALUE_STRING,
                                                   "returnByValue": True})
    except HelperError:
        return None
    value = (res.get("result") or {}).get("value")
    return value if isinstance(value, str) else None


def do_type(cdp, frame_id, loader_id, backend_id, insert):
    # type: (Any, str, str, int, Any) -> Dict[str, Any]
    if not isinstance(insert, str):
        raise HelperError("type needs a string text")
    if len(insert) > MAX_TEXT_LEN:
        raise HelperError("type text exceeds %d characters" % MAX_TEXT_LEN)
    _replace_text(cdp, frame_id, loader_id, backend_id, insert)
    node = find_ax_node(cdp, backend_id, frame_id)
    if node is None:
        raise HelperError("target changed while typing; take a fresh snapshot")
    seen = _ax_scalar(node.get("value"))
    role = _ax_str(node.get("role"))
    if isinstance(seen, str) and seen == insert:
        pass
    elif role == "spinbutton" and _spin_equal(seen, insert):
        # A spinbutton normalizes what was typed ("0900" reads back as 900).
        pass
    else:
        # Otherwise confirm against the field's own DOM string value, exactly:
        # a plain textbox holding "01" is not "1". Unreadable fails closed.
        # The value is compared here only, never returned or raised, so nothing
        # about it leaks into results or errors (secrets keep the fill_secret path).
        actual = _dom_string(cdp, backend_id)
        if actual != insert and not (
                role == "spinbutton" and _spin_equal(actual, insert)):
            raise HelperError("typed text did not reach the field")
    url, title = page_identity(cdp.page)
    return {"ok": True, "action": "type", "url": url, "title": title,
            "typed": True}


# Length of the field's own value: a password field exposes only bullets to
# accessibility, and card fields reformat what was typed ("4242 4242 ..."),
# so a secret fill is confirmed by the field holding something, never by
# reading the value back.
FN_VALUE_LENGTH = "function () { return typeof this.value === 'string' ? this.value.length : -1; }"
def do_fill_secret(cdp, frame_id, loader_id, backend_id, secret):
    # type: (Any, str, str, int, str) -> Dict[str, Any]
    """Type a secret into a field. Nothing about the value is returned or raised."""
    _replace_text(cdp, frame_id, loader_id, backend_id, secret)
    resolved = cdp.send("DOM.resolveNode", {"backendNodeId": backend_id})
    object_id = (resolved.get("object") or {}).get("objectId")
    if not isinstance(object_id, str):
        raise HelperError("target changed while filling; take a fresh snapshot")
    res = cdp.send("Runtime.callFunctionOn", {"objectId": object_id, "functionDeclaration": FN_VALUE_LENGTH,
                                              "returnByValue": True})
    length = (res.get("result") or {}).get("value")
    if length == 0:
        raise HelperError("the value did not reach the field")
    url, title = page_identity(cdp.page)
    return {"ok": True, "action": "fill_secret", "url": url, "title": title, "filled": True}
