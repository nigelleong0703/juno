// Extracted verbatim from Ying-Kai-Liao/jev-browser commit74592ba. See LICENSE and manifest.json.
import { FIELDISH, SELECTISH, FILEISH, brief, pickCloser, pageDiff, redactPage, redactValues, SECRET_KEY, REDACTED } from './page-model.mjs';
import { normalizeBlocks, batchBlocks, batchQuestions, pickBlocks, readResult, totalChars, MIN_PRUNE_CHARS, BUDGET_CHARS, DROP_BELOW, MAX_JEV_CALLS } from './prune.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const TOOLS = {
  click: "Click the target (link, button, checkbox, radio, tab, menu item)",
  type: "Type one of the given `values` into the target text field, replacing its content",
  press_enter: "Press Enter in the target field (e.g. to submit a search or add an item)",
  press_key: "Press a keyboard key other than Enter (Escape, Tab, arrow keys, Space, Backspace…)",
  select: "Choose an option in the target <select> dropdown",
  hover: "Move the mouse over the target to reveal hidden content",
  right_click: "Right-click the target to open a context menu",
  drag: "Drag the target and drop it onto another element",
  upload: "Attach one of the given `values` (a file path) to the target file input",
  scroll: "Scroll down to load or reveal more content",
  wait: "Wait: the page is still loading or processing (spinner, 'loading…', busy/disabled button)",
  none: "No action: the goal is already achieved, or nothing on this page can make progress",
};
export const KEYS = ["Escape", "Tab", "Space", "Backspace", "Delete", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End"];
const TARGETED = new Set(["click", "type", "press_enter", "select", "hover", "right_click", "drag", "upload"]);
const GUARDED = new Set(["click", "press_enter", "press_key"]);
const guarded = act => GUARDED.has(act.tool) || (act.tool === "webmcp" && !act.readOnly);
const ARG_SKIP = "(leave out)";
const MAX_INLINE_ARGS = 24;
const actLabel = act => act.tool === "webmcp" ? `tool ${act.webmcp}` : brief(act.el);
const MAX_SINGLE = 240;
const MAX_STATE_CHARS = 70_000;
const GROUP = 30;
export function actionError(e) {
  const msg = String(e?.message ?? e);
  const m = msg.match(/<([a-z0-9-]+)[^>]*>.*?(?:from <[^>]*>)?\s*subtree intercepts pointer events/i) || msg.match(/intercepts pointer events/i);
  if (m) return "click blocked: another element (a modal, overlay or banner) covers the target";
  if (/not visible|element is not attached/i.test(msg)) return "target is not visible or no longer on the page";
  if (/disabled|not enabled/i.test(msg)) return "target is disabled";
  return msg.split("\n")[0].slice(0, 160);
}
export function repeatsBlock(seq, k, times) {
  if (seq.length < k * times) return false;
  const tail = seq.slice(-k * times), block = tail.slice(0, k).join("\n");
  if (k > 1 && new Set(tail.slice(0, k)).size === 1) return false;   // identical single actions are counted by k = 1
  for (let n = 1; n < times; n++) if (tail.slice(n * k, (n + 1) * k).join("\n") !== block) return false;
  return true;
}
export class UpstreamGoalSession {
redact(state) {
    if (state.page) state = { ...state, page: redactPage(state.page) };
    if (!this.secrets?.size) return state;
    let json = JSON.stringify(state);
    for (const v of this.secrets) json = json.split(JSON.stringify(v).slice(1, -1)).join(REDACTED);
    return JSON.parse(json);
  }
async check(question) {
    await this.settle();
    const page = await this.snapshot();
    const { answers } = await this.call({ page }, { q: { type: "noul", instructions: `Answer about \`page\`: ${question}` } });
    return answers.q.noul;
  }
async choose(question, options) {
    await this.settle();
    const page = await this.snapshot();
    const criteria = Array.isArray(options) ? Object.fromEntries(options.map(o => [o, null])) : options;
    const { answers } = await this.call({ page }, { q: { type: "choice", instructions: `Answer about \`page\`: ${question}`, criteria } });
    return { choice: answers.q.choice, probabilities: answers.q.probabilities, confidence: answers.q.confidence };
  }
async read(question, { budgetChars = BUDGET_CHARS, minChars = MIN_PRUNE_CHARS, dropBelow = DROP_BELOW, maxBlock, maxChars } = {}) {
    await this.settle();
    const { url, title, blocks: raw, truncated } = await this.extractBlocks({ maxBlock, maxChars });
    const blocks = normalizeBlocks(raw, maxBlock ? { maxBlock } : {});
    const size = totalChars(blocks);
    const base = { url, title, question, blocks, truncated };

    // Ranking pays off only above both the floor and the caller's own budget: under either the
    // page is already about the size a pruned one would be, and a Jev call costs 700 ms-1.5 s.
    // Skipping the ranking does not skip the budget.
    const gate = Math.max(minChars, budgetChars);
    if (size <= gate) {
      const { kept, dropped } = pickBlocks(blocks, {}, { dropBelow, budgetChars });
      return readResult({ ...base, kept, dropped, pruned: false, reason: `page text is ${size} chars, at or below the ${gate}-char threshold for ranking: no Jev call` });
    }

    const scores = {};
    let calls = 0, ms = 0;
    const batches = batchBlocks(blocks);
    for (const batch of batches.slice(0, MAX_JEV_CALLS)) {
      const state = { question, page: { url, title, blocks: batch.map(b => ({ i: b.i, ...(b.section ? { section: b.section } : {}), text: b.text })) } };
      try {
        const r = await this.call(state, batchQuestions(batch));
        calls++; ms += r.ms;
        for (const b of batch) { const a = r.answers[`b${b.i}`]; if (a?.noul !== undefined) scores[b.i] = a.noul; }
      } catch (e) {
        // bias to keep: an unanswered batch leaves its blocks unscored, and unscored blocks stay
        this.events.push(`browser_read: a ranking request failed (${String(e?.message ?? e).slice(0, 80)}); its blocks were kept unranked`);
      }
    }
    const { kept, dropped } = pickBlocks(blocks, scores, { dropBelow, budgetChars });
    const unranked = blocks.length - Object.keys(scores).length;
    const capped = batches.length > MAX_JEV_CALLS ? ` (the page needs ${batches.length} ranking requests; only the first ${MAX_JEV_CALLS} were made)` : "";
    return readResult({
      ...base, kept, dropped, pruned: true, jevCalls: calls, jevMs: ms,
      reason: unranked ? `${unranked} of ${blocks.length} blocks could not be ranked and were kept unless over budget${capped}` : undefined,
    });
  }
async decide(page, goal, values, history, lastChange, webmcp = []) {
    values = redactValues(values);   // what Jev sees; resolve() types the real value
    if (webmcp.length) page = { ...page, webmcp_tools: webmcp.map(t => ({ name: t.name, description: t.description.slice(0, 300), arguments: Object.keys(t.inputSchema?.properties ?? {}) })) };
    const task = { goal, ...(Object.keys(values).length ? { values } : {}), history, ...(lastChange ? { last_change: lastChange } : {}) };
    const withValues = Object.keys(values).length ? ", with the given `task.values`" : "";
    const common = {
      done: { type: "noul", instructions: `Does \`page\` show that \`task.goal\` has been achieved${withValues}? Judge from \`page.text\` and \`page.elements\`.` },
      done_change: { type: "noul", instructions: `Does \`page\` show that \`task.goal\` has been achieved${withValues}? Judge from \`page.text\`, \`page.elements\` and \`task.last_change\` (what the last action changed).` },
      blocked: { type: "noul", instructions: "Is there something on `page` that stops progress on `task.goal` and cannot be handled by clicking or typing (captcha, access denied, error page)?" },
      error: { type: "noul", instructions: "Does `page` show an error or rejection message (e.g. invalid credentials, a validation error, not found) caused by the actions in `task.history`?" },
      login: { type: "noul", instructions: "Is `page` a sign-in or sign-up screen, or asking the user to log in, before `task.goal` can continue?" },
      irreversible: { type: "noul", instructions: "Would the next action toward `task.goal` on `page` have an effect outside this browser that is hard to undo, such as placing an order, paying, sending a message, deleting data or publishing?" },
      tool: { type: "choice", instructions: "What is the next action toward `task.goal` on `page`, given what `task.history` already did?", criteria: webmcp.length ? { ...TOOLS, webmcp: WEBMCP_ACTION } : TOOLS },
    };
    let argKeys;
    if (webmcp.length) {
      common.use_tool = { type: "noul", instructions: "Can one of `page.webmcp_tools` (the page's own tools for agents) do the next step toward `task.goal`, given what `task.history` already did? A tool call replaces typing into fields and pressing buttons for that step." };
      common.webmcp_tool = { type: "choice", instructions: "If the next action toward `task.goal` calls one of `page.webmcp_tools`, which one?", criteria: Object.fromEntries(webmcp.map(t => [t.name, t.description.slice(0, 200) || null])) };
      const per = webmcp.map((t, i) => this.argQuestions(t, values, `t${i}a`));
      if (per.reduce((n, p) => n + p.keys.length, 0) <= MAX_INLINE_ARGS) {
        argKeys = Object.fromEntries(webmcp.map((t, i) => [t.name, per[i].keys]));
        for (const p of per) Object.assign(common, p.qs);
      }
    }
    if (Object.keys(values).length) common.value = { type: "choice", instructions: "If the next action toward `task.goal` types, selects or uploads something, which of `task.values` should it use? Prefer values not yet entered on `page`.", criteria: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v).slice(0, 200)])) };
    const targetQ = { type: "choice", instructions: "Which entry of `page.elements` (by its `i`) should the next action toward `task.goal` act on?" };

    if (page.elements.length <= MAX_SINGLE && JSON.stringify(page).length <= MAX_STATE_CHARS) {
      targetQ.criteria = Object.fromEntries(page.elements.map(e => [String(e.i), null]));
      const r = await this.call({ page, task }, { ...common, ...(page.elements.length ? { target: targetQ } : {}) });
      return { ...r.answers, stages: 1, argKeys };
    }
    // Two stages: groups of consecutive elements, then elements in the likeliest groups.
    const groups = [];
    for (let k = 0; k < page.elements.length; k += GROUP) {
      const els = page.elements.slice(k, k + GROUP);
      groups.push({ g: groups.length, summary: els.map(e => (e.label || e.text || e.placeholder || e.href || e.tag).slice(0, 24)).join(" | ").slice(0, 700) });
    }
    const lite = { url: page.url, title: page.title, text: page.text, metrics: page.metrics, dialogs: page.dialogs, groups, ...(page.webmcp_tools ? { webmcp_tools: page.webmcp_tools } : {}) };
    const r1 = await this.call({ page: lite, task }, {
      ...common,
      group: { type: "choice", instructions: "Which entry of `page.groups` (by its `g`) contains the element the next action toward `task.goal` should act on? Each group summarises consecutive page elements.", criteria: Object.fromEntries(groups.map(g => [String(g.g), null])) },
    });
    const ranked = Object.entries(r1.answers.group.probabilities).sort((a, b) => b[1] - a[1]);
    const pick = []; let mass = 0;
    for (const [g, p] of ranked) { if (pick.length && (mass >= 0.9 || pick.length >= 4)) break; pick.push(+g); mass += p; }
    const sub = page.elements.filter(e => pick.includes(Math.floor(e.i / GROUP))).slice(0, MAX_SINGLE);
    const r2 = await this.call({ page: { url: page.url, title: page.title, text: page.text.slice(0, 1200), elements: sub }, task }, {
      target: { ...targetQ, criteria: Object.fromEntries(sub.map(e => [String(e.i), null])) },
    });
    return { ...r1.answers, target: r2.answers.target, stages: 2, groups_considered: pick, argKeys };
  }
resolve(page, a, values, webmcp = []) {
    let tool = a.tool.choice;
    // Prefer the page's own tool whenever Jev says one fits the next step, unless nothing is left to do
    if (a.use_tool?.noul >= 0.5 && !["none", "wait"].includes(tool)) tool = "webmcp";
    if (tool === "webmcp") {
      const t = webmcp.find(t => t.name === a.webmcp_tool?.choice);
      if (t) {
        const act = { tool, p_tool: Math.max(a.tool.probabilities.webmcp ?? 0, a.use_tool?.noul ?? 0), webmcp: t.name, schema: t.inputSchema, readOnly: !!t.annotations?.readOnlyHint, target: null, p_target: a.webmcp_tool.probabilities[t.name], candidates: [] };
        if (a.argKeys) act.args = this.argsFrom(a, a.argKeys[t.name], values, act);
        return act;
      }
      tool = "none";   // no tool picked: treated as no action, so the loop reports stuck rather than guessing
    }
    const byI = new Map(page.elements.map(e => [String(e.i), e]));
    const ranked = a.target ? Object.entries(a.target.probabilities).sort((x, y) => y[1] - x[1]) : [];
    const fits = { type: FIELDISH, press_enter: e => FIELDISH(e) || e.tag.startsWith("input"), select: SELECTISH, upload: FILEISH };
    let [ti, tp] = ranked[0] ?? [null, 0];
    if (fits[tool] && ti != null && !fits[tool](byI.get(ti))) {
      const alt = ranked.find(([i]) => fits[tool](byI.get(i)));
      if (alt && (alt[1] >= 0.1 || tool === "upload")) [ti, tp] = alt;
      else if (tool === "upload") { const f = page.elements.find(FILEISH); if (f) [ti, tp] = [String(f.i), 0.5]; }
      else if (tool === "type" || tool === "select") tool = "click";
    }
    if (tool === "type" && !Object.keys(values).length) tool = "click";   // nothing to type: open/focus it instead
    const valueKey = a.value?.choice;
    return {
      tool, p_tool: a.tool.probabilities[a.tool.choice], target: ti == null ? null : +ti, p_target: tp ?? 0, el: byI.get(ti),
      valueKey, value: valueKey != null ? values[valueKey] : undefined,
      candidates: ranked.slice(0, 3).map(([i, p]) => ({ i: +i, p: +p.toFixed(2), el: brief(byI.get(i)) })),
    };
  }
argQuestions(tool, values, prefix) {
    const props = Object.entries(tool.inputSchema?.properties ?? {});
    const required = new Set(tool.inputSchema?.required ?? []);
    const shown = redactValues(values);   // Jev sees the key, never a secret's value
    const qs = {}, keys = [];
    for (const [n, [k, prop]] of props.entries()) {
      const isEnum = Array.isArray(prop?.enum);
      const opts = isEnum ? prop.enum.map(String) : Object.keys(values);
      if (!opts.length) continue;
      const criteria = Object.fromEntries(opts.map(o => [o, isEnum ? null : String(shown[o]).slice(0, 200)]));
      if (!required.has(k)) criteria[ARG_SKIP] = null;
      const what = prop?.description ? ` (${String(prop.description).slice(0, 150)})` : "";
      qs[`${prefix}${n}`] = { type: "choice", instructions: `If the next action toward \`task.goal\` calls the page tool \`${tool.name}\`, what should its \`${k}\` argument be${what}? Pick what the goal needs next, given what \`task.history\` already did.`, criteria };
      keys.push([`${prefix}${n}`, k, prop]);
    }
    return { qs, keys };
  }
argsFrom(answers, keys, values, act) {
    const args = {}; act.argKeys = {};
    for (const [q, k, prop] of keys) {
      const c = answers[q]?.choice;
      if (c == null || c === ARG_SKIP) continue;
      const isEnum = Array.isArray(prop?.enum);
      const raw = isEnum ? prop.enum.find(o => String(o) === c) : values[c];
      const type = Array.isArray(prop?.type) ? prop.type[0] : prop?.type;
      args[k] = type === "number" || type === "integer" ? Number(raw) : type === "boolean" ? (typeof raw === "boolean" ? raw : /^(true|yes|1|on)$/i.test(String(raw))) : raw;
      act.argKeys[k] = isEnum ? c : `values.${c}`;
    }
    return args;
  }
async webmcpArgs(page, goal, history, act, values) {
    const { qs, keys } = this.argQuestions({ name: act.webmcp, inputSchema: act.schema }, values, "a");
    if (!keys.length) { act.argKeys = {}; return {}; }
    const { answers } = await this.call({ page: { url: page.url, title: page.title, text: page.text }, task: { goal, ...(Object.keys(values).length ? { values: redactValues(values) } : {}), history }, tool: { name: act.webmcp, inputSchema: act.schema } }, qs);
    return this.argsFrom(answers, keys, values, act);
  }
async runGoal(goal, { values = {}, maxActions = 10, doneAt = 0.5, minTarget = 0.3, allowIrreversible = false, irreversibleAt = 0.6, log = () => {} } = {}) {
    const t0 = Date.now(); const calls0 = this.stats.calls;
    this.secrets ??= new Set();
    for (const [k, v] of Object.entries(values)) if (SECRET_KEY.test(k) && String(v).length >= 4) this.secrets.add(String(v));
    const history = []; const rounds = [];
    let prevPage = null, waits = 0, page = null, status = "max_actions", info, pending, retried = false;
    const seen = new Map(), dismissed = new Map();   // url -> dismiss attempts
    this.promptText = values.prompt;
    for (let round = 0; round <= maxActions; round++) {
      await this.settle();
      page = await this.snapshot();
      if (this.events.length) history.push(...this.events.splice(0).map(e => ({ event: e })));
      const webmcp = await this.webmcpTools();
      const a = await this.decide(page, goal, values, history.slice(-12), round ? pageDiff(redactPage(prevPage), redactPage(page)) : undefined, webmcp);
      prevPage = page;
      const act = this.resolve(page, a, values, webmcp);
      const done = Math.max(a.done.noul, a.done_change?.noul ?? 0);
      const r = {
        round, done: +done.toFixed(2), done_plain: +a.done.noul.toFixed(2), done_change: +(a.done_change?.noul ?? 0).toFixed(2),
        blocked: +a.blocked.noul.toFixed(2), error_shown: +a.error.noul.toFixed(2), login: +a.login.noul.toFixed(2), irreversible: +a.irreversible.noul.toFixed(2),
        tool: act.tool, p_tool: +act.p_tool.toFixed(2), target: act.target, p_target: +act.p_target.toFixed(2), el: actLabel(act),
        value: act.valueKey, elements: page.elements.length, stages: a.stages, candidates: act.candidates,
      };
      rounds.push(r);
      log(`  r${round}: ${act.tool}(${r.p_tool}) -> ${act.target != null ? `#${act.target} ` : ""}${r.el} (${r.p_target})${act.valueKey ? ` value=${act.valueKey}` : ""}  done=${r.done} err=${r.error_shown} login=${r.login} irrev=${r.irreversible}${a.use_tool ? ` use_tool=${a.use_tool.noul.toFixed(2)}` : ""}  [${page.elements.length} els${a.stages === 2 ? ", 2-stage" : ""}]`);

      if (round > 0 ? done >= doneAt && done < 0.85 && act.tool !== "none" : done >= 0.9) {
        // "done" and "next action" disagree: settle it with a stricter single question. In round 0
        // nothing has been done yet, so any "done" is checked (labels like a "Done" button mislead it).
        const c = await this.call({ page, task: { goal, history: history.slice(-12) } }, { complete: { type: "noul", instructions: "Is everything `task.goal` asks for already finished on `page`, so that no further action (such as pressing a submit, search or continue button) is needed?" } });
        r.confirm = +c.answers.complete.noul.toFixed(2);
        log(`     confirm=${r.confirm}`);
        if (r.confirm >= 0.65) { status = "done"; break; }
        if (r.confirm >= 0.45) { status = "likely_done"; info = "the page looks done but Jev is unsure; verify with a check, snapshot or screenshot"; break; }
        if (act.tool === "none" && a.use_tool?.noul >= 0.5) {
          // not done after all, and a page tool fits the next step: use it
          Object.assign(act, this.resolve(page, { ...a, tool: { ...a.tool, choice: "webmcp" } }, values, webmcp));
          r.tool = act.tool; r.el = actLabel(act);
        }
        if (a.irreversible.noul >= irreversibleAt && guarded(act)) {
          // the goal looks mostly done and the next step is hard to undo: stop rather than overstep
          status = "done"; info = "stopped before an action that looks irreversible and may go beyond this goal";
          pending = { action: act.tool, element: actLabel(act), p_irreversible: r.irreversible };
          break;
        }
      } else if (done >= (round > 0 ? doneAt : 0.9) && (done >= 0.85 || act.tool === "none" || round === 0)) { status = "done"; break; }
      if (round === maxActions) break;
      if (a.login.noul >= 0.7 && !Object.keys(values).length) {
        // no credentials to type: hand back instead of clicking through sign-in (incl. third-party SSO)
        status = "needs_login"; info = "the page wants a sign-in and no values were given; log in (e.g. in a headed persistent profile) or pass credentials in values"; break;
      }
      if (round > 0 && a.error.noul >= 0.7) { status = "error"; info = "the page shows an error after the last action"; break; }
      if (act.tool === "none" && round === 0 && !retried) {
        // content that appears after a delay (modals, late renders): look once more before giving up
        retried = true; await sleep(1500); round--; rounds.pop(); continue;
      }
      if (act.tool === "none" && round > 0 && done >= 0.35 && a.error.noul < 0.5 && a.blocked.noul < 0.5) {
        // Jev sees nothing left to do after acting, but "done" is soft: let the caller verify
        status = "likely_done"; info = "no further action seems needed but Jev is unsure the goal is met; verify with a check, snapshot or screenshot"; break;
      }
      if (act.tool === "none") { status = a.blocked.noul >= 0.5 ? "blocked" : "stuck"; break; }
      if (a.blocked.noul >= 0.85) { status = "blocked"; break; }
      if (act.tool === "wait") {
        if (++waits > 6) { status = "stuck"; info = "page never finished loading"; break; }
        await this.settle({ max: 4000 }); await sleep(600); history.push({ action: "wait" }); continue;
      }
      if ((TARGETED.has(act.tool) || act.tool === "webmcp") && act.p_target < minTarget) { status = "ambiguous"; info = "target confidence too low; refine the goal or act on a candidate directly"; break; }
      const seenKey = `${act.tool}|${actLabel(act)}|${["type", "select", "upload"].includes(act.tool) ? act.valueKey : ""}|${page.url}|${page.text}|${JSON.stringify(page.elements)}`;
      seen.set(seenKey, (seen.get(seenKey) ?? 0) + 1);
      if (seen.get(seenKey) >= 3) { status = "stuck"; info = "repeating the same action on the same page without progress"; break; }
      const seq = [...history.filter(h => h.action).map(h => `${h.action}|${h.element}|${h.value ?? ""}`), `${act.tool}|${actLabel(act)}|${["type", "select", "upload"].includes(act.tool) ? act.valueKey ?? "" : ""}`];
      if (repeatsBlock(seq, 2, 3) || repeatsBlock(seq, 3, 3) || repeatsBlock(seq, 1, 8)) { status = "stuck"; info = "repeating the same sequence of actions; the goal may already be done — check the page"; break; }

      // follow-up questions only for the chosen action
      if (act.tool === "select" && act.value == null && act.el?.options?.length) {
        const { answers } = await this.call({ page, task: { goal }, dropdown: act.el }, { opt: { type: "choice", instructions: "Which option of `dropdown.options` should be chosen for `task.goal`?", criteria: Object.fromEntries(act.el.options.map(o => [o, null])) } });
        act.value = answers.opt.choice; act.valueKey = undefined;
      }
      if (act.tool === "press_key") {
        const { answers } = await this.call({ page: { url: page.url, title: page.title, text: page.text, dialogs: page.dialogs }, task: { goal, history: history.slice(-6) } }, { key: { type: "choice", instructions: "Which keyboard key should be pressed next for `task.goal`?", criteria: Object.fromEntries(KEYS.map(k => [k, null])) } });
        act.key = answers.key.choice;
        const tgt = act.el; if (!tgt || !(FIELDISH(tgt) || tgt.tag.startsWith("input"))) act.target = null;   // page-level key press
      }
      if (act.tool === "drag") {
        const others = page.elements.filter(e => e.i !== act.target).slice(0, MAX_SINGLE);
        if (!others.length) { status = "stuck"; info = "nothing on the page to drop onto"; break; }
        const { answers } = await this.call({ page: { ...page, elements: others }, task: { goal, dragging: brief(act.el) } }, { dest: { type: "choice", instructions: "Onto which entry of `page.elements` (by its `i`) should `task.dragging` be dropped for `task.goal`?", criteria: Object.fromEntries(others.map(e => [String(e.i), null])) } });
        act.destination = +answers.dest.choice;
        r.destination = brief(page.elements.find(e => e.i === act.destination));
      }
      if (act.tool === "webmcp" && !act.args) act.args = await this.webmcpArgs(page, goal, history.slice(-12), act, values);
      if (guarded(act) && !allowIrreversible && a.irreversible.noul >= irreversibleAt) {
        status = "needs_confirmation"; info = "the next action looks hard to undo; call again with allow_irreversible to proceed";
        pending = { action: act.tool, element: actLabel(act), ...(act.argKeys ? { args: act.argKeys } : {}), ...(act.key ? { key: act.key } : {}), p_irreversible: r.irreversible };
        break;
      }

      const h = { action: act.tool, element: actLabel(act) };
      if (act.argKeys && Object.keys(act.argKeys).length) h.args = act.argKeys;
      if (act.tool === "select" && act.value != null) h.option = act.value;
      if (act.valueKey && ["type", "select", "upload"].includes(act.tool)) h.value = act.valueKey;
      if (act.key) h.key = act.key;
      if (r.destination) h.destination = r.destination;
      if (this.highlight && act.target != null) await this.showDecision(act, r).catch(() => {});
      try { r.act_ms = await this.act(act); if (act.result != null) h.result = act.result; }
      catch (e) { h.error = actionError(e); r.error = h.error; log(`  ! ${h.error}`); }
      history.push(h);
      // A modal/banner covers the target: if an uncovered control plainly says "close", dismiss it
      // so the next round can retry (Jev keeps picking the covered target otherwise). At most two
      // attempts per URL; if the target is still covered afterwards, say so in the history.
      if (h.error?.startsWith("click blocked") && (dismissed.get(page.url) ?? 0) < 2) {
        // re-read the page: the overlay often appeared after the snapshot this round decided on
        const now = await this.snapshot().catch(() => null);
        const closer = now && pickCloser(now.elements, now.url);
        if (closer) {
          dismissed.set(now.url, (dismissed.get(now.url) ?? 0) + 1);
          const d = { action: "dismiss_overlay", element: `${closer.tag} "${String(closer.text || closer.label || closer.hint).slice(0, 50)}"` };
          const before = this.page.url();
          try {
            await this.act({ tool: "click", target: closer.i }); await this.settle({ max: 2000 });
            if (this.page.url() !== before) d.navigated = this.page.url();
            else {
              const after = await this.snapshot().catch(() => null);
              const target = after?.elements.find(e => brief(e) === brief(act.el) && (e.near ?? "") === (act.el?.near ?? ""));
              if (target?.covered) d.still_covered = true;
            }
          } catch (e) { d.error = actionError(e); }
          log(`  ~ dismiss_overlay ${d.element}${d.error ? ` ! ${d.error}` : ""}${d.still_covered ? " (target still covered)" : ""}`);
          history.push(d);
        }
      }
      if (this.heldDialog) {
        status = "needs_confirmation"; info = "the action opened a confirmation dialog that looks hard to undo, so it was dismissed; call again with allow_irreversible to accept it";
        pending = { action: h.action, element: h.element, dialog: this.heldDialog.message, p_irreversible: this.heldDialog.p_irreversible };
        break;
      }
    }
    this.shown = page;
    if (this.events.length) history.push(...this.events.splice(0).map(e => ({ event: e })));
    const out = { status, goal, url: this.page.url(), title: await this.page.title().catch(() => ""), actions: history, rounds, jev_calls: this.stats.calls - calls0, ms: Date.now() - t0 };
    if (info) out.info = info;
    if (pending) out.pending = pending;
    out.done_score = +(rounds.at(-1)?.done ?? 0);
    if (!["done", "likely_done"].includes(status)) {
      out.page_text = page?.text?.slice(0, 600);
      if (["ambiguous", "stuck", "max_actions"].includes(status)) out.candidates = rounds.at(-1)?.candidates;
    }
    return out;
  }
}

export const WEBMCP_ACTION = "Call one of the page's own agent tools in `page.webmcp_tools`. The site provides them for agents and one call does the whole step (no typing into fields, no submit button), so when a tool does what the next step needs, choose this over click or type";
