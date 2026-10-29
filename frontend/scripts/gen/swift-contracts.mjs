#!/usr/bin/env node
/**
 * Public wire contracts (zod, @agent-desktop/public-contracts) → Swift Codable types for the iOS app.
 *
 *   node scripts/gen/swift-contracts.mjs          write packages/ios/Juno/Core/Contracts.generated.swift
 *   node scripts/gen/swift-contracts.mjs --check  fail when the committed file differs from a fresh generation
 *
 * Every exported `*Schema` goes through `z.toJSONSchema`, then becomes a type under `enum Contract` named after the
 * export minus `Schema`. Lenient on purpose, like the hand-written models: every property is optional except a
 * required string `id`, string enums stay `String` (a nested `…Value` enum lists the allowed values; decoding one of those
 * enums on its own maps a value a newer server added to `.unknown` instead of throwing), and a union of
 * objects becomes one flat struct holding every variant's properties. A nested schema identical to an exported one
 * reuses that type. The contracts are TypeScript sources; Node strips the types on load (no build step, no network).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { root, canon, alternatives, collapse, kind, stringValues, pascal, singular, typeName, jsonSchemas, sharedTypes, sharedEnums, contractsSource } from './contracts-schema.mjs';

const outPath = join(root, 'packages', 'ios', 'Juno', 'Core', 'Contracts.generated.swift');

// ---- Swift naming -----------------------------------------------------------------------------------------------

const KEYWORDS = new Set(('associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private ' +
  'precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default defer do else ' +
  'fallthrough for guard if in repeat return throw switch where while Any as await false is nil self Self super throws true try').split(' '));
const RESERVED_TYPES = new Set(['Date', 'String', 'Int', 'Double', 'Bool', 'JSONValue', 'Type', 'Self', 'Protocol', 'Any', 'Contract', 'Value']);
const ident = (name) => (KEYWORDS.has(name) ? `\`${name}\`` : name);
function caseName(value) {
  // AG-UI's official enum values are SCREAMING_SNAKE_CASE. Split words before camel-casing so
  // TEXT_MESSAGE_START becomes `textMessageStart` rather than Swift's unusable `tEXTMESSAGESTART`.
  const words = String(value).split(/[^A-Za-z0-9]+/).flatMap((part) => part.match(/[A-Z]+(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|\d+|[A-Z]+/g) ?? []);
  let name = words.map((word, i) => {
    const lower = word.toLowerCase();
    return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join('');
  name = name.charAt(0).toLowerCase() + name.slice(1);
  if (!name || /^\d/.test(name)) name = `_${name}`;
  return ident(name);
}

/** A scope collects the nested declarations of one struct; names stay unique inside it. */
class Scope {
  constructor(ownName) { this.ownName = ownName; this.decls = []; this.names = new Map(); }
  claim(base, key) {
    let name = RESERVED_TYPES.has(base) || base === this.ownName ? `${base}Info` : base;
    for (let i = 2; this.names.has(name) && this.names.get(name) !== key; i++) name = `${base}${i}`;
    const fresh = !this.names.has(name);
    this.names.set(name, key);
    return { name, fresh };
  }
}

/** Swift type for a property schema; nested structs and value enums go into `scope`. */
function swiftType(schema, hint, scope, topKey) {
  const s = alternatives(schema) ? collapse(alternatives(schema)) : schema;
  const key = canon(s);
  if (key !== topKey && sharedTypes.has(key)) return `Contract.${sharedTypes.get(key)}`;
  switch (kind(s)) {
    case 'string':
      if (s.format === 'date-time') return 'Date';
      if (stringValues(s)?.length > 1) valueEnum(stringValues(s), `${pascal(hint)}Value`, scope);
      return 'String';
    case 'integer': return 'Int';
    case 'number': return 'Double';
    case 'boolean': return 'Bool';
    case 'array': return `[${swiftType(s.items ?? {}, singular(hint), scope)}]`;
    case 'object':
      if (!s.properties) return `[String: ${s.additionalProperties && typeof s.additionalProperties === 'object' ? swiftType(s.additionalProperties, `${hint}Value`, scope) : 'JSONValue'}]`;
      {
        const { name, fresh } = scope.claim(pascal(hint), key);
        if (fresh) scope.decls.push(struct(name, s));
        return name;
      }
    default: return 'JSONValue';
  }
}

function valueEnum(values, name, scope) {
  const shared = sharedEnums.get(canon(values));
  const { name: claimed, fresh } = scope.claim(name, `enum:${canon(values)}`);
  if (!fresh) return;
  if (shared && shared !== scope.ownName) scope.decls.push([`typealias ${claimed} = Contract.${shared}`]);
  else scope.decls.push(enumDecl(claimed, values));
}

function enumDecl(name, values) {
  const used = new Set();
  const cases = values.map((v) => {
    let c = caseName(v);
    for (let i = 2; used.has(c); i++) c = `${caseName(v)}${i}`;
    used.add(c);
    return `    case ${c} = ${JSON.stringify(String(v))}`;
  });
  // Tolerant decoding: a value added by a newer server decodes to `.unknown` (UI treats it neutrally) instead of
  // throwing and failing the whole response. The wire structs keep the raw string, so nothing is lost.
  const fallback = used.has('unknown') ? 'unknownValue' : 'unknown';
  return [
    `enum ${name}: String, CaseIterable, Codable, Sendable {`,
    ...cases,
    `    case ${fallback} = "__unknown__"`,
    '',
    '    init(from decoder: Decoder) throws {',
    `        self = Self(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .${fallback}`,
    '    }',
    '}',
  ];
}

function struct(name, s, topKey) {
  const scope = new Scope(name);
  const props = [];
  let identifiable = false;
  for (const [prop, schema] of Object.entries(s.properties ?? {})) {
    if (schema.not && Object.keys(schema).length === 1) continue; // `never`: the field must be absent
    const type = swiftType(schema, prop, scope, topKey);
    const isId = prop === 'id' && type === 'String' && s.required?.includes('id');
    identifiable ||= isId;
    props.push(`    var ${ident(prop)}: ${type}${isId ? '' : '?'}`);
  }
  const conformances = `Codable, Hashable, Sendable${identifiable ? ', Identifiable' : ''}`;
  const aliases = scope.decls.filter((d) => d.length === 1);
  const blocks = scope.decls.filter((d) => d.length > 1);
  const nested = [...(aliases.length ? [...aliases.flat(), ''] : []), ...blocks.flatMap((d) => [...d, ''])].map((l) => (l ? `    ${l}` : l));
  return [`struct ${name}: ${conformances} {`, ...nested, ...props, '}'];
}

function topLevel(exportName, schema) {
  const name = typeName(exportName);
  const s = alternatives(schema) ? collapse(alternatives(schema)) : schema;
  const key = canon(s);
  if (kind(s) === 'object' || kind(s) === 'array') {
    if (sharedTypes.get(key) !== name) return [`typealias ${name} = Contract.${sharedTypes.get(key)}`];
    if (kind(s) === 'object') return struct(name, s, key);
  }
  if (kind(s) === 'string' && stringValues(s)) {
    const shared = sharedEnums.get(canon(stringValues(s)));
    return shared === name ? enumDecl(name, stringValues(s)) : [`typealias ${name} = Contract.${shared}`];
  }
  const scope = new Scope(name);
  const type = swiftType(s, singular(name), scope, key);
  return [...scope.decls.flat(), `typealias ${name} = ${type}`];
}

const JSON_VALUE = `/// Any JSON value: fields the contract leaves open (\`unknown\`, free-form data).
enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}`;

function generate() {
  const { version, tag } = contractsSource();
  const body = [...jsonSchemas].flatMap(([n, s]) => ['', ...topLevel(n, s)]).map((l) => (l ? `    ${l}` : l));
  return [
    '// GENERATED by scripts/gen/swift-contracts.mjs — do not edit. Regenerate with `pnpm gen:swift`.',
    `// Source: @agent-desktop/public-contracts ${version} (${tag}).`,
    '// Lenient: every property is optional except a required string `id`; enums stay String (see the `…Value` enums, which decode an unknown value to `.unknown`).',
    '',
    'import Foundation',
    '',
    JSON_VALUE,
    '',
    'enum Contract {',
    ...body.slice(1),
    '}',
    '',
  ].join('\n');
}

const output = generate();
if (process.argv.includes('--check')) {
  if (!existsSync(outPath) || readFileSync(outPath, 'utf8') !== output) {
    console.error('Contracts.generated.swift is out of date with @agent-desktop/public-contracts: run pnpm gen:swift');
    process.exit(1);
  }
} else {
  writeFileSync(outPath, output);
  console.log(`wrote ${outPath.slice(root.length + 1)} (${output.split('\n').length} lines, ${jsonSchemas.size} schemas)`);
}
