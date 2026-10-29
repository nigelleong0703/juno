---
name: markdown
description: Write well-structured Markdown documents and convert them to Word, PDF or HTML.
---
# Markdown

Write the `.md` file in `/workspace` with the normal file tools. Structure: one `#` title, `##` sections, short paragraphs, lists for parallel items, tables for comparisons, fenced code with a language, descriptive link text.

Convert (pandoc; PDF is printed by Chromium so Chinese works):
`/opt/juno/skills/markdown/markdown_tool.py convert /workspace/notes.md /workspace/notes.docx` (or `.pdf`, `.html`).
If pandoc is missing, build the file with the `docx` or `pdf` skill instead.

Deliver the `.md` itself (rendered in the chat) or the converted file with `artifact_publish {path, title}`.
