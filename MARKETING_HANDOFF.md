# Hướng dẫn bàn giao — Facebook Group Lead Pilot

## 1. Mục đích

Lọc các bài viết/bình luận Facebook Group trong **30 ngày gần nhất** để tìm:

- `potential_customer`: đang hỏi, cân nhắc hoặc có ý định làm dịch vụ.
- `experienced_customer`: đã làm và đang chia sẻ trải nghiệm.

Kết quả chỉ là bước sàng lọc, cần kiểm duyệt trước khi dùng cho marketing hoặc sales.

## 2. File kết quả hiện tại

File chính:

`results/30d_20261006/fb_group_30d_merged_all_20261006_utf8.csv`

File đã được lưu dạng UTF-8 có BOM để Excel/Google Sheets hiển thị đúng tiếng Việt.

File này là bản gốc của đợt quét ngày 2026-10-06 và được giữ nguyên để đối chiếu. Không ghi đè hoặc dùng một bản “repaired” thay thế cho file gốc.

Từ đợt quét tiếp theo, dùng `fb-group-lead-pilot.js` đã được tinh chỉnh. Nếu cần gộp nhiều file mới, `merge-results.js` là công cụ tùy chọn và sẽ tạo file đầu ra riêng, không sửa file nguồn.

## 3. Cách sử dụng

1. Mở file CSV bằng Excel hoặc Google Sheets.
2. Với file pilot của đợt mới, xem trước 8 cột `group_name`, `group_url`, `content_url`, `name`, `profile_url`, `source_type`, `published_at_text`, `text_excerpt`.
3. File scan raw không phân biệt lead/audit. Nếu cần danh sách marketing, chạy `merge-results.js` để tạo các file `repaired_leads` và `repaired_audit`; các điểm số/phân loại không nằm trong schema raw 8 cột.
4. Mở `content_url` để kiểm duyệt thủ công nội dung và bối cảnh.
5. Đánh dấu trạng thái nội bộ như `approved`, `needs_review` hoặc `reject` trong một bản sao làm việc.

Không tự động liên hệ, thu thập email/số điện thoại hoặc mở profile chỉ dựa trên file này.

## 4. Ý nghĩa điểm số

- `published_at_text`: ISO timestamp khi phân giải được từ nhãn thời gian Facebook; không dùng trực tiếp text tương đối như `1 tuần` để đối chiếu ngày.
- `source_type`: `post`, `comment` hoặc `reply`; `content_url` của `post` luôn là permalink bài viết, còn comment/reply dùng permalink riêng nếu Facebook cung cấp.

Ngưỡng chọn lead hiện tại (dùng nội bộ trước khi chia file): `intent_score >= 45` và `seeding_risk <= 59`.

## 5. Chạy đợt mới

1. Mở spreadsheet danh sách group trên Edge.
2. Mở từng link group trong tab Facebook riêng.
3. Vào **Thảo luận** và chọn **Bài viết mới** nếu có.
4. Chạy `fb-group-lead-pilot.js` trong Developer Tools Console.
5. Chờ tải file scan raw và manifest JSON tương ứng, đổi tên theo group nếu cần và lưu cả hai file nguồn.
6. Nhập cặp file từ Downloads bằng `node .\ingest-downloads.js "C:\Users\<user>\Downloads" .\results`. Dữ liệu được copy không phá hủy vào `results\<run_id>\raw`; chạy lại cùng nguồn không tạo bản sao xử lý mới.
7. Nếu có nhiều file nguồn cần gộp, chạy `node .\merge-results.js .\results\<run_id>\raw 30`. Lệnh này chỉ áp dụng cho đợt mới và không sửa các CSV nguồn. Với đợt 365 ngày, dùng tham số `365` tương ứng.

Có thể dùng `browser-runner.js` cho Phase 1 với Edge CDP và profile riêng. Chạy `node .\browser-runner.js --prepare-profile --cdp-endpoint http://127.0.0.1:9222 --profile-dir "<dedicated-edge-profile>"`, đăng nhập thủ công, rồi chạy runner với `--group-url`, `--collector-path`, `--results-dir`, `--days`, `--max-rounds` và `--max-runtime-ms`. Runner không nhập mật khẩu/OTP/CAPTCHA và chỉ xử lý một group mỗi lần.

Chỉ mở rộng phạm vi lên 365 ngày sau khi đã kiểm duyệt tối thiểu 100 dòng pilot.

## 6. Nguyên tắc sử dụng

- Tôn trọng quyền riêng tư và quy định của từng group.
- Không xem kết quả phân loại là xác minh danh tính.
- Không gửi tin nhắn hàng loạt hoặc quảng cáo không được phép.
- Luôn kiểm duyệt thủ công trước khi đưa vào CRM hoặc hoạt động kinh doanh.
