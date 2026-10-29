"""Pinned Jev DOM observation and scroll geometry, transported over Juno's owned CDP/ref seam."""
import json
import time
from agent_browser_cdp import HelperError, page_identity
from agent_browser_frames import oopif_sessions
from agent_browser_nav import page_frames
from agent_browser_refs import check_fresh
from agent_browser_input import ensure_visible
from agent_browser_jev_scripts import ENUMERATE, SCROLL_BOX_MAIN, SCROLL_BOX_OF, SCROLL_OFFSET


def evaluate(view, expression, context=None):
    args = {"expression": expression, "returnByValue": True}
    if context is not None:
        args["contextId"] = context
    result = view.send("Runtime.evaluate", args)
    if result.get("exceptionDetails"):
        raise HelperError("upstream page script failed")
    return result.get("result", {}).get("value")


def enumerate_page(cdp):
    """Original ENUMERATE, unchanged. Only the frame transport and canonical ref binding differ."""
    elements, bindings, base, skipped, frame_number = [], [], None, 0, 0
    for view in [cdp] + oopif_sessions(cdp):
        for frame in page_frames(view):
            if not frame.get("url"):
                continue
            start = len(elements)
            frame_index = frame_number
            frame_number += 1
            try:
                context = view.send("Page.createIsolatedWorld", {"frameId": frame["id"], "worldName": "juno-upstream-browser"})["executionContextId"]
                args = {"start": start, "frame": frame_index or None}
                page = evaluate(view, "(" + ENUMERATE + ")(" + json.dumps(args) + ")", context)
                if base is None:
                    base = page
                # Resolve original data-jev-i markers to immutable backend nodes; never act by caller script.
                dom = view.send("DOM.getFlattenedDocument", {"depth": -1, "pierce": True})["nodes"]
                nodes, attributes = {}, {}
                for node in dom:
                    attrs = node.get("attributes", [])
                    attrs = dict(zip(attrs[::2], attrs[1::2]))
                    if "data-jev-i" in attrs:
                        nodes[attrs["data-jev-i"]] = node["backendNodeId"]
                        attributes[attrs["data-jev-i"]] = attrs
                for element in page["elements"]:
                    backend = nodes.get(str(element["i"]))
                    if backend is None:
                        raise HelperError("upstream control disappeared while binding refs")
                    attrs = attributes.get(str(element["i"]), {})
                    if "readonly" in attrs or attrs.get("aria-readonly") == "true":
                        element["readonly"] = True
                    if element.get("tag") == "input:password" and element.get("value"):
                        element["value"] = "[redacted]"
                    binding = {"frame": frame["id"], "loader": frame["loaderId"], "node": backend}
                    if view is not cdp:
                        binding["oopif"] = view.target
                    bindings.append(binding)
                    elements.append(element)
            except (HelperError, KeyError, TypeError):
                skipped += 1
    if base is None:
        raise HelperError("upstream main frame observation unavailable")
    page = {"url": base["url"], "title": base["title"], "text": base["text"],
            "metrics": dict(base.get("metrics", {}), elements=len(elements)), "elements": elements}
    if base.get("dialogs"):
        page["dialogs"] = base["dialogs"]
    if skipped:
        page["metrics"]["skippedFrames"] = skipped
    return {"ok": True, "action": "snapshot", "url": page["url"], "title": page["title"],
            "nodes": [], "crossOriginFrames": skipped, "upstream": page, "bindings": bindings}


def bind_observation(result, state, replace_refs):
    bindings = result.pop("bindings")
    replace_refs(state, result["tab"], bindings)
    nodes = []
    for element, binding in zip(result["upstream"]["elements"], bindings):
        element["ref"] = binding["ref"]
        tag = element["tag"]
        role = "textbox" if tag.startswith("input:") and tag not in ("input:checkbox", "input:radio") else tag.split(":")[-1]
        node = {"ref": binding["ref"], "role": role, "name": element.get("label") or element.get("text") or element.get("placeholder") or ""}
        if "value" in element and tag != "input:password":
            node["value"] = str(element["value"])[:80]
        state_flags = []
        if "checked" in element:
            state_flags.append("checked" if element["checked"] else "unchecked")
        if element.get("readonly"):
            state_flags.append("readonly")
        if state_flags:
            node["state"] = state_flags
        if element.get("disabled"):
            node["disabled"] = True
        nodes.append(node)
    result["nodes"] = nodes[:240]
    if len(nodes) > 240:
        result["omitted"] = len(nodes) - 240


def scroll(cdp, direction, view=None, frame=None, loader=None, backend=None):
    """Original scroll() geometry/80% step/landing loop; CDP wheel replaces Playwright mouse."""
    ensure_visible(cdp)
    view = view or cdp
    viewport = evaluate(cdp, "({w:innerWidth,h:innerHeight})")
    context = None
    if backend is not None:
        check_fresh(view, frame, loader)
        context = view.send("Page.createIsolatedWorld", {"frameId": frame, "worldName": "juno-upstream-browser"})["executionContextId"]
        obj = view.send("DOM.resolveNode", {"backendNodeId": backend})["object"]["objectId"]
        try:
            result = view.send("Runtime.callFunctionOn", {"objectId": obj, "functionDeclaration": "function(){return {aim:(" + SCROLL_BOX_OF + ")(this),rect:this.getBoundingClientRect().toJSON()}}", "returnByValue": True})
            value = result["result"]["value"]
            aim, rect = value["aim"], value["rect"]
        finally:
            view.send("Runtime.releaseObject", {"objectId": obj})
        quad = view.send("DOM.getBoxModel", {"backendNodeId": backend})["model"]["content"]
        center = ((min(quad[::2]) + max(quad[::2])) / 2, (min(quad[1::2]) + max(quad[1::2])) / 2)
        # Map frame-local upstream geometry to the page input coordinates, as locate().boundingBox does.
        local = (rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2)
        aim["x"] = aim.get("x", local[0]) + center[0] - local[0] + view.offset[0]
        aim["y"] = aim.get("y", local[1]) + center[1] - local[1] + view.offset[1]
    else:
        aim = evaluate(cdp, "(" + SCROLL_BOX_MAIN + ")()")
    x, y = aim.get("x", viewport["w"] / 2), aim.get("y", viewport["h"] / 2)
    step = max(100, round(aim.get("h", viewport["h"]) * .8))
    offset = lambda: evaluate(view, "(" + SCROLL_OFFSET + ")()", context)
    start = offset()
    cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
    cdp.send("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": min(max(x, 0), viewport["w"] - 1), "y": min(max(y, 0), viewport["h"] - 1), "deltaX": 0, "deltaY": -step if direction == "up" else step})
    last, t0 = start, time.monotonic()
    while time.monotonic() - t0 < 1.5:
        time.sleep(.05)
        now = offset()
        if now == last and (now != start or time.monotonic() - t0 >= .5):
            break
        last = now
    url, title = page_identity(cdp)
    return {"ok": True, "action": "scroll", "url": url, "title": title, "scrolled": round(last - start)}
