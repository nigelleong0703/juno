"""What happened in the browser since the agent last looked: open dialogs, auto-accepted alerts,
tabs that opened (popups, target=_blank) and closed. The watcher (agent_browser_watch) records them
in the port state file; every agent-facing helper result reports the ones not yet reported.
"""
from typing import Any, Dict, List, Optional

from agent_browser_refs import handle_for, port_state, sync_tabs
from agent_browser_watch import watcher_alive


def dialog_reader(port):
    # type: (int) -> Any
    """dialog_of(target) for agent_browser_cdp.connect: the open dialog the watcher recorded, else None.

    Without a live watcher nothing recorded is trusted (it may be stale)."""
    def dialog_of(target_id):
        # type: (str) -> Optional[Dict[str, Any]]
        if not watcher_alive(port):
            return None
        with port_state(port) as state:
            dialog = (state.get("dialogs") or {}).get(target_id)
            if dialog is None:
                return None
            return dict(dialog, tab=handle_for(state, target_id) if target_id in state["tabs"].values() else "")
    return dialog_of


def open_dialogs(port, open_ids):
    # type: (int, List[str]) -> List[Dict[str, Any]]
    """Every tab's open dialog (for a check that cannot talk to a blocked page)."""
    if not watcher_alive(port):
        return []
    with port_state(port) as state:
        sync_tabs(state, open_ids)
        dialogs = state.get("dialogs") or {}
        return [dict(dialogs[tid], tab=handle_for(state, tid)) for tid in open_ids if tid in dialogs]


def take_notices(port, open_ids):
    # type: (int, List[str]) -> Dict[str, Any]
    """Unreported events as result fields (alerts / opened / closed), marked reported.

    A closed tab that was the current one hands "current" back to its opener (an OAuth popup that
    finished returns to the page that opened it)."""
    alive = set(open_ids)
    out = {}  # type: Dict[str, Any]
    with port_state(port) as state:
        known = dict((tid, h) for h, tid in state["tabs"].items())  # handles of tabs closed since
        sync_tabs(state, open_ids)
        reported = state.get("reported", 0)
        events = [e for e in state.get("events") or [] if e.get("seq", 0) > reported]
        state["reported"] = max([reported] + [e.get("seq", 0) for e in events])
        tab_of = dict((tid, h) for h, tid in state["tabs"].items())
        for event in events:
            kind = event.get("kind")
            target = event.get("target", "")
            if kind == "alert":
                out.setdefault("alerts", []).append({"tab": tab_of.get(target, ""), "message": event.get("message", "")})
            elif kind == "opened" and target in alive:
                opener = tab_of.get(event.get("opener", ""), "")
                out.setdefault("opened", []).append({"tab": tab_of[target], "opener": opener})
                state.setdefault("openedBy", {})[tab_of[target]] = opener
                if opener and state.get("active") == opener:
                    state["active"] = tab_of[target]  # the agent follows the popup it opened
            elif kind == "closed":
                opener = event.get("opener", "")
                note = {"tab": event.get("handle") or known.get(target, ""), "opener": tab_of.get(opener, "")}
                out.setdefault("closed", []).append(note)
                if state.get("active") is None and opener in alive:
                    state["active"] = tab_of[opener]
        opened_by = state.get("openedBy") or {}
        for handle in [h for h in opened_by if h not in state["tabs"]]:
            del opened_by[handle]
    return out


def merge_notices(result, *notices):
    # type: (Dict[str, Any], Dict[str, Any]) -> Dict[str, Any]
    for notice in notices:
        for key, items in notice.items():
            result.setdefault(key, []).extend(items)
    return result
