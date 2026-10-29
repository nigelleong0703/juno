"""Model-blind pages after a secure fill (BACKEND 8.7): masking in the page and redaction in every result.

The values the user sealed to this sandbox live only in the watcher process's memory (agent_browser_watch,
root, one per CDP port) and, in the page, inside a script that runs in an ISOLATED WORLD (so page scripts
cannot read it). The watcher registers it with Page.addScriptToEvaluateOnNewDocument(worldName=...) on every
tab it watches, so it also runs on every later page of the tab. In the page it

  * renders any input/textarea whose value holds a secret as dots (`-webkit-text-security: disc` on the
    element, the value itself untouched so the site still submits it), and
  * replaces text that holds a secret (the review page that repeats the address or phone) with dots, now
    and for nodes added later (MutationObserver).

Screenshots are taken of that masked page. Independently, every result this helper returns (snapshot,
get_text, titles, urls, errors) is passed through `redact_deep`, and `field_value` drops a field whose value
holds a secret, so the model never reads a filled value even where the page script did not run.

Matching: case-insensitive, and ignoring spaces and `-().,` (so a reformatted card or phone number still
matches). A secret shorter than 4 characters only matches a whole field value or whole text, never a piece of
longer text, or a unit number like "5" would blank the page. Limits: cross-origin iframes are separate
targets the watcher does not inject into; a page that reformats a value beyond those separators (adds a
country code, changes digits) is not recognised.
"""
import json
import re
import urllib.parse
from typing import Any, Dict, Iterable, List

DOTS = "••••"
WORLD = "juno-mask"
MIN_PIECE = 4
MAX_SECRETS = 64
# The secrets of the current helper call (set by agent-browser), read by field_value.
ACTIVE = []  # type: List[str]
# Keys whose strings are machine words (refs, roles, flags), never page text: a secret equal to one must not break them.
SKIP_KEYS = frozenset(["ref", "tab", "role", "action", "state", "handle", "kind", "type", "ok", "frame", "loader",
                       "node", "target", "opener", "seq", "site"])

_SEPARATORS = re.compile(r"[\s\-().,]")


def norm(text):
    # type: (str) -> str
    return _SEPARATORS.sub("", text).lower()


def _pattern(secret):
    # type: (str) -> Any
    """The secret with optional separators between its characters, so "4242 4242" also finds "4242-4242"."""
    chars = [re.escape(c) for c in secret if not _SEPARATORS.match(c)]
    return re.compile(r"[\s\-().,]*".join(chars), re.IGNORECASE)


def _encoded(secret):
    # type: (str) -> List[str]
    """The ways a URL carries the secret (a GET form, a redirect): %-escaped, and with + for spaces."""
    forms = [urllib.parse.quote(secret, safe=""), urllib.parse.quote_plus(secret, safe="")]
    return [form for form in dict.fromkeys(forms) if form != secret]


def _line(line, secrets):
    # type: (str, List[str]) -> str
    for secret in sorted(secrets, key=len, reverse=True):
        n = norm(secret)
        if not n:
            continue
        if len(n) < MIN_PIECE:
            if norm(line) == n:
                return DOTS
            continue
        replaced = _pattern(secret).sub(DOTS, line)
        for form in _encoded(secret):
            replaced = re.sub(re.escape(form), DOTS, replaced, flags=re.IGNORECASE)
        if replaced != line:
            line = replaced
        elif n in norm(line):
            return DOTS
    return line


def redact_text(text, secrets):
    # type: (str, List[str]) -> str
    if not secrets:
        return text
    return "\n".join(_line(line, secrets) for line in text.split("\n"))


def redact_deep(value, secrets):
    # type: (Any, List[str]) -> Any
    """`value` (a helper result) with every secret replaced by dots in all page-derived strings."""
    if not secrets:
        return value
    if isinstance(value, str):
        return redact_text(value, secrets)
    if isinstance(value, list):
        return [redact_deep(item, secrets) for item in value]
    if isinstance(value, dict):
        return dict((key, item if key in SKIP_KEYS else redact_deep(item, secrets)) for key, item in value.items())
    return value


def holds_secret(text, secrets):
    # type: (str, Iterable[str]) -> bool
    """True when a field value holds a secret (same rule as the page script: a short secret must be the whole value)."""
    n_text = norm(text)
    for secret in secrets:
        n = norm(secret)
        if n and ((len(n) >= MIN_PIECE and n in n_text) or n_text == n):
            return True
    return False


# The script every watched tab runs in its isolated world. `__SECRETS__` is replaced by a JSON array.
_SCRIPT = """(function () {
  try {
    var SECRETS = __SECRETS__;
    var DOTS = '\\u2022\\u2022\\u2022\\u2022', MIN = 4;
    function norm(s) { return String(s).replace(/[\\s\\-().,]/g, '').toLowerCase(); }
    var items = SECRETS.map(function (s) { return { raw: s, n: norm(s), re: new RegExp(s.split('').filter(function (c) { return !/[\\s\\-().,]/.test(c); }).map(function (c) { return c.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'); }).join('[\\\\s\\\\-().,]*'), 'gi') }; })
      .filter(function (i) { return i.n.length > 0; })
      .sort(function (a, b) { return b.raw.length - a.raw.length; });
    if (!items.length) return;
    function holds(text) {
      var n = norm(text);
      return items.some(function (i) { return (i.n.length >= MIN && n.indexOf(i.n) >= 0) || n === i.n; });
    }
    function scrub(text) {
      var n = norm(text), out = text;
      for (var k = 0; k < items.length; k++) {
        var i = items[k];
        if (i.n.length < MIN) { if (norm(out) === i.n) return DOTS; continue; }
        i.re.lastIndex = 0;
        var replaced = out.replace(i.re, DOTS);
        if (replaced !== out) out = replaced;
        else if (norm(out).indexOf(i.n) >= 0) return DOTS;
      }
      return out;
    }
    var masked = typeof WeakSet === 'function' ? new WeakSet() : null;
    function field(el) {
      var hit = holds(el.value || '');
      if (hit) { el.style.setProperty('-webkit-text-security', 'disc', 'important'); if (masked) masked.add(el); }
      else if (masked && masked.has(el)) { el.style.removeProperty('-webkit-text-security'); masked.delete(el); }
    }
    function text(node) {
      var parent = node.parentNode;
      if (!parent || /^(SCRIPT|STYLE|TEXTAREA|NOSCRIPT)$/.test(parent.nodeName)) return;
      var data = node.nodeValue;
      if (!data || data === DOTS) return;
      var next = scrub(data);
      if (next !== data) node.nodeValue = next;
    }
    function walk(root) {
      if (!root) return;
      if (root.nodeType === 3) { text(root); return; }
      if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
      var w = document.createTreeWalker(root, 4 /* SHOW_TEXT */), n;
      while ((n = w.nextNode())) text(n);
      if (root.querySelectorAll) Array.prototype.forEach.call(root.querySelectorAll('input,textarea'), field);
    }
    function sweep() {
      Array.prototype.forEach.call(document.querySelectorAll('input,textarea'), field);
    }
    function start() {
      walk(document);
      new MutationObserver(function (records) {
        records.forEach(function (r) {
          if (r.type === 'characterData') text(r.target);
          else Array.prototype.forEach.call(r.addedNodes, walk);
        });
      }).observe(document, { childList: true, subtree: true, characterData: true });
      document.addEventListener('input', function (e) { if (e.target && e.target.value !== undefined) field(e.target); }, true);
      document.addEventListener('change', sweep, true);
      document.addEventListener('DOMContentLoaded', function () { walk(document); });
      setInterval(sweep, 300);
    }
    start();
  } catch (e) {}
})();"""


def mask_script(secrets):
    # type: (List[str]) -> str
    return _SCRIPT.replace("__SECRETS__", json.dumps(list(secrets)).replace("</", "<\\/"))


def clean_values(values):
    # type: (Any) -> List[str]
    if not isinstance(values, list) or not 1 <= len(values) <= 8 or not all(isinstance(v, str) and 1 <= len(v) <= 512 for v in values):
        raise ValueError("mask needs 1..8 string values")
    return list(values)
