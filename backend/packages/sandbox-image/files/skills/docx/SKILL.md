---
name: docx
description: Create, read or edit Word documents (.docx) such as reports, letters, memos and contracts.
---
# Word documents

Tool: `/opt/juno/skills/docx/docx_tool.py` (python-docx is preinstalled; do not pip install).

1. Write a spec to `/workspace/spec.json`: `{"blocks":[...]}`. Blocks: `{"type":"heading","text":"..","level":1}`, `{"type":"paragraph","text":"..","bold":true}`, `{"type":"bullets"|"numbered","items":[..]}`, `{"type":"table","rows":[[header..],[..]]}`, `{"type":"image","path":"/workspace/x.png"}`, `{"type":"pagebreak"}`.
2. `/opt/juno/skills/docx/docx_tool.py create /workspace/report.docx /workspace/spec.json`
3. Edit later: `append FILE SPEC` adds blocks; `replace FILE OLD NEW` swaps text; `text FILE` prints the content. For layout beyond blocks, use python-docx directly with `/opt/juno/venv/bin/python`.
4. Check the result with `text`, then deliver it with `artifact_publish {path, title}`.
