#!/opt/juno/venv/bin/python
"""Create PDFs and work with existing ones (Chromium for rendering, pypdf for the rest).

  pdf_tool.py create OUT.pdf SPEC.json    blocks -> A4 document (any language, including Chinese)
  pdf_tool.py html IN.html OUT.pdf        print an HTML file to PDF
  pdf_tool.py merge OUT.pdf IN.pdf ...    concatenate
  pdf_tool.py split IN.pdf OUTDIR         one file per page
  pdf_tool.py pages IN.pdf RANGE OUT.pdf  keep pages, RANGE like 1-3,5
  pdf_tool.py text IN.pdf                 extract the text, page by page
  pdf_tool.py info IN.pdf                 page count and metadata
"""
import html
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_lib"))
from juno_skill import die, html_to_pdf, load_spec  # noqa: E402
from pypdf import PdfReader, PdfWriter  # noqa: E402

STYLE = ("@page{size:A4;margin:20mm}body{font-family:Inter,'Noto Sans CJK SC',sans-serif;font-size:11pt;line-height:1.5;color:#111}"
         "h1,h2,h3{line-height:1.25}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:4px 8px;text-align:left}"
         "th{background:#eee}img{max-width:100%}.pb{break-after:page}")


def blocks_to_html(blocks):
    out = []
    for block in blocks:
        kind = block.get("type", "paragraph")
        text = html.escape(str(block.get("text", "")))
        if kind == "heading":
            level = min(max(int(block.get("level", 1)), 1), 3)
            out.append("<h%d>%s</h%d>" % (level, text, level))
        elif kind == "paragraph":
            out.append("<p>%s</p>" % (("<b>%s</b>" if block.get("bold") else "%s") % text))
        elif kind in ("bullets", "numbered"):
            tag = "ul" if kind == "bullets" else "ol"
            out.append("<%s>%s</%s>" % (tag, "".join("<li>%s</li>" % html.escape(str(i)) for i in block["items"]), tag))
        elif kind == "table":
            rows = block["rows"]
            body = "".join("<tr>%s</tr>" % "".join(("<th>%s</th>" if r == 0 and block.get("header", True) else "<td>%s</td>") % html.escape(str(c)) for c in row)
                           for r, row in enumerate(rows))
            out.append("<table>%s</table>" % body)
        elif kind == "image":
            out.append('<img src="file://%s">' % os.path.abspath(block["path"]))
        elif kind == "pagebreak":
            out.append('<div class="pb"></div>')
        else:
            die("unknown block type: " + kind)
    return "<!doctype html><meta charset=utf-8><style>%s</style><body>%s</body>" % (STYLE, "".join(out))


def parse_range(spec, total):
    pages = []
    for part in spec.split(","):
        lo, _, hi = part.partition("-")
        pages += range(int(lo), int(hi or lo) + 1)
    if not pages or min(pages) < 1 or max(pages) > total:
        die("page range outside 1-" + str(total))
    return [p - 1 for p in pages]


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "create" and len(argv) == 4:
        with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as tmp:
            tmp.write(blocks_to_html(load_spec(argv[3])["blocks"]))
        try:
            html_to_pdf(tmp.name, argv[2])
        finally:
            os.unlink(tmp.name)
        print("wrote " + argv[2] + " (" + str(len(PdfReader(argv[2]).pages)) + " pages)")
    elif cmd == "html" and len(argv) == 4:
        html_to_pdf(argv[2], argv[3])
        print("wrote " + argv[3] + " (" + str(len(PdfReader(argv[3]).pages)) + " pages)")
    elif cmd == "merge" and len(argv) >= 4:
        writer = PdfWriter()
        for source in argv[3:]:
            for page in PdfReader(source).pages:
                writer.add_page(page)
        writer.write(argv[2])
        print("wrote " + argv[2] + " (" + str(len(writer.pages)) + " pages)")
    elif cmd == "split" and len(argv) == 4:
        os.makedirs(argv[3], exist_ok=True)
        for n, page in enumerate(PdfReader(argv[2]).pages, 1):
            writer = PdfWriter()
            writer.add_page(page)
            writer.write(os.path.join(argv[3], "page-%03d.pdf" % n))
        print("wrote " + str(n) + " files to " + argv[3])
    elif cmd == "pages" and len(argv) == 5:
        reader, writer = PdfReader(argv[2]), PdfWriter()
        for index in parse_range(argv[3], len(reader.pages)):
            writer.add_page(reader.pages[index])
        writer.write(argv[4])
        print("wrote " + argv[4] + " (" + str(len(writer.pages)) + " pages)")
    elif cmd == "text" and len(argv) == 3:
        for n, page in enumerate(PdfReader(argv[2]).pages, 1):
            print("--- page " + str(n))
            print(page.extract_text())
    elif cmd == "info" and len(argv) == 3:
        reader = PdfReader(argv[2])
        print("pages: " + str(len(reader.pages)))
        for key, value in (reader.metadata or {}).items():
            print(key + ": " + str(value))
    else:
        die(__doc__)


main(sys.argv)
