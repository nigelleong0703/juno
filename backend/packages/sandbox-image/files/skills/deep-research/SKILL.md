---
name: deep-research
description: Method for any detailed analysis, in-depth research, report, deep dive or comparison the person will act on ("详细分析", "深入", "研究一下", "报告", "analysis", "deep dive", "what's really going on with X"): plan what an expert would expect, fan out to parallel researchers who read primary documents and keep a source ledger, close gaps in a second wave, then write an analysed, sourced report and audit it before delivering.
---
# Deep research

Use this whenever the person wants more than a quick answer: a detailed analysis, a report, a deep dive, a comparison, a market or company review, or anything they will decide on. The first result must already have the depth they obviously want. Do not ship a thin version and wait to be told it is shallow. For a short factual answer in chat use deep-search instead. If the result goes to the Feed, read feed-article for the format and follow it for delivery.

Target scale: what a thorough analyst team does in 10 to 30 minutes. A full report rests on a few dozen to a hundred pages actually opened, a good share of them primary documents, split over 4 to 12 researchers. Fewer than 4 researchers is wrong for a report; if you are about to use one, you are doing deep-search. Take the minutes it needs.

## 1. Plan (you, before anything is searched)

1. The expert checklist: if an expert read an answer to this exact question, what must it contain? Specific items (for an earnings question: reported numbers against expectations from the filing, guidance changes, market reaction and its cause, peer comparison, what to watch, risks). Include the person's own angle (what they hold, decide or care about) and the exact time window.
2. Query type. Breadth-first: independent parts (companies, regions, products): one slice each. Depth-first: one question needing several angles: one slice per angle, named as viewpoints (operator, regulator, customer, sceptic); make one slice the strongest counter-case to the obvious conclusion.
3. Slices: 4 to 12, mutually exclusive, together covering the checklist; every checklist item belongs to exactly one slice. When the parts are entities, add one slice for the cross-cutting view (comparison, market, history).
4. If the request is truly ambiguous in a way a search cannot settle, pick the most likely meaning, say it in a few words, and go on.

## 2. Wave 1: fan out

In ONE turn start one subagent per slice (at most 6 run at once; start the rest as soon as slots free up, with the same instructions), then end the turn. Never research the slices yourself and never hand the whole question to one subagent.

A subagent starts with a copy of this conversation, but write every brief as if it had not seen it: self-contained, and carrying:
- the question, the person's angle, the exact time window, today's date;
- the slice: one core objective, the checklist items it owns, and what is out of scope (name the neighbouring slices so work is not duplicated);
- "read the Researcher section first: skill_read deep-research" and, for a Feed article, "skill_read feed-article" for the picture rules;
- the source plan: the primary documents to find first (filing, earnings release, call transcript or shareholder letter, regulator, statistics office, original paper, official page), the secondary sources that are acceptable, and what to avoid (content farms, unnamed-source rewrites);
- the budget: at least 12 and aim for 20 to 30 opened pages, never more than 40; stop earlier only if the last two rounds added nothing new; open the primary documents for the slice, not only news;
- where the ledger goes: `research_notes/<topic>/<slice>.md` in the shared working folder (the file is the full ledger, see the Researcher section);
- what to reply with: only the file path, five lines of headline findings, pages opened, primary documents opened, what could not be found or opened, conflicts between sources. The lead reads the ledger files, not a long reply.

You are woken as each subagent ends. While others still run (tasks_list), do nothing more and end the turn; act when the last one is in.

## 3. Gap pass (you, after wave 1)

1. Read every ledger file (files.read) and any long result (output_read). Do not summarise them into prose yet. If a file is missing, ask that subagent for its ledger or rerun the slice.
2. Score the checklist: for each item, is there a sourced answer from an opened page? Mark thin, unsourced and conflicting items.
3. Outline the report with the claim you expect in each section and mark each claim supported, thin or missing. The holes are the gap list. Add any surprising number or name that several results mention but nobody explained.
4. If the gap list is not empty, wave 2: one subagent per gap or conflict (at most 6), each with the exact question, what is already known with its sources, the same ledger rules and a budget of 10 to 20 pages. Wait for them as in wave 1.
5. Two waves is the maximum. After wave 2, write with what you have and say what stayed unknown. Stop earlier if the checklist is complete.

## 4. Researcher section (for subagents; if you are an assigned subagent, do your slice yourself, no further delegation)

Work in rounds until the budget is used or the stop rule hits:
1. Reflect (two lines to yourself): what do I know, what is missing, which query next.
2. Search with several short, differently worded queries together in one turn (3 to 5 words usually works best; vary the wording and, for subjects with local sources, the language). Never repeat a query.
3. Open the pages. Read the page, not the snippet. Find the primary document each article cites and open that. Open PDFs. A page that will not open (403, bot check) is not a source: try another copy or the document it cites; if nothing opens, say so and do not cite it.
4. Keep a ledger as you go, in the file named in your brief (create the folder; append after each round, do not keep it in your head). One row per finding: claim or figure | exact number and unit | source URL | publication date | primary or secondary | confidence. Keep entity names, exact metrics and dates; keep short verbatim quotes for contested or important claims. Mark speculation (could, may, forecasts) as such. Record conflicts between sources instead of choosing silently.
5. Follow leads one level deeper where the answer depends on them.

Stop when the slice's checklist items are all answered from opened pages, or the last two rounds added nothing new, or the budget is used. End the ledger file with "Not found / could not open". Your reply is short: the file path, five lines of headline findings, pages opened, primary documents opened. Facts only from opened pages; never a figure you did not read.

## 5. Analyse, do not list

- Explain causes: why it happened, not only that it did.
- Quantify and compare: figures side by side, against expectations, the previous period, peers.
- Give the counter-case and say why you reject it or not. Take a position the sources support; say what it means for the person and what to watch.
- Mark each important statement confirmed (a source says it), inferred (your reasoning, say so) or unknown (looked, found nothing). Never present a guess as a fact. Do not state investment, medical or legal conclusions as certainties.
- Newer trustworthy sources beat older ones; primary beats secondary; when two disagree say which you trust and why.

## 6. Write

Write the report yourself from the ledgers, section by section, reading the results as you write each section; do not hand the writing to a subagent, the cross-slice analysis is the job. Shape: the answer and main takeaway in the first paragraph; sections whose headers state the finding; a comparison table where things are compared; the counter-case; risks and what to watch; what stayed unknown. Prose with the key figures in bold, every figure with its source link and date beside it. A full run is long because the material is: do not pad, and do not cut sourced material that answers a checklist item.

## 7. Check before you deliver

1. Checklist: each item answered with a sourced statement? A thin item is researched now (if wave 2 is still unused), not delivered thin.
2. Answer gate: does the report answer the question asked, definitively where a source is clear; the full count if the person asked for N items; every named element covered; facts current for the window asked?
3. Citation audit: every figure and quote in the report is in a ledger row with a URL; drop any that are not. Every link was opened by someone in this research. A figure attributed to a company's own release or filing comes from that release or filing as opened.
4. Nothing padded; the takeaway is at the top.

## 8. Deliver

Where the person asked (the Feed, a document, the chat). The chat reply is short: the takeaway and where the full result is. Say plainly what was done in the person's terms and name the kinds of sources actually opened (for example "Amazon's earnings release and CNBC/AP reports"); never name tools, skills, subagents or internal steps; never claim a source you did not open; say what could not be verified or found.
