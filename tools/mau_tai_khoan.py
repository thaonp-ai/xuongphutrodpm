"""Tạo file Excel mẫu quản lý tài khoản phụ (web/data/mau-tai-khoan.xlsx)."""
import sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation

out = sys.argv[1] if len(sys.argv) > 1 else "web/data/mau-tai-khoan.xlsx"
TEAL, TEALD, ORANGE, GREEN, NAVY = "549B9C", "2F6F70", "DF6437", "009D48", "354085"
thin = Side(style="thin", color="CFE3E3")
B = Border(left=thin, right=thin, top=thin, bottom=thin)

wb = Workbook()
ws = wb.active
ws.title = "Tai khoan"
ws.sheet_view.showGridLines = False
ws.merge_cells("A1:G1")
ws["A1"] = "DANH SÁCH TÀI KHOẢN – WEB XƯỞNG PHỤ TRỢ"
ws["A1"].font = Font(bold=True, size=15, color="FFFFFF")
ws["A1"].fill = PatternFill("solid", fgColor=TEALD)
ws["A1"].alignment = Alignment(horizontal="center", vertical="center")
ws.row_dimensions[1].height = 30
ws.merge_cells("A2:G2")
ws["A2"] = ("Điền mỗi tài khoản 1 dòng từ dòng 5 → trên web: 👤 ▾ → 👥 Quản lý tài khoản → 📥 Nhập từ Excel. "
            "Mật khẩu để trống = giữ mật khẩu cũ (tài khoản mới bắt buộc có). Tài khoản không có trong file sẽ giữ nguyên.")
ws["A2"].font = Font(italic=True, size=10, color="4B5563")
ws["A2"].alignment = Alignment(wrap_text=True, vertical="center")
ws.row_dimensions[2].height = 32
ws.merge_cells("A3:G3")
ws["A3"] = "⚠ Sau khi tải lên xong, nên xóa cột Mật khẩu trong file để không lộ mật khẩu."
ws["A3"].font = Font(bold=True, size=10, color=ORANGE)

heads = ["STT", "Tên đăng nhập", "Họ tên / ghi chú", "Mật khẩu", "Quyền", "Trạng thái", "Xóa tài khoản"]
widths = [6, 20, 32, 18, 30, 14, 14]
fills = [TEALD, TEALD, TEALD, ORANGE, NAVY, GREEN, "C23131"]
for i, (h, w, f) in enumerate(zip(heads, widths, fills), 1):
    c = ws.cell(row=4, column=i, value=h)
    c.font = Font(bold=True, color="FFFFFF")
    c.fill = PatternFill("solid", fgColor=f)
    c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    c.border = B
    ws.column_dimensions[c.column_letter].width = w
ws.row_dimensions[4].height = 24

N = 50
alt = PatternFill("solid", fgColor="F3F9F9")
for r in range(5, 5 + N):
    for col in range(1, 8):
        c = ws.cell(row=r, column=col)
        c.border = B
        if (r - 5) % 2: c.fill = alt
        c.alignment = Alignment(vertical="center", horizontal="center" if col in (1, 6, 7) else "left")
    ws.cell(row=r, column=1, value=f'=IF(B{r}="","",ROW()-4)')
    ws.cell(row=r, column=5, value=f'=IF(B{r}="","","Nạp phiếu Kết quả phân tích")').font = Font(color="6B7280")
    ws.cell(row=r, column=2).number_format = "@"
    ws.cell(row=r, column=4).number_format = "@"

dv1 = DataValidation(type="list", formula1='"Đang dùng,Khóa"', allow_blank=True)
dv1.add(f"F5:F{4+N}")
dv2 = DataValidation(type="list", formula1='"x"', allow_blank=True,
                     promptTitle="Xóa tài khoản", prompt="Gõ x để xóa tài khoản này khỏi web khi tải lên")
dv2.showInputMessage = True
dv2.add(f"G5:G{4+N}")
dv3 = DataValidation(type="custom", formula1='=AND(LEN(B5)>=3,LEN(B5)<=32,ISERROR(FIND(" ",B5)))',
                     showErrorMessage=True, errorTitle="Tên đăng nhập",
                     error="3–32 ký tự, viết liền không dấu (chữ, số, . _ -)",
                     promptTitle="Tên đăng nhập", prompt="3–32 ký tự, viết liền không dấu: chữ, số, . _ -")
dv3.showInputMessage = True
dv3.add(f"B5:B{4+N}")
dv4 = DataValidation(type="custom", formula1='=OR(D5="",LEN(D5)>=8)', showErrorMessage=True,
                     errorTitle="Mật khẩu", error="Mật khẩu cần ít nhất 8 ký tự",
                     promptTitle="Mật khẩu", prompt="Ít nhất 8 ký tự. Để trống = giữ mật khẩu cũ")
dv4.showInputMessage = True
dv4.add(f"D5:D{4+N}")
for d in (dv1, dv2, dv3, dv4): ws.add_data_validation(d)
ws.freeze_panes = "A5"

# Hướng dẫn
g = wb.create_sheet("Huong dan")
g.sheet_view.showGridLines = False
g.column_dimensions["A"].width = 24
g.column_dimensions["B"].width = 90
g["A1"] = "HƯỚNG DẪN"
g["A1"].font = Font(bold=True, size=14, color=TEALD)
rows = [
    ("Tên đăng nhập", "Bắt buộc. 3–32 ký tự viết liền, không dấu: chữ, số, dấu chấm, gạch dưới, gạch ngang. Web tự đổi thành chữ thường. Không trùng tên quản trị viên."),
    ("Họ tên / ghi chú", "Tên người dùng hoặc ghi chú (vd: Nguyễn Văn A – Kíp 1). Hiện trong lịch sử tải lên."),
    ("Mật khẩu", "Tài khoản MỚI: bắt buộc, ít nhất 8 ký tự. Tài khoản đã có: để trống = giữ mật khẩu cũ, điền = đặt lại mật khẩu."),
    ("Quyền", "Tự điền: Nạp phiếu Kết quả phân tích (tài khoản phụ chỉ được nạp phiếu ở tab Kết quả phân tích)."),
    ("Trạng thái", "Đang dùng / Khóa. Để trống = Đang dùng với tài khoản mới, giữ nguyên với tài khoản đã có. Khóa → bị đăng xuất ngay, không đăng nhập được."),
    ("Xóa tài khoản", "Gõ x để xóa tài khoản khỏi web. Lịch sử tải lên của tài khoản đó vẫn được giữ."),
    ("Tải lên", "Đăng nhập web bằng tài khoản quản trị → 👤 ▾ → 👥 Quản lý tài khoản → 📥 Nhập từ Excel → chọn file này → xem tóm tắt và bấm OK."),
    ("Lưu ý", "Tài khoản đang có trên web mà không có trong file thì GIỮ NGUYÊN. Sau khi tải lên, nên xóa cột Mật khẩu trong file."),
    ("Ví dụ", "kythuat1 | Nguyễn Văn A – Kíp 1 | Phutro@2026 | | Đang dùng |"),
]
for i, (a, b) in enumerate(rows, 3):
    g.cell(row=i, column=1, value=a).font = Font(bold=True, color=TEALD)
    c = g.cell(row=i, column=2, value=b)
    c.alignment = Alignment(wrap_text=True, vertical="top")
    g.row_dimensions[i].height = 32
wb.save(out)
print("ok", out)
