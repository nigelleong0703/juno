---
name: pdf
description: Create PDFs (reports, handouts, printable pages) or merge, split, extract text from and inspect existing PDFs.
---
# PDF

Tool: `/opt/juno/skills/pdf/pdf_tool.py` (Chromium prints, pypdf edits; both preinstalled; any language incl. Chinese).

- New document: write `/workspace/spec.json` `{"blocks":[...]}` then `pdf_tool.py create /workspace/out.pdf /workspace/spec.json`. Blocks: `{"type":"heading","text":"..","level":1}`, `{"type":"paragraph","text":"..","bold":true}`, `{"type":"bullets"|"numbered","items":[..]}`, `{"type":"table","rows":[[header..],[..]]}`, `{"type":"image","path":"/workspace/x.png"}`, `{"type":"pagebreak"}`.
- Custom design: write a self-contained HTML file with CSS (`@page{size:A4}`) and `pdf_tool.py html IN.html OUT.pdf`.
- Existing PDFs: `merge OUT IN...`, `split IN OUTDIR`, `pages IN 1-3,5 OUT`, `text IN` (read content), `info IN`.
- Check a new PDF with `text` (and the page count it prints), then deliver it with `artifact_publish {path, title}`.
