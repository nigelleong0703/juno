#!/usr/bin/env node
/**
 * iOS layering (packages/ios/Juno): App / Core / State / DesignSystem / Features.
 *
 * Fails when
 *   1. a screen talks to the server itself: `world.api` / `api.get|post|patch|delete|list(` belong in Core/ and
 *      State/ only (screens call World methods and keep only their drafts; a screen's own fetch state is what
 *      reset the default-model choice on 2026-10-13);
 *   2. DesignSystem reads app state (`World`), so components stay reusable;
 *   3. raw styling outside DesignSystem grows: `.glassEffect(`, `.font(.system(size:`, `Color(` literals. Today's
 *      counts per file are the ceiling (`ios-structure-baseline.json`); lower them by moving the look into a
 *      DesignSystem component, then run with `--update` to lower the ceiling. A new file starts at zero.
 *   4. `bareSheet`: a `.sheet(` whose content view is defined in Features/ but does not build on `JunoSheet` (the one
 *      input-sheet scaffold, DesignSystem/JunoSheet.swift; see "Component catalog" in docs/design/VISUAL.md) and is
 *      not in SHEET_EXCEPTIONS. Same per-file ceiling as above.
 *   5. `hexColor`: hex colour literals (`0xRRGGBB`, `Color(red:`, `UIColor(red:`, `UIColor(hex:`) outside
 *      DesignSystem. Colours are Theme tokens; avatar tints live in DesignSystem/Avatar.swift. Same per-file ceiling.
 * Warning only (never fails): `Capsule()` / `.capsule` backgrounds in Features/ that bypass `WebButton`. The total
 * is printed, and files above their `capsuleBackground` ceiling are listed.
 * `--app-dir=<dir>` and `--baseline=<file>` point the check at another tree (the self-test in scripts/verify/fixtures).
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const appDir = argValue('app-dir') ?? join(root, 'packages', 'ios', 'Juno');
const baselinePath = argValue('baseline') ?? join(root, 'scripts', 'verify', 'ios-structure-baseline.json');
const LAYERS = ['App', 'Core', 'State', 'DesignSystem', 'Features'];
const RAW = {
  glassEffect: /\.glassEffect\(/g,
  systemFont: /\.font\(\.system\(size/g,
  colorLiteral: /\bColor\((?:red|white|hex|uiColor|\.)/g,
};
const HEX_LINE = /\b0x[0-9a-fA-F]{6,8}\b|\bU?I?Color\(red:|\bUIColor\(hex:/;
const CAPSULE_LINE = /\bCapsule\(\)|\bin:\s*\.capsule\b|\.clipShape\(\.capsule\)/;

// Sheets that are not input forms, so they stay outside JunoSheet. Key = the presented view, value = why.
const SHEET_EXCEPTIONS = {
  ImageViewer: 'full-bleed media viewer, not a form',
  ActivityView: 'the system share sheet',
  SourcesSheet: 'read-only list of citations (uses junoSheetPresentation)',
  CountryList: 'searchable picker list for a form field',
  AgentPickerSheet: 'agent picker list, not a form',
  ModelPickerList: 'searchable model picker list',
  TimeZoneList: 'searchable time-zone picker list',
  PDFPreview: 'PDF viewer',
  MorePage: 'the settings navigation root; its own pages are pushed inside it',
  MemorySheet: 'the memory list (its own layout)',
};
// Wrappers that never identify the content view.
const NOT_VIEWS = new Set(['NavigationStack', 'NavigationView', 'Group', 'VStack', 'HStack', 'ZStack', 'Text', 'Image', 'Color', 'EmptyView', 'List', 'Form', 'ScrollView', 'Button', 'Label', 'Spacer', 'ForEach', 'Section', 'Binding', 'URL']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.swift')) out.push(full);
  }
  return out;
}

const stripComments = (text) => text.split('\n').map((l) => l.replace(/(^|[^:"])\/\/.*$/, '$1')).join('\n');

/** Index of the bracket closing the one at `open` (naive: ignores brackets inside strings). */
function matching(text, open) {
  const pair = { '(': ')', '{': '}' }[text[open]];
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === text[open]) depth += 1;
    else if (text[i] === pair && (depth -= 1) === 0) return i;
  }
  return text.length - 1;
}

const problems = [];
const warnings = [];
const counts = {};
const sites = {};
const bump = (rel, key, n = 1) => { counts[rel] = { ...counts[rel], [key]: (counts[rel]?.[key] ?? 0) + n }; };

const files = walk(appDir).map((file) => ({ file, rel: relative(appDir, file), text: readFileSync(file, 'utf8') }));

// View definitions (top-level struct/class/enum bodies) for the sheet check.
const defs = new Map();
for (const { rel, text } of files) {
  if (rel.endsWith('Contracts.generated.swift')) continue;
  const code = stripComments(text);
  const heads = [...code.matchAll(/^(?:(?:private|fileprivate|final)\s+)*(?:struct|class|enum)\s+(\w+)/gm)];
  heads.forEach((m, i) => {
    const start = m.index;
    const end = heads[i + 1]?.index ?? code.length;
    if (!defs.has(m[1])) defs.set(m[1], { rel, body: code.slice(start, end) });
  });
}
const usesJunoSheet = (name, seen = new Set()) => {
  if (seen.has(name)) return false;
  seen.add(name);
  const def = defs.get(name);
  if (!def) return false;
  if (/\bJunoSheet\s*\(/.test(def.body)) return true;
  for (const m of def.body.matchAll(/\b([A-Z]\w*)\s*[({]/g)) {
    if (defs.get(m[1])?.rel.startsWith('Features/') && usesJunoSheet(m[1], seen)) return true;
  }
  return false;
};

for (const { rel, text } of files) {
  const layer = rel.split('/')[0];
  if (!LAYERS.includes(layer)) {
    problems.push(`${rel}: Swift files live under ${LAYERS.join('/, ')}/`);
    continue;
  }
  if (rel.endsWith('Contracts.generated.swift')) continue;
  const code = stripComments(text);
  if (layer !== 'Core' && layer !== 'State') {
    code.split('\n').forEach((line, i) => {
      if (/\bworld\.api\b(?!\s*[!=]=\s*nil)/.test(line) || /\bapi\.(get|post|patch|delete|list)\(/.test(line)) {
        bump(rel, 'serverCall');
        (sites.serverCall ??= []).push(`${rel}:${i + 1}`);
      }
    });
  }
  if (layer === 'DesignSystem' && /\bWorld\b/.test(code)) bump(rel, 'worldInDesignSystem');
  if (layer === 'DesignSystem') continue;
  for (const [key, re] of Object.entries(RAW)) {
    const n = (text.match(re) ?? []).length;
    if (n > 0) bump(rel, key, n);
  }
  const hex = code.split('\n').filter((l) => HEX_LINE.test(l)).length;
  if (hex > 0) bump(rel, 'hexColor', hex);
  if (layer === 'Features') {
    const capsules = code.split('\n').filter((l) => CAPSULE_LINE.test(l) && !/WebButton/.test(l)).length;
    if (capsules > 0) bump(rel, 'capsuleBackground', capsules);
  }
  // Sheets: the presented view must be a JunoSheet (directly or through the views it composes) or an exception.
  for (const m of code.matchAll(/\.sheet\(/g)) {
    const argsEnd = matching(code, m.index + m[0].length - 1);
    let next = argsEnd + 1;
    while (/\s/.test(code[next] ?? '')) next += 1;
    const content = code[next] === '{' ? code.slice(next, matching(code, next) + 1) : code.slice(m.index, argsEnd);
    const shown = [...content.matchAll(/\b([A-Z]\w*)\s*[({]/g)].map((x) => x[1]).filter((n) => !NOT_VIEWS.has(n) && defs.get(n)?.rel.startsWith('Features/'));
    if (shown.length === 0 || /\bJunoSheet\s*\(/.test(content)) continue;
    if (shown.some((n) => n in SHEET_EXCEPTIONS || usesJunoSheet(n))) continue;
    const line = code.slice(0, m.index).split('\n').length;
    bump(rel, 'bareSheet');
    (sites.bareSheet ??= []).push(`${rel}:${line} ${shown[0]}`);
  }
}
const sheetSites = sites.bareSheet ?? [];

if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, JSON.stringify(counts, null, 2) + '\n');
  console.log(`ios-structure baseline written (${Object.keys(counts).length} files)`);
  process.exit(problems.length > 0 ? 1 : 0);
}
if (process.argv.includes('--list-sheets')) console.log(sheetSites.join('\n'));

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
const HINT = {
  glassEffect: 'use a DesignSystem component (Theme tokens, WebButton, inputField, webGrouped) instead',
  systemFont: 'use a DesignSystem component (Theme tokens, WebButton, inputField, webGrouped) instead',
  colorLiteral: 'use a DesignSystem component (Theme tokens, WebButton, inputField, webGrouped) instead',
  bareSheet: 'build the sheet on JunoSheet (DesignSystem/JunoSheet.swift), or add a non-form view to SHEET_EXCEPTIONS with a reason',
  hexColor: 'use a Theme colour (add the token to DesignSystem/Theme.swift)',
  serverCall: 'server calls go through a World method (State/), not the screen',
  worldInDesignSystem: 'DesignSystem must not read World; pass values in',
};
for (const [rel, fileCounts] of Object.entries(counts)) {
  for (const [key, n] of Object.entries(fileCounts)) {
    const ceiling = baseline[rel]?.[key] ?? 0;
    if (key === 'capsuleBackground') {
      if (n > ceiling) warnings.push(`${rel}: capsuleBackground ${n} > ${ceiling}; use WebButton (Theme.swift) for button looks`);
    } else if (n > ceiling) {
      const where = (sites[key] ?? []).filter((s) => s.startsWith(rel + ':')).join(', ');
      problems.push(`${rel}: ${key} ${n} > ${ceiling}; ${HINT[key]}${where ? ` (${where})` : ''}`);
    }
  }
}
const total = (key) => Object.values(counts).reduce((sum, c) => sum + (c[key] ?? 0), 0);

if (warnings.length > 0) console.warn('ios-structure warnings:\n- ' + warnings.join('\n- '));
if (problems.length > 0) {
  console.error('ios-structure check failed:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log(`ios-structure check passed (${Object.keys(counts).length} files under their raw-styling ceiling; baseline: ${total('bareSheet')} sheets off JunoSheet, ${total('hexColor')} hex-colour lines, ${total('capsuleBackground')} capsule backgrounds (warning only))`);
