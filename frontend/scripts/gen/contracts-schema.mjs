/**
 * Language-independent half of the contract generators (swift-contracts.mjs, kotlin-contracts.mjs): loads the public
 * contracts (TypeScript sources, no build step), turns every exported `*Schema` into JSON Schema and normalises unions.
 */
import { registerHooks, stripTypeScriptTypes, createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const pkgDir = join(root, 'packages', 'client', 'node_modules', '@agent-desktop', 'public-contracts');
const SKIP = new Set(['listResultSchema']); // a generic function, not a schema

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.endsWith('.js') && ctx.parentURL?.endsWith('.ts')) {
      const ts = new URL(spec.replace(/\.js$/, '.ts'), ctx.parentURL);
      if (existsSync(fileURLToPath(ts))) return { url: ts.href, format: 'module', shortCircuit: true };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.endsWith('.ts')) return next(url, ctx);
    process.removeAllListeners('warning'); // stripTypeScriptTypes' "experimental" notice
    return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8')) };
  },
});

const entry = join(pkgDir, 'src', 'index.ts');
const contracts = await import(pathToFileURL(entry).href);
const { z } = createRequire(entry)('zod');

// ---- schema helpers ---------------------------------------------------------------------------------------------

export const canon = (s) => JSON.stringify(s, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v));
export const nonNull = (list) => list.filter((s) => s.type !== 'null');
export const alternatives = (s) => s.oneOf ?? s.anyOf;

/** The one schema a union stands for: objects merge into one, strings merge their values, anything else is JSONValue. */
export function collapse(list) {
  const uniq = [...new Map(nonNull(list).map((s) => [canon(s), s])).values()].map((s) => (alternatives(s) ? collapse(alternatives(s)) : s));
  if (uniq.length === 1) return uniq[0];
  const types = new Set(uniq.map(kind));
  if (types.size === 1 && types.has('object')) {
    const properties = {};
    for (const s of uniq) for (const [k, v] of Object.entries(s.properties ?? {})) (properties[k] ??= []).push(v);
    const required = ['id'].filter((k) => uniq.every((s) => s.required?.includes(k)));
    return { type: 'object', properties: Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, collapse(v)])), required };
  }
  if (types.size === 1 && types.has('string')) {
    const values = uniq.map(stringValues);
    if (values.every(Boolean)) return { type: 'string', enum: [...new Set(values.flat())] };
    return { type: 'string', format: uniq.every((s) => s.format === uniq[0].format) ? uniq[0].format : undefined };
  }
  if (types.size === 1 && types.has('array')) return { type: 'array', items: collapse(uniq.map((s) => s.items ?? {})) };
  if ([...types].every((t) => t === 'integer' || t === 'number')) return { type: 'number' };
  if (types.size === 1) return uniq[0];
  return {};
}

export function kind(s) {
  if (alternatives(s)) return kind(collapse(alternatives(s)));
  // A type list such as ["string","number","boolean"] (a scalar union) is not one type: it stays a flexible JSON value.
  const listed = Array.isArray(s.type) ? s.type.filter((x) => x !== 'null') : null;
  const t = listed === null ? s.type : listed.length === 1 ? listed[0] : listed.length > 1 && listed.every((x) => x === 'integer' || x === 'number') ? 'number' : undefined;
  return t ?? 'unknown';
}
export const stringValues = (s) => (s.enum ? s.enum : s.const !== undefined ? [s.const] : null);


export const pascal = (name) => name.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, __, c) => c.toUpperCase());
export const singular = (name) => (/ies$/.test(name) ? name.replace(/ies$/, 'y') : /[^s]s$/.test(name) ? name.slice(0, -1) : `${name}Item`);
export const typeName = (exportName) => pascal(exportName.replace(/Schema$/, ''));

export const exportsByName = Object.keys(contracts).filter((k) => k.endsWith('Schema') && !SKIP.has(k)).sort();
export const jsonSchemas = new Map(exportsByName.map((n) => {
  const { $schema, ...schema } = z.toJSONSchema(contracts[n], { unrepresentable: 'any' });
  return [n, schema];
}));
// Composite exports are reused by nested schemas that are identical; string enums are referenced by their values.
export const sharedTypes = new Map();
export const sharedEnums = new Map();
for (const [n, s] of jsonSchemas) {
  const key = canon(alternatives(s) ? collapse(alternatives(s)) : s);
  if (kind(s) === 'object' || kind(s) === 'array') { if (!sharedTypes.has(key)) sharedTypes.set(key, typeName(n)); }
  else if (kind(s) === 'string' && stringValues(s) && !sharedEnums.has(canon(stringValues(s)))) sharedEnums.set(canon(stringValues(s)), typeName(n));
}


/** The pinned contracts version and git tag, for the generated file's header. */
export function contractsSource() {
  const pin = JSON.parse(readFileSync(join(root, 'packages', 'client', 'package.json'), 'utf8')).dependencies['@agent-desktop/public-contracts'];
  const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  return { version, tag: pin.match(/#([^&]+)/)?.[1] ?? pin };
}
