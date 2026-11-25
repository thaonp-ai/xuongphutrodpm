#!/usr/bin/env python3
"""Chuyển "Phân loại Unit.xlsx" (cột Unit | Tên mẫu) thành web/data/unit.json cho tab Kết quả phân tích.

Dùng:  python3 -I tools/unit_to_json.py "<Phân loại Unit.xlsx>" [web/data/unit.json]
Web ghép theo Tên mẫu (không phân biệt hoa/thường, dấu, khoảng trắng); mẫu không có trong file → "Chưa phân loại".
"""
import datetime, json, os, sys, unicodedata, re
import openpyxl

def key(s):
    s = unicodedata.normalize("NFD", str(s or "")).replace("đ", "d").replace("Đ", "D")
    return re.sub(r"\s+", " ", "".join(c for c in s if unicodedata.category(c) != "Mn").lower()).strip()

src = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "web", "data", "unit.json")
ws = openpyxl.load_workbook(src, data_only=True).worksheets[0]
rows = [[("" if v is None else str(v).strip()) for v in r] for r in ws.iter_rows(values_only=True)]
head = [key(h) for h in rows[0]]
iu = next(i for i, h in enumerate(head) if h == "unit")
im = next(i for i, h in enumerate(head) if "ten mau" in h or "diem" in h)
items, seen, dup = [], {}, []
for r in rows[1:]:
    u, m = (r[iu] if iu < len(r) else ""), (r[im] if im < len(r) else "")
    if not u or not m:
        continue
    k = key(m)
    if k in seen and seen[k] != u:
        dup.append(f"{m}: {seen[k]} / {u}")
    seen[k] = u
    items.append({"unit": u, "sample": m})
doc = {"updatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
       "source": os.path.basename(src), "items": items}
open(out, "w", encoding="utf-8").write(json.dumps(doc, ensure_ascii=False, indent=0) + "\n")
units = {}
for it in items: units[it["unit"]] = units.get(it["unit"], 0) + 1
print(f"{len(items)} mẫu, {len(units)} unit → {out}")
for u, n in units.items(): print(f"  {n:3d}  {u}")
for d in dup: print("CẢNH BÁO trùng tên mẫu khác unit:", d)
