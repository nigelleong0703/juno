#!/opt/juno/venv/bin/python
"""Create and read PowerPoint decks (python-pptx).

  pptx_tool.py create OUT.pptx SPEC.json   slides -> new 16:9 deck
  pptx_tool.py text FILE.pptx              print every slide's text and notes
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_lib"))
from juno_skill import die, load_spec  # noqa: E402
from pptx import Presentation  # noqa: E402
from pptx.util import Inches  # noqa: E402


def add_slide(prs, spec):
    kind = spec.get("layout", "content")
    if kind == "title":
        slide = prs.slides.add_slide(prs.slide_layouts[0])
        slide.shapes.title.text = spec["title"]
        if "subtitle" in spec:
            slide.placeholders[1].text = spec["subtitle"]
    else:
        slide = prs.slides.add_slide(prs.slide_layouts[5])  # title only: we place the body ourselves
        slide.shapes.title.text = spec["title"]
        left, top, width, height = Inches(0.8), Inches(1.7), Inches(11.7), Inches(5.2)
        if "bullets" in spec:
            frame = slide.shapes.add_textbox(left, top, width, height).text_frame
            frame.word_wrap = True
            for i, item in enumerate(spec["bullets"]):
                paragraph = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
                paragraph.text = "• " + str(item)
                paragraph.font.size = Inches(0.3)
        if "table" in spec:
            rows = spec["table"]
            shape = slide.shapes.add_table(len(rows), max(len(r) for r in rows), left, top, width, Inches(0.5) * len(rows))
            for r, row in enumerate(rows):
                for c, value in enumerate(row):
                    shape.table.cell(r, c).text = str(value)
        if "image" in spec:
            slide.shapes.add_picture(spec["image"], left, top, height=height)
    if spec.get("notes"):
        slide.notes_slide.notes_text_frame.text = spec["notes"]


def main(argv):
    if len(argv) == 4 and argv[1] == "create":
        prs = Presentation()
        prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
        for spec in load_spec(argv[3])["slides"]:
            add_slide(prs, spec)
        prs.save(argv[2])
        print("wrote " + argv[2] + " (" + str(len(prs.slides)) + " slides)")
    elif len(argv) == 3 and argv[1] == "text":
        for n, slide in enumerate(Presentation(argv[2]).slides, 1):
            print("--- slide " + str(n))
            for shape in slide.shapes:
                if shape.has_text_frame:
                    print(shape.text_frame.text)
                if shape.has_table:
                    for row in shape.table.rows:
                        print("\t".join(cell.text for cell in row.cells))
            if slide.has_notes_slide:
                print("[notes] " + slide.notes_slide.notes_text_frame.text)
    else:
        die(__doc__)


main(sys.argv)
