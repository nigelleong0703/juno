"""Focused checks for agent-browser refs: no Chrome needed (stdlib only)."""
"""
Run: .data/cdp-test-env/bin/python packages/sandbox-image/agent_browser_selftest.py
Checks short refs and tab handles through the locked per-port state file,
tolerant spellings, closed-tab / re-snapshot / stale-document rejection, the
watcher's dialog policy (alert accepted, confirm/prompt/beforeunload left to
the agent) and popup notices. The real-Chromium flows (dialogs, popups,
cross-origin iframes, point) run in scripts/verify/sandbox-cdp-image-live.mjs.
"""
import os
import sys
import tempfile

os.environ["AGENT_BROWSER_STATE"] = tempfile.mkdtemp(prefix="agent-browser-selftest-")
os.environ["AGENT_BROWSER_KEYDIR"] = os.path.join(tempfile.mkdtemp(prefix="agent-browser-keys-"), "keys")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "files"))

from agent_browser_cdp import HelperError
from agent_browser_refs import (check_fresh, lookup_ref, normalize_ref, normalize_tab,
                                port_state, replace_refs, sync_tabs, target_for)
from agent_browser_input import _spin_equal, check_writable, do_fill_secret, do_type
from agent_browser_bounds import css_point, screen_rect
from agent_browser_notices import merge_notices, take_notices
import agent_browser_notices
import agent_browser_mask
import agent_browser_seal
import agent_browser_watch
import base64
import json


class StubCdp(object):
    """Stands in for Cdp where check_fresh only needs the frame tree."""
    def __init__(self, loader, child_loader="child-1"):
        self.loader = loader
        self.child_loader = child_loader
        self.page = self
        self.offset = (0.0, 0.0)
    def send(self, method, params=None):
        assert method == "Page.getFrameTree", method
        return {"frameTree": {"frame": {"id": "main", "loaderId": self.loader},
                              "childFrames": [{"frame": {"id": "ad", "loaderId": self.child_loader}}]}}


def expect_error(fn, fragment):
    try:
        fn()
    except HelperError as exc:
        assert fragment in str(exc), "want %r in %r" % (fragment, str(exc))
        return
    raise AssertionError("expected HelperError containing %r" % fragment)


def node(frame, loader, backend):
    return {"frame": frame, "loader": loader, "node": backend, "role": "button", "name": "x"}


def main():
    for spelling in ("e12", "@e12", "E12", "12", "ref=e12", "[ref=e12]", " e12 "):
        assert normalize_ref(spelling) == "e12", spelling
    expect_error(lambda: normalize_ref("ab1_WzkyMjYs"), "refs look like e12")
    expect_error(lambda: normalize_ref(12), "refs look like e12")
    assert normalize_tab("t2") == "t2" and normalize_tab("2") == "t2"
    expect_error(lambda: normalize_tab("tab-two"), "browser.tabs")

    with port_state(9222) as state:
        sync_tabs(state, ["TAB-A", "TAB-B"])
        assert target_for(state, "t1") == "TAB-A" and target_for(state, "t2") == "TAB-B"
        first = [node("main", "loader-1", 41), node("ad", "child-1", 42)]
        replace_refs(state, "t1", first)
        second = [node("main", "loader-b", 7)]
        replace_refs(state, "t2", second)
    assert [n["ref"] for n in first] == ["e1", "e2"] and second[0]["ref"] == "e3"
    assert "frame" not in first[0]

    # A fresh process sees the saved map; refs carry their own tab.
    with port_state(9222) as state:
        assert lookup_ref(state, "@e2") == ("t1", "TAB-A", "ad", "child-1", 42, None)
        assert lookup_ref(state, "3")[:2] == ("t2", "TAB-B")
        replace_refs(state, "t1", [node("main", "loader-1", 41)])
        assert lookup_ref(state, "e1")[4] == 41, "a surviving node keeps its ref"
        expect_error(lambda: lookup_ref(state, "e2"), "stale ref")
        assert lookup_ref(state, "e3")[1] == "TAB-B"
        renamed = [dict(node("main", "loader-1", 41), role="textbox", name="Email")]
        replace_refs(state, "t1", renamed)
        assert renamed[0]["ref"] == "e1", "same node with new role/name keeps its ref"
        moved = [node("main", "loader-2", 41)]
        replace_refs(state, "t1", moved)
        expect_error(lambda: lookup_ref(state, "e1"), "stale ref")
        assert moved[0]["ref"] == "e4" and lookup_ref(state, "e4")[4] == 41
        assert lookup_ref(state, "e3")[1] == "TAB-B"
        sync_tabs(state, ["TAB-B", "TAB-C"])
        expect_error(lambda: lookup_ref(state, "e4"), "stale ref")
        expect_error(lambda: target_for(state, "t1"), "may be closed")
        assert target_for(state, "t3") == "TAB-C"
    with port_state(9333) as other:
        expect_error(lambda: lookup_ref(other, "e3"), "stale ref")

    check_fresh(StubCdp("loader-1"), "ad", "child-1")
    expect_error(lambda: check_fresh(StubCdp("loader-2"), "main", "loader-1"), "navigated")
    expect_error(lambda: check_fresh(StubCdp("loader-1", "child-2"), "ad", "child-1"), "navigated")
    expect_error(lambda: check_fresh(StubCdp("loader-1"), "gone", "x"), "frame is gone")

    check_writable({"role": {"value": "textbox"}, "name": {"value": "Email"}})
    expect_error(lambda: check_writable({"role": {"value": "button"}}), "not an editable")
    check_writable({"role": {"value": "combobox"}, "properties": [
        {"name": "editable", "value": {"type": "token", "value": "plaintext"}}]})
    expect_error(lambda: check_writable({"role": {"value": "combobox"}}), "not an editable")
    expect_error(lambda: check_writable({"role": {"value": "textbox"}, "disabled": True}), "disabled")
    readonly = {"role": {"value": "textbox"}, "properties": [
        {"name": "readonly", "value": {"value": True, "type": "boolean"}}]}
    expect_error(lambda: check_writable(readonly), "readonly")
    check_bounds_mapping()
    check_secret_never_echoed()
    check_type_verification()
    check_unseal()
    check_masking()
    check_oopif_refs()
    check_watcher_dialog_policy()
    check_notices()
    check_snapshot_form_state()
    check_heading_text()
    check_snapshot_picks_screen_first()
    print("selftest PASS: short refs, tab handles, stale checks, writable checks, bounds mapping, secret fill,"
          " unseal vector, masking and redaction,"
          " iframe refs, dialog policy, popup notices")


class AxCdp(object):
    """Serves one fixed AX tree; DOM lookups answer with the given field attributes."""
    def __init__(self, nodes, attrs=None):
        self.nodes, self.attrs = nodes, attrs or {}

    def send(self, method, params=None):
        if method == "Accessibility.getFullAXTree":
            return {"nodes": self.nodes}
        if method == "DOM.resolveNode":
            return {"object": {"objectId": str((params or {})["backendNodeId"])}}
        if method == "Runtime.callFunctionOn":
            return {"result": {"value": self.attrs.get(params["objectId"], {})}}
        raise AssertionError(method)


def ax(node_id, role, name="", parent=None, backend=None, props=None, value=None):
    out = {"nodeId": node_id, "role": {"value": role}, "name": {"value": name}, "parentId": parent,
           "backendDOMNodeId": backend, "properties": props or []}
    if value is not None:
        out["value"] = {"value": value}
    return out


def prop(name, value):
    return {"name": name, "value": {"value": value}}


def check_heading_text():
    from agent_browser_nav import interactive_nodes
    # The prose under a heading rides on the heading; heading text, link labels and a later heading's prose stay apart.
    nodes = [
        ax("1", "heading", "We love that early energy.", backend=1, props=[prop("level", 2)]),
        ax("2", "StaticText", "We love that early energy.", "1"),
        ax("3", "paragraph", ""),
        ax("4", "StaticText", "Almost ready for you. Pre-order begins at 8pm SGT.", "3"),
        ax("5", "link", "Support", None, 5),
        ax("6", "StaticText", "Support", "5"),
        ax("7", "heading", "Other", backend=7, props=[prop("level", 3)]),
        ax("8", "StaticText", "x" * 400, "7"),
        ax("9", "StaticText", "y" * 400),
    ]
    out = list(interactive_nodes(AxCdp(nodes, {}), [{"id": "main", "loaderId": "l"}]))
    assert out[0] == {"heading": 2, "name": "We love that early energy.", "node": 1,
                      "text": "Almost ready for you. Pre-order begins at 8pm SGT."}, out[0]
    assert out[1]["name"] == "Support" and "text" not in out[1], out[1]
    assert len(out[2]["text"]) <= 240 and out[2]["text"].startswith("y"), out[2]


class LayoutCdp(object):
    """Serves one DOMSnapshot: the page scrolled down 1000px, and a same-process iframe whose owner sits at (40, 1100)."""
    offset = (0.0, 0.0)

    def send(self, method, params=None):
        assert method == "DOMSnapshot.captureSnapshot", method
        return {"documents": [
            {"scrollOffsetX": 0, "scrollOffsetY": 1000,
             "nodes": {"backendNodeId": [1, 2, 3], "contentDocumentIndex": {"index": [2], "value": [1]}},
             "layout": {"nodeIndex": [0, 1, 2], "bounds": [[0, 0, 1400, 6000], [600, 1500, 200, 40], [40, 1100, 300, 200]]}},
            {"scrollOffsetX": 0, "scrollOffsetY": 0, "nodes": {"backendNodeId": [9]},
             "layout": {"nodeIndex": [0], "bounds": [[10, 20, 100, 30]]}}]}


def check_snapshot_picks_screen_first():
    from agent_browser_nav import MAX_NODES, layout_positions, pick_nodes, screen_order
    # Positions are in the tab's viewport: page coordinates minus the scroll, iframe content shifted by its owner.
    pos = layout_positions(LayoutCdp())
    assert pos[2] == (500.0, 600.0, 540.0) and pos[9] == (120.0, 50.0, 150.0), pos
    # A shop's results page (the Lazada regression): the footer and a long filter sidebar come first in the tree,
    # the product cards after them. On-screen controls are listed first, then what follows below, in page order.
    entries = [{"heading": 3, "name": "Customer Care", "node": 1}]
    place = {}
    for i in range(150):
        entries.append({"role": "link", "name": "footer %d" % i, "node": 1000 + i})
        place[1000 + i] = (9000.0 + i, 0.0, 9010.0 + i)
    for i in range(200):
        entries.append({"role": "checkbox", "name": "filter %d" % i, "node": 2000 + i})
        place[2000 + i] = (100.0 + 30 * i, 0.0, 120.0 + 30 * i)
    for i in range(40):
        entries.append({"role": "link", "name": "product %d" % i, "node": 3000 + i})
        place[3000 + i] = (100.0 + 300 * (i // 4), 400.0 + 200 * (i % 4), 300.0 + 300 * (i // 4))
    entries.append({"role": "link", "name": "", "node": 4000})  # unnamed and not rendered
    kept, omitted = pick_nodes(entries, lambda e: screen_order(place.get(e.get("node")), 800.0))
    names = [e["name"] for e in kept]
    controls = [e for e in kept if "heading" not in e]
    assert len(controls) == MAX_NODES and omitted == 391 - MAX_NODES, (len(controls), omitted)
    assert "product 0" in names and "product 39" in names and "filter 0" in names, names
    assert not any(n.startswith("footer") for n in names) and "" not in names, names
    assert names[0] == "Customer Care" and names.index("filter 0") < names.index("product 0"), names[:3]
    # A page that fits keeps every control in page order.
    small = entries[:20]
    assert pick_nodes(small, lambda e: (0, 0.0, 0.0)) == (small, 0)


def check_snapshot_form_state():
    from agent_browser_nav import interactive_nodes
    nodes = [
        ax("1", "heading", "Choose your coverage", backend=1, props=[prop("level", 2)]),
        ax("2", "radiogroup", "Add AppleCare+?"),
        ax("3", "radio", "AppleCare+", "2", 3, [prop("checked", "false")]),
        ax("4", "radio", "No coverage", "2", 4, [prop("checked", "true")]),
        ax("5", "textbox", "Postcode", None, 5, [prop("required", True)], "238839"),
        ax("6", "textbox", "Password", None, 6, [], "hunter2"),
        ax("7", "textbox", "Number", None, 7, [], "4111111111111111"),
        ax("8", "button", "Continue", None, 8, [prop("disabled", True)]),
        ax("9", "textbox", "Notes", None, 9, [], "x" * 80),
    ]
    attrs = {"5": {"type": "text"}, "7": {"type": "text", "autocomplete": "cc-number"}, "9": {"type": "text"}}
    out = list(interactive_nodes(AxCdp(nodes, attrs), [{"id": "main", "loaderId": "l"}]))
    assert out[0] == {"heading": 2, "name": "Choose your coverage", "node": 1}, out[0]
    by_name = dict((e["name"], e) for e in out if "name" in e and "heading" not in e)
    assert by_name["AppleCare+"]["state"] == ["unchecked"] and by_name["AppleCare+"]["group"] == "Add AppleCare+?"
    assert by_name["No coverage"]["state"] == ["checked"]
    assert by_name["Postcode"]["state"] == ["required"] and by_name["Postcode"]["value"] == "238839"
    assert "value" not in by_name["Password"] and "value" not in by_name["Number"]
    assert len(by_name["Notes"]["value"]) == 40
    assert by_name["Continue"]["disabled"] is True
    state = {"next": 1, "refs": {}}
    replace_refs(state, "t1", out)
    assert "ref" not in out[0] and out[1]["ref"] == "e1"
    # A field filled through secure input is listed as filled, never with what it holds; a re-mounted input that
    # still holds the typed text (same value, new node) is recognised the same way; the page's invalid flag stays.
    secure = ["238 839", "hunter2"]
    nodes = [ax("1", "textbox", "Postal Code", None, 1, [prop("required", True), prop("invalid", "true")], "238839"),
             ax("2", "textbox", "Postal Code", None, 2, [], "238839"),
             ax("3", "textbox", "Password", None, 3, [], "\u2022\u2022\u2022\u2022\u2022\u2022\u2022"),
             ax("4", "textbox", "Postal Code", None, 4, [], "")]
    attrs = {"3": {"type": "password", "value": "hunter2"}}
    agent_browser_mask.ACTIVE = secure
    try:
        out = list(interactive_nodes(AxCdp(nodes, attrs), [{"id": "main", "loaderId": "l"}]))
    finally:
        agent_browser_mask.ACTIVE = []
    assert out[0]["value"] == agent_browser_mask.DOTS and out[0]["state"] == ["required", "invalid", "filled securely"], out[0]
    assert out[1]["value"] == agent_browser_mask.DOTS and out[1]["state"] == ["filled securely"], out[1]
    assert out[2]["value"] == agent_browser_mask.DOTS and out[2]["state"] == ["filled securely"], out[2]
    assert "value" not in out[3] and "state" not in out[3], out[3]
    assert "238839" not in json.dumps(out) and "hunter2" not in json.dumps(out)


def check_oopif_refs():
    with port_state(9444) as state:
        sync_tabs(state, ["TAB-A"])
        nodes = [dict(node("FRAME-X", "L-X", 9), oopif="FRAME-X"), dict(node("main", "L-1", 3), oopif=None)]
        replace_refs(state, "t1", nodes)
        assert "oopif" not in nodes[0] and lookup_ref(state, nodes[0]["ref"])[5] == "FRAME-X"
        assert lookup_ref(state, nodes[1]["ref"])[5] is None


class StubWatcher(agent_browser_watch.Watcher):
    """The watcher's event handling without a browser: sends are recorded."""
    def __init__(self, port):
        self.port = port
        self.sent = []
        self.sessions = {"S1": "TAB-A"}
        self.openers = {}
        self.ready = True
    def send(self, method, params=None, session=None, wait=0.0):
        self.sent.append((method, params, session))
        return {}


def check_watcher_dialog_policy():
    watcher = StubWatcher(9555)
    with port_state(9555) as state:
        sync_tabs(state, ["TAB-A"])
    dialog = lambda kind, message: {"method": "Page.javascriptDialogOpening", "sessionId": "S1",
                                    "params": {"type": kind, "message": message, "url": "https://shop.example/"}}
    # A plain alert only shows a message: accepted at once and queued for the next result.
    watcher.on_event(dialog("alert", "Product added"))
    assert watcher.sent == [("Page.handleJavaScriptDialog", {"accept": True}, "S1")]
    # confirm / prompt / beforeunload may commit something: recorded, never answered here.
    for kind in ("confirm", "prompt", "beforeunload"):
        watcher.sent = []
        watcher.on_event(dialog(kind, "Place order for $360?"))
        assert watcher.sent == [], kind
        with port_state(9555) as state:
            assert state["dialogs"]["TAB-A"]["type"] == kind
    watcher.on_event({"method": "Page.javascriptDialogClosed", "sessionId": "S1", "params": {}})
    with port_state(9555) as state:
        assert state["dialogs"] == {} and [e["kind"] for e in state["events"]] == ["alert"]


def check_notices():
    agent_browser_notices.watcher_alive = lambda port: True
    watcher = StubWatcher(9666)
    with port_state(9666) as state:
        sync_tabs(state, ["OPENER"])
        state["active"] = "t1"
    created = lambda tid, opener: {"method": "Target.targetCreated", "params": {"targetInfo": {
        "type": "page", "targetId": tid, "openerId": opener}}}
    watcher.on_event(created("POPUP", "OPENER"))
    assert watcher.sent[-1][0] == "Target.attachToTarget"
    notes = take_notices(9666, ["OPENER", "POPUP"])
    assert notes == {"opened": [{"tab": "t2", "opener": "t1"}]}, notes
    with port_state(9666) as state:
        assert state["active"] == "t2", "the agent follows the popup it opened"
    assert take_notices(9666, ["OPENER", "POPUP"]) == {}, "reported once"
    # The popup closes (OAuth finished): reported, and the current tab returns to the opener.
    watcher.on_event({"method": "Target.targetDestroyed", "params": {"targetId": "POPUP"}})
    notes = take_notices(9666, ["OPENER"])
    assert notes == {"closed": [{"tab": "t2", "opener": "t1"}]}, notes
    with port_state(9666) as state:
        assert state["active"] == "t1"
    assert merge_notices({"a": 1}, {"alerts": [1]}, {"alerts": [2]}) == {"a": 1, "alerts": [1, 2]}


def check_bounds_mapping():
    # Maximized 1440x900 window: 85px of tab strip + toolbar, no border, zoom 1.
    maximized = {"sx": 0, "sy": 0, "ow": 1440, "oh": 860, "iw": 1440, "ih": 775, "dpr": 1}
    quad = [100, 50, 300, 50, 300, 90, 100, 90]
    assert screen_rect(quad, maximized) == {"x": 100, "y": 135, "width": 200, "height": 40}
    # A window at (200, 40) with a 4px border and 125% page zoom.
    framed = {"sx": 200, "sy": 40, "ow": 808, "oh": 700, "iw": 640, "ih": 480, "dpr": 1.25}
    # Viewport: left 204, top 40+700-600-4 = 136; CSS (10,20,40x8) -> (216.5,161,50x10).
    assert screen_rect([10, 20, 50, 20, 50, 28, 10, 28], framed) == {"x": 216, "y": 161, "width": 50, "height": 10}
    # Partly scrolled above the viewport: clipped to its top edge; fully off screen: None.
    assert screen_rect([0, -30, 100, -30, 100, 10, 0, 10], maximized) == {"x": 0, "y": 85, "width": 100, "height": 10}
    assert screen_rect([0, 900, 100, 900, 100, 950, 0, 950], maximized) is None
    assert screen_rect([5, 5, 5, 5, 5, 5, 5, 5], maximized) is None
    assert screen_rect("bad", maximized) is None
    # css_point inverts the mapping: back to CSS pixels, None outside the viewport.
    assert css_point(216.5, 161, framed) == (10.0, 20.0)
    assert css_point(100, 135, maximized) == (100.0, 50.0)
    assert css_point(100, 40, maximized) is None and css_point(1440, 500, maximized) is None


class FillCdp(object):
    """Records every CDP call of a fill; the field reports a value length afterwards."""
    def __init__(self, length):
        self.length = length
        self.calls = []
        self.page = self
        self.offset = (0.0, 0.0)
    def send(self, method, params=None):
        self.calls.append((method, params))
        if method == "Page.getFrameTree":
            return {"frameTree": {"frame": {"id": "main", "loaderId": "L1", "url": "https://shop.example/pay"}}}
        if method == "Accessibility.getFullAXTree":
            return {"nodes": [{"backendDOMNodeId": 7, "role": {"value": "textbox"}, "name": {"value": "Password"}}]}
        if method == "Runtime.evaluate":
            return {"result": {"value": "visible"}}
        if method == "DOM.resolveNode":
            return {"object": {"objectId": "obj-1"}}
        if method == "Runtime.callFunctionOn":
            return {"result": {"value": self.length}}
        if method == "Target.getTargetInfo":
            return {"targetInfo": {"title": "Pay"}}
        return {}


def check_secret_never_echoed():
    secret = "hunter2-\u00e9x"
    cdp = FillCdp(length=11)
    result = do_fill_secret(cdp, "main", "L1", 7, secret)
    assert result == {"ok": True, "action": "fill_secret", "url": "https://shop.example/pay", "title": "Pay", "filled": True}
    inserted = [params for method, params in cdp.calls if method == "Input.insertText"]
    assert inserted == [{"text": secret}], "the value is typed exactly once, via insertText"
    try:
        do_fill_secret(FillCdp(length=0), "main", "L1", 7, secret)
    except HelperError as exc:
        assert secret not in str(exc)
    else:
        raise AssertionError("an empty field after the fill must fail")


class TypeCdp(object):
    """Serves one AX node plus the field's own DOM string value, for do_type."""
    def __init__(self, ax_value, dom_value=None, ax_role="textbox", ax_name="Amount"):
        self.ax_value, self.dom_value = ax_value, dom_value
        self.ax_role, self.ax_name = ax_role, ax_name
        self.page = self
        self.offset = (0.0, 0.0)
    def send(self, method, params=None):
        if method == "Page.getFrameTree":
            return {"frameTree": {"frame": {"id": "main", "loaderId": "L1", "url": "https://shop.example/"}}}
        if method == "Accessibility.getPartialAXTree":
            return {"nodes": []}
        if method == "Accessibility.getFullAXTree":
            node = {"backendDOMNodeId": 7, "role": {"value": self.ax_role},
                    "name": {"value": self.ax_name}}
            if self.ax_value != "absent":
                node["value"] = {"value": self.ax_value}
            return {"nodes": [node]}
        if method == "Runtime.evaluate":
            return {"result": {"value": "visible"}}
        if method == "DOM.resolveNode":
            return {"object": {"objectId": "obj-1"}}
        if method == "Runtime.callFunctionOn":
            return {"result": {"value": self.dom_value}}
        if method == "Target.getTargetInfo":
            return {"targetInfo": {"title": "Shop"}}
        return {}


def check_type_verification():
    """do_type verifies an exact AX string, a spinbutton numeric normalization
    ("0900" reads back as 900, compared exactly), or the DOM string; a missed
    input fails closed, a boolean never counts as a number, and errors echo nothing."""
    assert _spin_equal(900, "900") and _spin_equal(900, "0900")
    assert not _spin_equal(True, "1"), "a boolean is never a number"
    assert not _spin_equal(10 ** 400, str(10 ** 400 + 1)), "large integers compare exactly"
    assert _spin_equal(10 ** 400, "1e400")
    assert not _spin_equal(900, "inf") and not _spin_equal(float("inf"), "1e999")
    typed = do_type(TypeCdp(900, "900", "spinbutton"), "main", "L1", 7, "900")
    assert typed["typed"] is True and typed["url"] == "https://shop.example/"
    assert do_type(TypeCdp(900, "0900", "spinbutton"), "main", "L1", 7, "0900")["typed"] is True
    assert do_type(TypeCdp(None, "900", "spinbutton"), "main", "L1", 7, "0900")["typed"] is True
    assert do_type(TypeCdp(None, "hello"), "main", "L1", 7, "hello")["typed"] is True
    for insert, ax, dom, role in (("901", 900, "900", "spinbutton"),
                                   ("01", "1", "1", "textbox"),
                                   ("hello", None, "hel", "textbox"),
                                   ("hello", None, "", "textbox"),
                                   ("1", True, "", "textbox")):
        try:
            do_type(TypeCdp(ax, dom, role), "main", "L1", 7, insert)
        except HelperError as exc:
            assert insert not in str(exc) and (not dom or dom not in str(exc)), str(exc)
        else:
            raise AssertionError("a missed input must fail: %r vs %r" % (insert, dom))
    secret = do_type(TypeCdp("bullet", "hunter2", "textbox", "Password"), "main", "L1", 7, "hunter2")
    assert secret["typed"] is True
    try:
        do_type(TypeCdp("bullet", "", "textbox", "Password"), "main", "L1", 7, "hunter2")
    except HelperError as exc:
        assert "hunter2" not in str(exc)
    else:
        raise AssertionError("an empty password field after typing must fail")


VECTOR = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public-contracts", "src",
                                     "secure-input-vector.json")))


def check_unseal():
    """The fixed vector produced in Node decrypts here; any change to request, field, ref, key or bytes fails."""
    os.makedirs(agent_browser_seal.KEY_DIR, mode=0o700, exist_ok=True)
    with open(os.path.join(agent_browser_seal.KEY_DIR, "x25519.key"), "wb") as handle:
        handle.write(base64.b64decode(VECTOR["sandboxPrivateKey"]))
    info = agent_browser_seal.public_info()
    assert info == {"alg": VECTOR["alg"], "keyId": VECTOR["keyId"], "publicKey": VECTOR["sandboxPublicKey"]}, info
    private = agent_browser_seal.load_private()
    ok = (VECTOR["requestId"], VECTOR["fieldId"], VECTOR["ref"])
    assert agent_browser_seal.unseal(private, VECTOR["sealed"], *ok) == VECTOR["value"]
    for bad in ((ok[0] + "x", ok[1], ok[2]), (ok[0], "f2", ok[2]), (ok[0], ok[1], "e13")):
        expect_error(lambda bad=bad: agent_browser_seal.unseal(private, VECTOR["sealed"], *bad), "could not be unsealed")
    flipped = dict(VECTOR["sealed"], ciphertext=base64.b64encode(
        bytes([base64.b64decode(VECTOR["sealed"]["ciphertext"])[0] ^ 1]) +
        base64.b64decode(VECTOR["sealed"]["ciphertext"])[1:]).decode("ascii"))
    expect_error(lambda: agent_browser_seal.unseal(private, flipped, *ok), "could not be unsealed")
    expect_error(lambda: agent_browser_seal.unseal(private, {"value": "plain"}, *ok), "malformed")
    expect_error(lambda: agent_browser_seal.unseal(private, dict(VECTOR["sealed"], nonce="AAAA"), *ok), "malformed")
    # A different sandbox key (the sandbox was recreated) cannot open it either.
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
    expect_error(lambda: agent_browser_seal.unseal(X25519PrivateKey.generate(), VECTOR["sealed"], *ok), "could not be unsealed")
    # A key generated on first use is 0600 in a 0700 directory.
    fresh = os.path.join(tempfile.mkdtemp(prefix="agent-browser-keys2-"), "k")
    old, agent_browser_seal.KEY_DIR = agent_browser_seal.KEY_DIR, fresh
    try:
        first = agent_browser_seal.public_info()
        assert first == agent_browser_seal.public_info() and first["keyId"] != VECTOR["keyId"]
        assert oct(os.stat(fresh).st_mode & 0o777) == "0o700"
        assert oct(os.stat(os.path.join(fresh, "x25519.key")).st_mode & 0o777) == "0o600"
    finally:
        agent_browser_seal.KEY_DIR = old


def check_masking():
    mask = agent_browser_mask
    card = "4242 4242 4242 4242"
    assert mask.redact_text("Card 4242424242424242 paid", [card]) == "Card " + mask.DOTS + " paid"
    assert mask.redact_text("Card 4242 4242 4242 4242", [card]) == "Card " + mask.DOTS
    assert mask.redact_text("Ship to 12 Main St, Singapore\nunit 5", ["12 Main St"]) == "Ship to " + mask.DOTS + ", Singapore\nunit 5"
    # A value carried in a URL (GET form, redirect) is found in both escapings.
    url = "https://shop.example/review?name=Jane+Q+Doe&phone=%2B65+9123+4567&alt=Jane%20Q%20Doe"
    assert mask.redact_text(url, ["Jane Q Doe", "+65 9123 4567"]) == "https://shop.example/review?name=%s&phone=%s&alt=%s" % ((mask.DOTS,) * 3)
    # A short secret only matches a whole value, never a piece of other text.
    assert mask.redact_text("5", ["5"]) == mask.DOTS and mask.redact_text("room 5 of 50", ["5"]) == "room 5 of 50"
    assert mask.redact_text("+65 9123-4567", ["91234567"]) == "+65 " + mask.DOTS
    result = {"ok": True, "action": "snapshot", "nodes": [{"ref": "e1", "role": "textbox", "name": "Phone", "value": "9123 4567"},
                                                          {"ref": "e2", "role": "button", "name": "Buy"}]}
    redacted = mask.redact_deep(result, ["91234567", "button"])
    assert redacted["nodes"][0]["value"] == mask.DOTS and redacted["nodes"][1]["role"] == "button"
    assert mask.redact_deep(result, []) is result
    assert mask.holds_secret("4242424242424242", [card]) and not mask.holds_secret("jane@example.com", [card])
    script = mask.mask_script(["a</script>b"])
    assert "</script>" not in script and "-webkit-text-security" in script


if __name__ == "__main__":
    main()
