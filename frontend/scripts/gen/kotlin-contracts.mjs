#!/usr/bin/env node
/**
 * Public wire contracts (zod, @agent-desktop/public-contracts) → Kotlin `@Serializable` classes for the Android app.
 *
 *   node scripts/gen/kotlin-contracts.mjs          write packages/android/app/src/main/kotlin/io/github/nigelleong0703/juno/contract/Contracts.generated.kt
 *   node scripts/gen/kotlin-contracts.mjs --check  fail when the committed file differs from a fresh generation
 *
 * Same rules as the Swift generator (see swift-contracts.mjs): every property is nullable with a default except a
 * required string `id`, string enums stay `String` (a nested `…Value` object lists the allowed values), a union of
 * objects becomes one flat class. Dates stay ISO-8601 strings; free-form data is a `JsonElement`. Kotlin allows
 * typealiases only at top level, so nested shared types are referenced by their top-level name.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { root, canon, alternatives, collapse, kind, stringValues, pascal, singular, typeName, jsonSchemas, sharedTypes, sharedEnums, contractsSource } from './contracts-schema.mjs';

const outPath = join(root, 'packages', 'android', 'app', 'src', 'main', 'kotlin', 'io', 'github', 'nigelleong0703', 'juno', 'contract', 'Contracts.generated.kt');

const KEYWORDS = new Set('as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while'.split(' '));
const RESERVED_TYPES = new Set(['String', 'Int', 'Double', 'Boolean', 'JsonElement', 'Any', 'Unit', 'List', 'Map', 'Value']);
const ident = (name) => (KEYWORDS.has(name) ? `\`${name}\`` : name);
const isIdent = (name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
/** A Kotlin property for a JSON key; keys that are not identifiers are camel-cased and carry their wire name. */
function property(key) {
  if (isIdent(key)) return { name: ident(key), wire: null };
  const name = key.replace(/[^A-Za-z0-9]+([A-Za-z0-9])/g, (_, c) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '');
  return { name: ident(/^\d/.test(name) || !name ? `_${name}` : name), wire: key };
}
const constName = (value) => {
  // The official AG-UI enum is SCREAMING_SNAKE_CASE; keep its generated Kotlin constants idiomatic
  // (`textMessageStart`, `runFinished`) while preserving the wire value in the string literal.
  const words = String(value).split(/[^A-Za-z0-9]+/).flatMap((part) => part.match(/[A-Z]+(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|\d+|[A-Z]+/g) ?? []);
  const name = words.map((word, i) => {
    const lower = word.toLowerCase();
    return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join('');
  return ident(!name || /^\d/.test(name) ? `_${name}` : name);
};

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

/** Kotlin type for a property schema; nested classes and value objects go into `scope`. */
function kotlinType(schema, hint, scope, topKey) {
  const s = alternatives(schema) ? collapse(alternatives(schema)) : schema;
  const key = canon(s);
  if (key !== topKey && sharedTypes.has(key)) return sharedTypes.get(key);
  switch (kind(s)) {
    case 'string':
      if (stringValues(s)?.length > 1) valueObject(stringValues(s), `${pascal(hint)}Value`, scope);
      return 'String';
    case 'integer': return 'Long';
    case 'number': return 'Double';
    case 'boolean': return 'Boolean';
    case 'array': return `List<${kotlinType(s.items ?? {}, singular(hint), scope)}>`;
    case 'object':
      if (!s.properties) return `Map<String, ${s.additionalProperties && typeof s.additionalProperties === 'object' ? kotlinType(s.additionalProperties, `${hint}Value`, scope) : 'JsonElement'}>`;
      {
        const { name, fresh } = scope.claim(pascal(hint), key);
        if (fresh) scope.decls.push(dataClass(name, s));
        return name;
      }
    default: return 'JsonElement';
  }
}

function valueObject(values, name, scope) {
  const { name: claimed, fresh } = scope.claim(name, `enum:${canon(values)}`);
  if (fresh) scope.decls.push(valuesDecl(claimed, values));
}

function valuesDecl(name, values) {
  const used = new Set();
  const consts = values.map((v) => {
    let c = constName(v);
    for (let i = 2; used.has(c); i++) c = `${constName(v)}${i}`;
    used.add(c);
    return `    const val ${c} = ${JSON.stringify(String(v))}`;
  });
  return [`object ${name} {`, ...consts, '}'];
}

function dataClass(name, s, topKey) {
  const scope = new Scope(name);
  const props = [];
  for (const [prop, schema] of Object.entries(s.properties ?? {})) {
    if (schema.not && Object.keys(schema).length === 1) continue; // `never`: the field must be absent
    const type = kotlinType(schema, prop, scope, topKey);
    const { name: field, wire } = property(prop);
    const isId = prop === 'id' && type === 'String' && s.required?.includes('id');
    props.push(`    ${wire ? `@SerialName(${JSON.stringify(wire)}) ` : ''}val ${field}: ${type}${isId ? '' : '? = null'},`);
  }
  const nested = scope.decls.flatMap((d) => ['', ...d]).map((l) => (l ? `    ${l}` : l));
  const body = nested.length ? [`) {`, ...nested, '}'] : [')'];
  if (!props.length) return ['@Serializable', `class ${name}${nested.length ? ' {' : ''}`, ...(nested.length ? [...nested, '}'] : [])];
  return ['@Serializable', `data class ${name}(`, ...props, ...body];
}

function topLevel(exportName, schema) {
  const name = typeName(exportName);
  const s = alternatives(schema) ? collapse(alternatives(schema)) : schema;
  const key = canon(s);
  if (kind(s) === 'object' || kind(s) === 'array') {
    if (sharedTypes.get(key) !== name) return [`typealias ${name} = ${sharedTypes.get(key)}`];
    if (kind(s) === 'object') return dataClass(name, s, key);
  }
  if (kind(s) === 'string' && stringValues(s)) {
    const shared = sharedEnums.get(canon(stringValues(s)));
    return shared === name ? valuesDecl(`${name}Values`, stringValues(s)) : [`typealias ${name} = String`];
  }
  const scope = new Scope(name);
  const type = kotlinType(s, singular(name), scope, key);
  return [...scope.decls.flat(), `typealias ${name} = ${type}`];
}

function generate() {
  const { version, tag } = contractsSource();
  const body = [...jsonSchemas].flatMap(([n, s]) => ['', ...topLevel(n, s)]);
  return [
    '// GENERATED by scripts/gen/kotlin-contracts.mjs — do not edit. Regenerate with `pnpm gen:kotlin`.',
    `// Source: @agent-desktop/public-contracts ${version} (${tag}).`,
    '// Lenient: every property is nullable except a required string `id`; enums stay String (see the `…Value` objects).',
    '@file:Suppress("unused", "ClassName", "ConstPropertyName")',
    '',
    'package io.github.nigelleong0703.juno.contract',
    '',
    'import kotlinx.serialization.SerialName',
    'import kotlinx.serialization.Serializable',
    'import kotlinx.serialization.json.JsonElement',
    ...body,
    '',
  ].join('\n');
}

const output = generate();
if (process.argv.includes('--check')) {
  if (!existsSync(outPath) || readFileSync(outPath, 'utf8') !== output) {
    console.error('Contracts.generated.kt is out of date with @agent-desktop/public-contracts: run pnpm gen:kotlin');
    process.exit(1);
  }
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, output);
  console.log(`wrote ${outPath.slice(root.length + 1)} (${output.split('\n').length} lines, ${jsonSchemas.size} schemas)`);
}
