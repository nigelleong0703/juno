"""attrs: the form-control attributes behind refs (type, autocomplete, maxlength, required, min/max,
<select> options, label), so a secure-input request is typed from the real page form, not a guess.

Read-only: nothing is typed, focused or scrolled. Never reads a field's value (a password or card
number already on the page must not travel back), only the attributes that describe the control.
"""
from typing import Any, Dict

from agent_browser_cdp import HelperError, page_identity
from agent_browser_refs import check_fresh

MAX_OPTIONS = 100

FN_ATTRS = """function () {
  var e = this, tag = (e.tagName || '').toLowerCase();
  function str(v, n) { return typeof v === 'string' && v ? v.slice(0, n || 80) : undefined; }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : undefined; }
  var out = {tag: tag, type: str((e.getAttribute && e.getAttribute('type')) || (tag === 'input' ? 'text' : ''), 24),
    autocomplete: str(e.getAttribute('autocomplete'), 120), id: str(e.id), name: str(e.getAttribute('name')),
    placeholder: str(e.getAttribute('placeholder')), inputmode: str(e.getAttribute('inputmode'), 24),
    pattern: str(e.getAttribute('pattern'), 120)};
  var ml = num(e.getAttribute('maxlength'));
  if (ml !== undefined && ml > 0) out.maxLength = ml;
  var min = num(e.getAttribute('min')), max = num(e.getAttribute('max')), step = num(e.getAttribute('step'));
  if (min !== undefined) out.min = min;
  if (max !== undefined) out.max = max;
  if (step !== undefined && step > 0) out.step = step;
  if (e.hasAttribute('required')) out.required = true;
  else if (e.getAttribute('aria-required') === 'true') out.required = true;
  else if (e.getAttribute('aria-required') === 'false') out.required = false;
  var label = (e.labels && e.labels[0] && e.labels[0].textContent) || e.getAttribute('aria-label') || '';
  out.label = str(String(label).replace(/\\s+/g, ' ').trim());
  if (tag === 'select') {
    out.options = Array.prototype.slice.call(e.options || [], 0, %d).map(function (o) {
      return (o.value || o.textContent || '').trim().slice(0, 80);
    }).filter(function (v) { return v; });
  }
  return out;
}""" % MAX_OPTIONS


def do_attrs(view, frame_id, loader_id, backend_id, ref):
    # type: (Any, str, str, int, str) -> Dict[str, Any]
    """The attributes of one ref's control; a stale ref fails like every other ref action."""
    check_fresh(view, frame_id, loader_id)
    resolved = view.send("DOM.resolveNode", {"backendNodeId": backend_id})
    object_id = (resolved.get("object") or {}).get("objectId")
    if not isinstance(object_id, str):
        raise HelperError("target changed; take a fresh snapshot")
    res = view.send("Runtime.callFunctionOn", {"objectId": object_id, "functionDeclaration": FN_ATTRS,
                                               "returnByValue": True})
    value = (res.get("result") or {}).get("value")
    if not isinstance(value, dict):
        raise HelperError("could not read the control's attributes")
    field = dict((k, v) for k, v in value.items() if v is not None)
    field["ref"] = ref
    url, title = page_identity(view.page)
    return {"ok": True, "action": "attrs", "url": url, "title": title, "fields": [field]}
