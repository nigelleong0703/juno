"""Short action refs (e12) and tab handles (t2), kept in a per-port state file.

Each helper call is its own process, so the ref map lives on disk: one JSON
file per CDP port (one port = one agent's Chromium), guarded by flock and
replaced atomically so parallel calls never see a half-written map. A ref
names its tab, frame, frame document (loader) and DOM node, so click/type
need only the ref: they cannot land on another tab, and a ref whose frame
navigated fails as stale instead of acting on the new page. Refs are
numbered across all tabs and never reused while the state file lives.
"""
import contextlib
import fcntl
import json
import os
import re
import tempfile
from typing import Any, Dict, Iterator, List, Optional, Tuple

from agent_browser_cdp import HelperError

STATE_ROOT = os.environ.get("AGENT_BROWSER_STATE", "/tmp/agent-browser")

INTERACTIVE_ROLES = frozenset([
    "button", "link", "textbox", "searchbox", "checkbox", "radio",
    "combobox", "switch", "slider", "spinbutton", "tab", "menuitem",
    "menuitemcheckbox", "menuitemradio", "option",
])

# Tolerant spellings a model might send for e12: "@e12", "ref=e12",
# "[ref=e12]", "E12", or the bare number "12".
REF_RE = re.compile(r"^\[?(?:ref\s*=\s*)?@?e?(\d+)\]?$", re.IGNORECASE)
TAB_RE = re.compile(r"^t?(\d+)$", re.IGNORECASE)


def _ax_str(value):
    # type: (Any) -> str
    if isinstance(value, dict) and isinstance(value.get("value"), str):
        result = value["value"]
        return result
    return ""


def _ax_state(node, name):
    # type: (Dict[str, Any], str) -> bool
    raw = node.get(name)
    if isinstance(raw, dict):
        return raw.get("value") is True
    if raw is True:
        return True
    props = node.get("properties")
    if isinstance(props, list):
        for prop in props:
            if not isinstance(prop, dict) or prop.get("name") != name:
                continue
            val = prop.get("value")
            if _ax_str(val) == "true":
                return True
            if isinstance(val, dict) and val.get("value") is True:
                return True
    return False


def _is_disabled(node):
    # type: (Dict[str, Any]) -> bool
    return _ax_state(node, "disabled")


def _is_readonly(node):
    # type: (Dict[str, Any]) -> bool
    return _ax_state(node, "readonly")


def normalize_ref(ref):
    # type: (Any) -> str
    match = REF_RE.match(ref.strip()) if isinstance(ref, str) else None
    if not match:
        raise HelperError("unknown ref %r: refs look like e12;"
                          " take a fresh browser.snapshot" % (ref,))
    return "e%d" % int(match.group(1))


def normalize_tab(tab):
    # type: (Any) -> str
    match = TAB_RE.match(tab.strip()) if isinstance(tab, str) else None
    if not match:
        raise HelperError("unknown tab %r: tabs look like t2;"
                          " call browser.tabs" % (tab,))
    return "t%d" % int(match.group(1))


def _empty():
    # type: () -> Dict[str, Any]
    return {"next": 1, "nextTab": 1, "tabs": {}, "active": None, "refs": {}}


@contextlib.contextmanager
def port_state(port):
    # type: (int) -> Iterator[Dict[str, Any]]
    """Locked read-modify-write of one port's state; saved on clean exit."""
    os.makedirs(STATE_ROOT, mode=0o700, exist_ok=True)
    path = os.path.join(STATE_ROOT, "%d.json" % port)
    with open(path + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with open(path) as handle:
                state = json.load(handle)
            if not isinstance(state, dict) or not isinstance(state.get("refs"), dict):
                state = _empty()
        except (OSError, ValueError):
            state = _empty()
        yield state
        fd, tmp = tempfile.mkstemp(dir=STATE_ROOT, prefix=".%d." % port)
        with os.fdopen(fd, "w") as out:
            json.dump(state, out, separators=(",", ":"))
        os.replace(tmp, path)


def sync_tabs(state, open_ids):
    # type: (Dict[str, Any], List[str]) -> None
    """Forget closed tabs (and their refs); give every open tab a handle."""
    alive = set(open_ids)
    tabs = state["tabs"]
    for handle in [h for h, tid in tabs.items() if tid not in alive]:
        del tabs[handle]
    known = set(tabs.values())
    for tid in open_ids:
        if tid not in known:
            tabs["t%d" % state["nextTab"]] = tid
            state["nextTab"] += 1
    refs = state["refs"]
    for ref in [r for r, entry in refs.items() if entry[0] not in tabs]:
        del refs[ref]
    if state.get("active") not in tabs:
        state["active"] = None


def handle_for(state, target_id):
    # type: (Dict[str, Any], str) -> str
    for handle, tid in state["tabs"].items():
        if tid == target_id:
            return handle
    raise HelperError("tab closed while acting; call browser.tabs")


def target_for(state, tab):
    # type: (Dict[str, Any], str) -> str
    handle = normalize_tab(tab)
    target = state["tabs"].get(handle)
    if target is None:
        raise HelperError("unknown tab %r: it may be closed; call browser.tabs" % (tab,))
    return target


def _entry_key(entry):
    # type: (List[Any]) -> Any
    """Identity of one minted ref: its tab, frame, frame document and DOM node
    (plus the cross-origin iframe target when minted inside one)."""
    return (entry[1], entry[2], entry[3], entry[4] if len(entry) > 4 else None)


def replace_refs(state, handle, nodes):
    # type: (Dict[str, Any], str, List[Dict[str, Any]]) -> None
    """Stable refs across snapshots in one tab: a surviving backend-DOM node in
    the same frame, document (loader) and iframe target keeps its ref, even when
    its role/name/value changed; refs absent from the new snapshot are dropped,
    and a replaced document (loader) therefore invalidates every ref. Ids are
    monotonic and never reassigned to a different node. Execution always
    re-reads the live AX node, so a kept ref never acts on stale semantics."""
    refs = state["refs"]
    live = {}
    for ref, entry in refs.items():
        if entry[0] != handle or len(entry) < 4:
            continue
        live[_entry_key(entry)] = ref
    for ref in [r for r, entry in refs.items() if entry[0] == handle]:
        del refs[ref]
    for node in nodes:
        if "heading" in node:
            continue  # context line only: no ref to act on
        frame = node.pop("frame")
        loader = node.pop("loader")
        backend = node.pop("node")
        oopif = node.pop("oopif", None)
        key = (frame, loader, backend, oopif if oopif else None)
        ref = live.pop(key, None)
        if ref is None or ref in refs:
            ref = "e%d" % state["next"]
            state["next"] += 1
        entry = [handle, frame, loader, backend]
        if oopif:
            entry.append(oopif)  # minted inside a cross-origin iframe (agent_browser_frames)
        refs[ref] = entry
        node["ref"] = ref


def lookup_ref(state, ref):
    # type: (Dict[str, Any], Any) -> Tuple[str, str, str, str, int, Optional[str]]
    """(tab handle, target id, frame id, loader id, backend node id, cross-origin iframe target or None)."""
    key = normalize_ref(ref)
    entry = state["refs"].get(key)
    if entry is None:
        raise HelperError("unknown or stale ref %r: take a fresh browser.snapshot" % (ref,))
    handle, frame_id, loader_id, backend_id = entry[:4]
    target = state["tabs"].get(handle)
    if target is None:
        raise HelperError("ref %s belongs to a closed tab; take a fresh browser.snapshot" % key)
    return handle, target, frame_id, loader_id, backend_id, (entry[4] if len(entry) > 4 else None)


def find_frame(tree, frame_id):
    # type: (Dict[str, Any], str) -> Optional[Dict[str, Any]]
    frame = tree.get("frame") or {}
    if frame.get("id") == frame_id:
        return frame
    for child in tree.get("childFrames") or []:
        found = find_frame(child, frame_id)
        if found is not None:
            return found
    return None


def check_fresh(cdp, frame_id, loader_id):
    # type: (Any, str, str) -> None
    """Refuse a ref whose frame is gone or whose document was replaced."""
    tree = cdp.send("Page.getFrameTree").get("frameTree") or {}
    frame = find_frame(tree, frame_id)
    if frame is None:
        raise HelperError("stale ref: its frame is gone; take a fresh browser.snapshot")
    if frame.get("loaderId", "") != loader_id:
        raise HelperError("stale ref: the page navigated or reloaded;"
                          " take a fresh browser.snapshot")
