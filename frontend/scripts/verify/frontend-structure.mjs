// Lead-owned focused boundaries: shell layout doesn't own new-agent features; dev tooling is explicit.
// Also a style ratchet (docs/design/VISUAL.md "Component catalog"): packages/app/src must not grow its own
//   rawDialog       a `<dialog>` element (use Dialog / AlertDialog / Sheet from @agent-desktop/ui),
//   bareBottomSheet a hand-made fixed bottom sheet (`fixed` + `bottom-0` + `rounded-t-*` in one class string: use Sheet),
//   hexColor        a hex colour literal in a string (use a theme token; avatar tints live in lib/avatars.ts),
// beyond today's per-file counts in `frontend-structure-baseline.json`. Lower a count by using the component, then
// run with `--update`. `--src=<dir>` / `--baseline=<file>` point the check at another tree (self-test fixtures).
import assert from 'node:assert/strict';
import ts from 'typescript';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = resolve(argValue('src') ?? 'packages/app/src');
const baselinePath = resolve(argValue('baseline') ?? 'scripts/verify/frontend-structure-baseline.json');
const failures = [];
const counts = {};
// Colour sources by design: the avatar tint palette and the character sprites.
const HEX_EXEMPT = [/^lib\/avatars\.ts$/, /^characters\//];
const HEX = /#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b|\[#[0-9a-fA-F]{3}\]|^#[0-9a-fA-F]{3}$/;
const bump = (rel, key) => { counts[rel] = { ...counts[rel], [key]: (counts[rel]?.[key] ?? 0) + 1 }; };
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { scan(path); continue; }
    if (!/\.tsx?$/.test(path) || path.includes('__tests__') || /\.(test|stories)\.tsx?$/.test(path)) continue;
    const rel = relative(root, path);
    const source = readFileSync(path, 'utf8');
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = node.moduleSpecifier.text;
        const destination = target.startsWith('.') ? resolve(dir, target) : target;
        if (path.startsWith(join(root, 'shell') + '/') && destination.startsWith(join(root, 'features') + '/')) failures.push(`${path}: shell imports feature ${target}`);
        if ((path.startsWith(join(root, 'features') + '/') || path.startsWith(join(root, 'components') + '/')) && /shell\/drag$/.test(destination)) failures.push(`${path}: content depends on shell drag helper`);
      }
      if (path === join(root, 'App.tsx') && (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))) failures.push('App.tsx uses unsafe assertion');
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText() === 'dialog') bump(rel, 'rawDialog');
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        const text = node.text;
        if (!HEX_EXEMPT.some((re) => re.test(rel)) && HEX.test(text)) bump(rel, 'hexColor');
        const tokens = new Set(text.split(/\s+/));
        if (tokens.has('fixed') && [...tokens].some((t) => /(^|:)bottom-0$/.test(t)) && [...tokens].some((t) => /(^|:)rounded-t(-|$)/.test(t))) bump(rel, 'bareBottomSheet');
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
}
scan(root);
if (!argValue('src')) {
  const app = readFileSync(join(root, 'App.tsx'), 'utf8');
  if (/ComputerPaneDevSlot|ComputerPaneDevPage|computerFeature/.test(app)) failures.push('shared production App mounts dev harness');
  if (/ComputerPaneDevPage/.test(readFileSync(join(root, 'components/computer/index.ts'), 'utf8'))) failures.push('production computer barrel exposes dev harness');
  if (existsSync(join(root, 'platform.ts'))) failures.push('duplicate platform shim remains');
  if (!existsSync(join(root, 'lib/drag.ts'))) failures.push('shared DOM drag helper is not in lib');
}
if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, JSON.stringify(counts, null, 2) + '\n');
  console.log(`frontend-structure baseline written (${Object.keys(counts).length} files)`);
  process.exit(failures.length > 0 ? 1 : 0);
}
const HINT = {
  rawDialog: 'use Dialog / AlertDialog / Sheet from @agent-desktop/ui',
  bareBottomSheet: 'use Sheet from @agent-desktop/ui, not a hand-made fixed bottom panel',
  hexColor: 'use a theme token (text-foreground, bg-muted, ...); see VISUAL.md Palette',
};
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
for (const [rel, fileCounts] of Object.entries(counts)) {
  for (const [key, n] of Object.entries(fileCounts)) {
    const ceiling = baseline[rel]?.[key] ?? 0;
    if (n > ceiling) failures.push(`${rel}: ${key} ${n} > ${ceiling}; ${HINT[key]}`);
  }
}
assert.equal(failures.length, 0, failures.join('\n'));
const total = (key) => Object.values(counts).reduce((sum, c) => sum + (c[key] ?? 0), 0);
console.log(`ok - focused frontend boundaries: shell/features, shared drag helper, explicit dev tooling, one platform module; style baseline: ${total('rawDialog')} raw dialogs, ${total('bareBottomSheet')} bare bottom sheets, ${total('hexColor')} hex colours`);
