/**
 * The boundary between what a model sends as tool arguments and what a tool receives, in one place so every tool gets it:
 *
 *  - `normalizeOptionalStrings`: for an OPTIONAL string field, "", whitespace and null mean "not provided" (a model with no value
 *    for a field fills in a placeholder; the field is left out). A required field is never touched. A tool that gives null a meaning
 *    ("clear this value") lists the field in `Tool.clearable`, and null then passes through.
 *  - `publicParameters`: the schema the model is shown declares each optional string as `["string","null"]`, so "no value" has a
 *    legal spelling and "" stops being the natural one.
 *  - `checkArguments`: a bounded JSON Schema check (required, type, enum, array size) that runs before a tool does.
 *  - `invalidArguments` / `argumentErrorText`: the one shape of a validation error the model reads: the field, what it sent, what
 *    is expected, and a corrected example.
 */
import type { z } from 'zod';
import type { Tool, ToolResult } from '../../contracts/index.js';

type Json = Record<string, unknown>;

export interface ArgumentIssue {
  /** Dotted field path (`meeting.channelId`, `names[0]`); empty for the arguments as a whole. */
  path: string;
  /** What arrived, by kind: never the value itself. */
  received: string;
  expected: string;
}

export interface Normalization {
  field: string;
  was: 'empty' | 'whitespace' | 'null';
}

const MAX_ISSUES = 5;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function typesOf(schema: Json): string[] {
  return Array.isArray(schema['type']) ? stringsOf(schema['type']) : typeof schema['type'] === 'string' ? [schema['type']] : [];
}

/** A string property: declared `string`, or an enum of strings (a model fills those with "" too). */
function isStringSpec(schema: Json): boolean {
  if (typesOf(schema).includes('string')) return true;
  const values = schema['enum'];
  return typesOf(schema).length === 0 && Array.isArray(values) && values.length > 0 && values.every((entry) => typeof entry === 'string');
}

function emptyKind(value: unknown): Normalization['was'] | undefined {
  if (value === null) return 'null';
  if (typeof value !== 'string') return undefined;
  if (value === '') return 'empty';
  return value.trim() === '' ? 'whitespace' : undefined;
}

// ---------------------------------------------------------------------------
// Optional strings: "" means absent
// ---------------------------------------------------------------------------

function walkObject(schema: Json, value: Json, path: string, clearable: readonly string[], found: Normalization[]): Json {
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const required = new Set(stringsOf(schema['required']));
  let out: Json | undefined;
  for (const [key, field] of Object.entries(value)) {
    const spec = properties[key];
    if (!isRecord(spec)) continue;
    const where = path === '' ? key : path + '.' + key;
    if (!required.has(key) && isStringSpec(spec)) {
      const was = emptyKind(field);
      if (was !== undefined && !(was === 'null' && path === '' && clearable.includes(key))) {
        found.push({ field: where, was });
        out ??= { ...value };
        delete out[key];
      }
      continue;
    }
    let next = field;
    if (isRecord(field)) next = walkObject(spec, field, where, clearable, found);
    else if (Array.isArray(field) && isRecord(spec['items'])) {
      const items = spec['items'];
      next = field.map((item, index) => (isRecord(item) ? walkObject(items, item, where + '[' + String(index) + ']', clearable, found) : item));
    }
    if (next !== field) {
      out ??= { ...value };
      out[key] = next;
    }
  }
  return out ?? value;
}

/** The arguments with every optional string that is "", blank or null left out, and what was left out (for the log). */
export function normalizeOptionalStrings(tool: Pick<Tool, 'parameters' | 'clearable'>, args: Json): { args: Json; normalized: Normalization[] } {
  const normalized: Normalization[] = [];
  const next = walkObject(tool.parameters, args, '', tool.clearable ?? [], normalized);
  return { args: next, normalized };
}

function widen(schema: Json): Json {
  if (isRecord(schema['properties'])) return publicParameters(schema);
  if (isRecord(schema['items']) && isRecord(schema['items']['properties'])) return { ...schema, items: publicParameters(schema['items']) };
  return schema;
}

/** The schema shown to the model: every optional string property also accepts null ("no value"). Enums and required fields stay as they are. */
export function publicParameters(schema: Json): Json {
  const properties = schema['properties'];
  if (!isRecord(properties)) return schema;
  const required = new Set(stringsOf(schema['required']));
  const next: Json = {};
  for (const [key, spec] of Object.entries(properties)) {
    if (!isRecord(spec)) {
      next[key] = spec;
      continue;
    }
    const types = typesOf(spec);
    next[key] = !required.has(key) && types.includes('string') && !types.includes('null') && spec['enum'] === undefined && spec['const'] === undefined
      ? { ...spec, type: [...types, 'null'] }
      : widen(spec);
  }
  return { ...schema, properties: next };
}

// ---------------------------------------------------------------------------
// Checking: what the model sent, in words
// ---------------------------------------------------------------------------

export function describeReceived(value: unknown): string {
  if (value === undefined) return 'nothing (the field is missing)';
  if (value === null) return 'null';
  if (typeof value === 'string') return value === '' ? 'an empty string' : value.trim() === '' ? 'a blank string' : 'a string of ' + String(value.length) + ' characters';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'a boolean';
  if (Array.isArray(value)) return 'an array of ' + String(value.length) + (value.length === 1 ? ' item' : ' items');
  return 'an object';
}

function matchesType(type: string, value: unknown): boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isRecord(value);
  if (type === 'null') return value === null;
  return true;
}

function article(noun: string): string {
  return (/^[aeiou]/.test(noun) ? 'an ' : 'a ') + noun;
}

function visit(schema: Json, value: unknown, path: string, issues: ArgumentIssue[]): void {
  if (issues.length >= MAX_ISSUES) return;
  // Combinators and references are not checked here: the tool's own validation owns them.
  if (['anyOf', 'oneOf', 'allOf', 'not', '$ref'].some((keyword) => schema[keyword] !== undefined)) return;
  const types = typesOf(schema);
  if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
    issues.push({ path, received: describeReceived(value), expected: types.filter((type) => type !== 'null').map(article).join(' or ') + (types.includes('null') ? ' (or null)' : '') });
    return;
  }
  const choices = schema['enum'];
  if (Array.isArray(choices) && !choices.some((choice) => choice === value)) {
    issues.push({ path, received: describeReceived(value), expected: 'one of ' + choices.map((choice) => JSON.stringify(choice)).join(', ') });
    return;
  }
  if (isRecord(value)) {
    const properties = isRecord(schema['properties']) ? schema['properties'] : {};
    for (const key of stringsOf(schema['required'])) {
      if (value[key] === undefined) {
        const spec = properties[key];
        const kind = isRecord(spec) ? typesOf(spec).filter((type) => type !== 'null').map(article).join(' or ') : '';
        issues.push({ path: path === '' ? key : path + '.' + key, received: describeReceived(undefined), expected: 'a required ' + (kind === '' ? 'value' : kind.replace(/^an? /, '')) });
      }
    }
    for (const [key, spec] of Object.entries(properties)) {
      if (value[key] !== undefined && isRecord(spec)) visit(spec, value[key], path === '' ? key : path + '.' + key, issues);
    }
    return;
  }
  if (Array.isArray(value)) {
    const min = schema['minItems'];
    const max = schema['maxItems'];
    if (typeof min === 'number' && value.length < min) issues.push({ path, received: describeReceived(value), expected: 'at least ' + String(min) + (min === 1 ? ' item' : ' items') });
    else if (typeof max === 'number' && value.length > max) issues.push({ path, received: describeReceived(value), expected: 'at most ' + String(max) + (max === 1 ? ' item' : ' items') });
    const items = schema['items'];
    if (isRecord(items)) value.forEach((item, index) => visit(items, item, path + '[' + String(index) + ']', issues));
  }
}

/** What is wrong with these arguments against the tool's JSON Schema; empty when nothing is. */
export function checkArguments(tool: Pick<Tool, 'parameters'>, args: unknown): ArgumentIssue[] {
  const issues: ArgumentIssue[] = [];
  visit(tool.parameters, args ?? {}, '', issues);
  return issues;
}

// ---------------------------------------------------------------------------
// The error the model reads
// ---------------------------------------------------------------------------

function sample(spec: unknown, name: string): unknown {
  if (!isRecord(spec)) return '<' + name + '>';
  if (spec['default'] !== undefined) return spec['default'];
  if (Array.isArray(spec['examples']) && spec['examples'].length > 0) return spec['examples'][0];
  if (spec['const'] !== undefined) return spec['const'];
  if (Array.isArray(spec['enum']) && spec['enum'].length > 0) return spec['enum'][0];
  const types = typesOf(spec).filter((type) => type !== 'null');
  const type = types[0];
  if (type === 'string' || type === undefined) return '<' + name + '>';
  if (type === 'number' || type === 'integer') return typeof spec['minimum'] === 'number' ? spec['minimum'] : 1;
  if (type === 'boolean') return true;
  if (type === 'array') return isRecord(spec['items']) ? [sample(spec['items'], name)] : [];
  return exampleObject(spec, []);
}

function exampleObject(schema: Json, extra: readonly string[]): Json {
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const out: Json = {};
  for (const key of [...stringsOf(schema['required']), ...extra]) {
    if (key in properties && !(key in out)) out[key] = sample(properties[key], key);
  }
  return out;
}

/** The text of a validation error: tool, then one line per field (received / expected), then a corrected example. */
export function argumentErrorText(tool: Pick<Tool, 'name' | 'parameters'>, issues: readonly ArgumentIssue[]): string {
  const lines = ['Error: invalid ' + tool.name + ' arguments.'];
  for (const issue of issues.slice(0, MAX_ISSUES)) lines.push('- ' + (issue.path === '' ? 'arguments' : issue.path) + ': received ' + issue.received + '; expected ' + issue.expected + '.');
  const fields = issues.map((issue) => issue.path.split(/[.[]/)[0] ?? '').filter((name) => name !== '');
  const example = exampleObject(tool.parameters, fields);
  if (Object.keys(example).length > 0) lines.push('Corrected example: ' + JSON.stringify(example));
  const properties = isRecord(tool.parameters['properties']) ? Object.keys(tool.parameters['properties']) : [];
  if (properties.length > stringsOf(tool.parameters['required']).length) lines.push('Leave out an optional field that has no value (or send null); never send "" for it.');
  return lines.join('\n');
}

/** A validation error result. The issues ride in `details` so the harness can add the corrected example once it knows the tool's schema. */
export function invalidArgumentsResult(tool: Pick<Tool, 'name' | 'parameters'>, issues: readonly ArgumentIssue[]): ToolResult {
  return { content: [{ type: 'text', text: argumentErrorText(tool, issues) }], isError: true, details: { errorKind: 'validation', argumentIssues: issues.slice(0, MAX_ISSUES) } };
}

function isIssueList(value: unknown): value is ArgumentIssue[] {
  return Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry['path'] === 'string' && typeof entry['received'] === 'string' && typeof entry['expected'] === 'string');
}

/** A tool's own validation error with the corrected example added from the tool's schema; any other result as it is. */
export function withTeachingExample(tool: Pick<Tool, 'name' | 'parameters'>, result: ToolResult): ToolResult {
  const issues = result.details?.['argumentIssues'];
  return result.isError === true && isIssueList(issues) ? invalidArgumentsResult(tool, issues) : result;
}

function valueAt(args: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let current: unknown = args;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === 'number') current = current[key];
    else if (isRecord(current) && typeof key === 'string') current = current[key];
    else return undefined;
  }
  return current;
}

function pathText(path: ReadonlyArray<PropertyKey>): string {
  return path.map((key, index) => (typeof key === 'number' ? '[' + String(key) + ']' : (index === 0 ? '' : '.') + String(key))).join('');
}

/** A zod issue in the words of `ArgumentIssue`. */
function fromZod(issue: z.core.$ZodIssue, args: unknown): ArgumentIssue {
  const path = pathText(issue.path);
  const received = describeReceived(valueAt(args, issue.path));
  switch (issue.code) {
    case 'invalid_type':
      return { path, received, expected: issue.expected === 'nonoptional' ? 'a value' : article(String(issue.expected)) };
    case 'too_small': {
      const min = Number(issue.minimum);
      if (issue.origin === 'string') return { path, received, expected: min <= 1 ? 'a non-empty string' : 'a string of at least ' + String(min) + ' characters' };
      if (issue.origin === 'array') return { path, received, expected: 'at least ' + String(min) + (min === 1 ? ' item' : ' items') };
      return { path, received, expected: 'a number of at least ' + String(min) };
    }
    case 'too_big': {
      const max = Number(issue.maximum);
      if (issue.origin === 'string') return { path, received, expected: 'a string of at most ' + String(max) + ' characters' };
      if (issue.origin === 'array') return { path, received, expected: 'at most ' + String(max) + (max === 1 ? ' item' : ' items') };
      return { path, received, expected: 'a number of at most ' + String(max) };
    }
    case 'invalid_value':
      return { path, received, expected: 'one of ' + issue.values.map((value) => JSON.stringify(value)).join(', ') };
    case 'unrecognized_keys':
      return { path, received: 'unknown field' + (issue.keys.length === 1 ? ' ' : 's ') + issue.keys.join(', '), expected: 'only the fields listed in the tool schema' };
    default:
      return { path, received, expected: issue.message };
  }
}

/** Zod's own wording ("Too big: expected string to have <=240 characters") says nothing the structured line does not; a message a tool wrote does. */
const ZOD_DEFAULT_MESSAGE = /^(Too (big|small): |Invalid (input|option|string|number|key)|Unrecognized key)/;

export function zodArgumentIssues(args: unknown, error: z.ZodError): ArgumentIssue[] {
  return error.issues.map((issue) => {
    const described = fromZod(issue, args);
    return issue.code === 'custom' || ZOD_DEFAULT_MESSAGE.test(issue.message) ? described : { ...described, expected: described.expected + ' (' + issue.message + ')' };
  });
}

/**
 * What a tool returns when its own zod parse of the arguments fails: the teaching error (field, what was received, what is expected).
 * The harness adds the corrected example from the tool's schema (`withTeachingExample`).
 */
export function invalidArguments(toolName: string, args: unknown, error: z.ZodError): ToolResult {
  return invalidArgumentsResult({ name: toolName, parameters: {} }, zodArgumentIssues(args, error));
}
