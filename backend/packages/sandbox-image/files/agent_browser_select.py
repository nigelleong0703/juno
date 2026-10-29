"""Select an exact observed HTML option; custom ARIA options keep native pointer input.

This fixed helper dispatches DOM input/change events, not trusted pointer events.
No page code, selector or value is accepted from the model. Callers verify document
freshness and page visibility before reaching this helper.
"""
from agent_browser_cdp import HelperError


SELECT_OPTION = """function() {
  const option = this;
  const select = option.closest('select');
  const win = option.ownerDocument.defaultView;
  function validate() {
    if (!option.isConnected || !select || !select.isConnected || !select.contains(option))
      throw new Error('option is detached; take a fresh snapshot');
    if (select.multiple) throw new Error('multiple select requires explicit multi-selection support');
    if (select.disabled || option.matches(':disabled') || select.getAttribute('aria-disabled') === 'true')
      throw new Error('option or select is disabled');
    if (select.getAttribute('aria-readonly') === 'true') throw new Error('select is readonly');
    const style = win.getComputedStyle(select), rect = select.getBoundingClientRect();
    if (!rect.width || !rect.height || style.visibility !== 'visible' || select.closest('[inert]'))
      throw new Error('select is not visible or interactive');
  }
  validate();
  if (option.selected) return true;
  select.scrollIntoView({block:'nearest', inline:'nearest'});
  select.focus();
  validate();
  option.selected = true;
  if (!option.selected) throw new Error('option selection was rejected');
  select.dispatchEvent(new win.Event('input', {bubbles:true}));
  select.dispatchEvent(new win.Event('change', {bubbles:true}));
  // A change handler may replace the entire form. The caller returns a new snapshot;
  // it must verify the resulting form rather than retrying a detached old option.
  if (option.isConnected && !option.selected) throw new Error('page rejected option selection');
  return true;
}"""


def select_option(view, backend_id):
    """Return False for non-options; raise on refused or unconfirmed selection."""
    node = view.send('DOM.describeNode', {'backendNodeId': backend_id}).get('node') or {}
    if node.get('localName') != 'option':
        return False
    resolved = view.send('DOM.resolveNode', {'backendNodeId': backend_id})
    object_id = (resolved.get('object') or {}).get('objectId')
    if not object_id:
        raise HelperError('option is detached; take a fresh snapshot')
    try:
        result = view.send('Runtime.callFunctionOn', {
            'objectId': object_id, 'functionDeclaration': SELECT_OPTION, 'returnByValue': True})
        if result.get('exceptionDetails'):
            exception = result['exceptionDetails'].get('exception') or {}
            raise HelperError('cannot select option: ' + str(exception.get('description') or 'page rejected selection'))
        if (result.get('result') or {}).get('value') is not True:
            raise HelperError('option selection was not confirmed; take a fresh snapshot')
        return True
    finally:
        # Cleanup must not hide an action error (including a navigation during change).
        try:
            view.send('Runtime.releaseObject', {'objectId': object_id})
        except HelperError:
            pass
