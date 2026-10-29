---
name: xlsx
description: Create, read or edit Excel workbooks (.xlsx) with data, formulas and formatting.
---
# Excel workbooks

Tool: `/opt/juno/skills/xlsx/xlsx_tool.py` (openpyxl is preinstalled; do not pip install).

1. Write `/workspace/spec.json`: `{"sheets":[{"name":"Sales","rows":[["Item","Qty","Price","Total"],["Tea",2,3.5,"=B2*C2"]],"formats":{"C":"#,##0.00","D":"#,##0.00"}}]}`. The first row is the styled header (`"header":false` to skip). A string starting with `=` is a formula. Column widths and a frozen header are automatic.
2. `/opt/juno/skills/xlsx/xlsx_tool.py create /workspace/sales.xlsx /workspace/spec.json`
3. `dump FILE` prints every cell (formulas as written); `set FILE 'Sheet!B2' 5` edits one cell; `recalc FILE` computes the formulas with LibreOffice and prints their values (on a computer without LibreOffice the first `recalc` installs it, which takes a few minutes and prints a status line): use it to check them (openpyxl itself never calculates). More control: openpyxl with `/opt/juno/venv/bin/python`.
4. Deliver the result with `artifact_publish {path, title}`.
