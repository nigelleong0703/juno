#!/opt/juno/venv/bin/python
"""Convert Markdown to Word, PDF or HTML with pandoc (PDF is printed by Chromium, so Chinese works).

  markdown_tool.py convert IN.md OUT.docx|OUT.pdf|OUT.html
"""
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_lib"))
from juno_skill import die, html_to_pdf  # noqa: E402

CSS = ("body{font-family:Inter,'Noto Sans CJK SC',sans-serif;max-width:46em;margin:2em auto;line-height:1.6}"
       "table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 8px}code,pre{background:#f4f4f4}pre{padding:8px;overflow:auto}"
       "@page{size:A4;margin:20mm}")


def pandoc(args):
    if shutil.which("pandoc") is None:
        die("pandoc is not installed: build the document with the docx or pdf skill instead")
    subprocess.run(["pandoc"] + args, check=True)


def main(argv):
    if len(argv) != 4 or argv[1] != "convert":
        die(__doc__)
    source, target = argv[2], argv[3]
    ext = os.path.splitext(target)[1].lower()
    if ext == ".docx":
        pandoc([source, "-o", target])
    elif ext in (".html", ".pdf"):
        folder = tempfile.mkdtemp(prefix="juno-md-")
        try:
            css = os.path.join(folder, "style.css")
            with open(css, "w", encoding="utf-8") as handle:
                handle.write(CSS)
            html_path = target if ext == ".html" else os.path.join(folder, "doc.html")
            pandoc([source, "-s", "--metadata", "pagetitle=" + os.path.splitext(os.path.basename(source))[0], "-c", css,
                    "--embed-resources", "-o", html_path])
            if ext == ".pdf":
                html_to_pdf(html_path, target)
        finally:
            shutil.rmtree(folder, ignore_errors=True)
    else:
        die("target must end in .docx, .pdf or .html")
    print("wrote " + target)


main(sys.argv)
