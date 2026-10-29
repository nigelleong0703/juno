import { describe, expect, it } from 'vitest';
import { capabilityKind, classifyTool } from '../tool-access.js';

// Annotation shapes as MCP servers send them (spec 2025-06-18 ToolAnnotations).
describe('classifyTool', () => {
  it('trusts readOnlyHint true', () => {
    expect(classifyTool({ name: 'weird_name', annotations: { readOnlyHint: true, title: 'Weird' } })).toBe('read');
  });

  it('treats readOnlyHint false or destructiveHint true as an action, even with a read-looking name', () => {
    expect(classifyTool({ name: 'get_thing', annotations: { readOnlyHint: false } })).toBe('action');
    expect(classifyTool({ name: 'list_all', annotations: { destructiveHint: true } })).toBe('action');
  });

  it('a tool nobody marked is a change, whatever its name says', () => {
    for (const name of ['search_threads', 'get_thread', 'list_events', 'create_draft', 'frobnicate']) {
      expect(classifyTool({ name }), name).toBe('action');
      expect(classifyTool({ name, annotations: {} }), name).toBe('action');
    }
  });

  it('the curated table beats the annotation: a named tool, then a read-only app', () => {
    expect(classifyTool({ name: 'export', annotations: { readOnlyHint: false } }, { toolAccess: { export: 'read' } })).toBe('read');
    expect(classifyTool({ name: 'sync', annotations: { readOnlyHint: true } }, { toolAccess: { sync: 'change' } })).toBe('action');
    expect(classifyTool({ name: 'anything', annotations: { destructiveHint: true } }, { readOnly: true })).toBe('read');
    // A named tool wins over the app-wide flag.
    expect(classifyTool({ name: 'sync' }, { readOnly: true, toolAccess: { sync: 'change' } })).toBe('action');
  });

  it('the Apps API calls an action a change', () => {
    expect(capabilityKind('read')).toBe('read');
    expect(capabilityKind('action')).toBe('change');
  });
});
