---
name: pptx
description: Create or read PowerPoint decks (.pptx): pitches, lessons, reports as slides.
---
# PowerPoint decks

Tool: `/opt/juno/skills/pptx/pptx_tool.py` (python-pptx is preinstalled; do not pip install).

1. Write `/workspace/spec.json`: `{"slides":[...]}`. A slide is `{"layout":"title","title":"..","subtitle":".."}` or `{"title":"..", "bullets":[..]}` / `{"title":"..","table":[[..],[..]]}` / `{"title":"..","image":"/workspace/x.png"}`; any slide may add `"notes":"speaker notes"`. Keep bullets short (at most 6 per slide).
2. `/opt/juno/skills/pptx/pptx_tool.py create /workspace/deck.pptx /workspace/spec.json`
3. `text FILE` prints every slide and its notes: use it to verify. For custom layouts use python-pptx directly with `/opt/juno/venv/bin/python`.
4. Deliver the result with `artifact_publish {path, title}`.
