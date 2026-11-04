---
name: deep-search
description: Default method for answering a factual or current question in the chat that needs the web ("这几天有什么值得关注", "AI股这周怎么样", "最近有什么演唱会", prices, comparisons, "what's new with X", "去搜一下 X"): plan what the answer must contain, search in several waves from different angles, open the real pages, cross-check, dig where sources disagree, then a concise sourced answer. One search plus snippets is not an answer. For a long analysed report or a Feed article use deep-research instead.
---
# Deep search

Use this for any question answered in the chat that depends on what is true or current in the world: news, prices, schedules, events, how things compare, what happened this week. The person wants to be told what is actually the case, not snippets. It runs in this chat run; no subagent. A long analysis, report or Feed article is a different job: read deep-research. "Search for X" or "去搜一下 X" means search the world for X (the web, original sources), never your own notes or skills.

## Size the job first

- One fact (a price, a date, a score): 3 to 6 searches and pages, two sources or one primary.
- A current-events or comparison question (what happened this week, how are X doing, which is better): 10 to 25 pages opened, from different publishers, including the primary source behind the main figures. A reply built on two or three pages, or on figures that only one site gave, is not finished: keep going (run the next searches and opens before you answer) until each key figure has a second source or an original. This takes a few minutes; that is expected.
- If the answer needs more than about 25 pages, several entities in depth, or a written analysis, stop and move to deep-research.

## Method (rounds: reflect, search, open)

1. Before searching, write what a good answer contains: the facts, figures, dates and names a knowledgeable person would give for this exact question in the time window asked. Search for those, not for the question's wording. Keep the list for the final check.
2. Round 1, broad: 4 to 6 short, differently worded searches together in one turn. Vary the angle, the wording, the language when the subject has local sources (a Chinese company or event: Chinese and English), and the kind of source (official page, filing or data, news report, forum or reviews for lived experience).
3. Open the pages. Read the page, not the snippet. Open the primary source behind each news item (company, organiser, filing, official data). A page that will not open (403, bot check) is not a source: try another copy or the primary document; if nothing opens, say so.
4. Reflect after each round, two lines to yourself: what is now known, what is missing, what two sources disagree about. The next round targets exactly that with narrower queries. Never repeat a query.
5. Cross-check every figure that matters across two sources or one primary source. If they disagree, or a number rests on one thin page, find the original or a later correction. If they still disagree give both and say which you trust and why. Prefer newer trustworthy sources for anything that changes.
6. Stop when a knowledgeable reader's obvious follow-up questions are answered from opened pages, or two rounds in a row added nothing new. Not at a fixed count, but not before the size floor above.

## Check before answering

- Does it answer the question asked, definitively where a source is clear?
- If the person asked for N items you have N; if several named things were asked about, each is covered.
- Is everything current for the window asked (dates on the sources)?
- Does each figure have a source you opened?

## The answer

- The takeaway first, then the concrete figures, names and dates that support it. Compare when the question compares; a small table is fine for three or more items across several attributes.
- Say what is confirmed, what is inferred, and what you could not find. Never present a guess as a fact.
- Cite only pages you opened, as plain links next to the claim.
- Keep to the chat style rules. If asked how you found it, describe what you did in the person's terms and name the sources really opened; never name tools, skills or internal steps.
- If the person then wants more depth, a report or a Feed post, continue from what you found with deep-research instead of starting over.
