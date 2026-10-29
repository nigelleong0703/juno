#!/opt/juno/venv/bin/python
"""Create, read and edit Word documents (python-docx).

  docx_tool.py create OUT.docx SPEC.json   blocks -> new document
  docx_tool.py append FILE.docx SPEC.json  add blocks at the end
  docx_tool.py text FILE.docx              print paragraphs and tables as text
  docx_tool.py replace FILE.docx OLD NEW   replace text (runs keep their formatting where possible)
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_lib"))
from juno_skill import die, load_spec  # noqa: E402
from docx import Document  # noqa: E402
from docx.enum.text import WD_BREAK  # noqa: E402
from docx.shared import Inches  # noqa: E402


def add_blocks(doc, blocks):
    for block in blocks:
        kind = block.get("type", "paragraph")
        if kind == "heading":
            doc.add_heading(block["text"], level=int(block.get("level", 1)))
        elif kind == "paragraph":
            paragraph = doc.add_paragraph()
            run = paragraph.add_run(block["text"])
            run.bold = bool(block.get("bold"))
            run.italic = bool(block.get("italic"))
        elif kind in ("bullets", "numbered"):
            style = "List Bullet" if kind == "bullets" else "List Number"
            for item in block["items"]:
                doc.add_paragraph(str(item), style=style)
        elif kind == "table":
            rows = block["rows"]
            table = doc.add_table(rows=len(rows), cols=max(len(row) for row in rows))
            table.style = "Table Grid"
            for r, row in enumerate(rows):
                for c, value in enumerate(row):
                    cell = table.cell(r, c)
                    cell.text = str(value)
                    if r == 0 and block.get("header", True):
                        for run in cell.paragraphs[0].runs:
                            run.bold = True
        elif kind == "image":
            doc.add_picture(block["path"], width=Inches(float(block.get("width_in", 5))))
        elif kind == "pagebreak":
            doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
        else:
            die("unknown block type: " + kind)


def replace_text(doc, old, new):
    count = 0
    containers = [doc] + [cell for table in doc.tables for row in table.rows for cell in row.cells]
    for container in containers:
        for paragraph in container.paragraphs:
            if old not in paragraph.text:
                continue
            count += paragraph.text.count(old)
            done = False
            for run in paragraph.runs:
                if old in run.text:
                    run.text = run.text.replace(old, new)
                    done = True
            if not done and paragraph.runs:  # the text spans several runs: put the result in the first
                paragraph.runs[0].text = paragraph.text.replace(old, new)
                for run in paragraph.runs[1:]:
                    run.text = ""
    return count


def main(argv):
    if len(argv) < 3:
        die(__doc__)
    cmd, path = argv[1], argv[2]
    if cmd == "create" and len(argv) == 4:
        doc = Document()
        add_blocks(doc, load_spec(argv[3])["blocks"])
        doc.save(path)
    elif cmd == "append" and len(argv) == 4:
        doc = Document(path)
        add_blocks(doc, load_spec(argv[3])["blocks"])
        doc.save(path)
    elif cmd == "text" and len(argv) == 3:
        doc = Document(path)
        for paragraph in doc.paragraphs:
            print(paragraph.text)
        for table in doc.tables:
            for row in table.rows:
                print("\t".join(cell.text for cell in row.cells))
        return
    elif cmd == "replace" and len(argv) == 5:
        doc = Document(path)
        count = replace_text(doc, argv[3], argv[4])
        doc.save(path)
        print("replaced " + str(count))
        return
    else:
        die(__doc__)
    print("wrote " + path)


main(sys.argv)
