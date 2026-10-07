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
2. Với file của đợt mới, xem trước các cột `group_name`, `content_url`, `content_assessment`, `published_at`, `procedure`, `name`, `is_anonymous`, `data_quality_flags`. File gốc ngày 2026-10-06 không có `data_quality_flags`, vì đây là cột được thêm cho lần quét mới.
3. Ưu tiên kiểm tra các dòng có `segment` là `potential_customer` hoặc `experienced_customer`.
4. Mở `content_url` để kiểm duyệt thủ công nội dung và bối cảnh.
5. Đánh dấu trạng thái nội bộ như `approved`, `needs_review` hoặc `reject` trong một bản sao làm việc.

Không tự động liên hệ, thu thập email/số điện thoại hoặc mở profile chỉ dựa trên file này.

## 4. Ý nghĩa điểm số

- `intent_score`: mức độ thể hiện ý định sử dụng dịch vụ.
- `authenticity_score`: mức độ giống trải nghiệm thật.
- `seeding_risk`: rủi ro nội dung quảng cáo/seeding.
- `data_quality_flags`: cờ như `ui_chrome_removed`, `text_truncated`, `anonymous_author` hoặc `comment_permalink_missing`.

Ngưỡng chọn lead hiện tại: `intent_score >= 45` và `seeding_risk <= 59`.

## 5. Chạy đợt mới

1. Mở spreadsheet danh sách group trên Edge.
2. Mở từng link group trong tab Facebook riêng.
3. Vào **Thảo luận** và chọn **Bài viết mới** nếu có.
4. Chạy `fb-group-lead-pilot.js` trong Developer Tools Console.
5. Chờ tải file lead/audit, đổi tên theo group và lưu lại nguồn.
6. Nếu có nhiều file nguồn cần gộp, chạy `node .\merge-results.js .\results\30d_YYYYMMDD 30`. Lệnh này chỉ áp dụng cho đợt mới và không sửa các CSV nguồn. Với đợt 365 ngày, dùng thư mục và tham số `365` tương ứng.

Chỉ mở rộng phạm vi lên 365 ngày sau khi đã kiểm duyệt tối thiểu 100 dòng pilot.

## 6. Nguyên tắc sử dụng

- Tôn trọng quyền riêng tư và quy định của từng group.
- Không xem kết quả phân loại là xác minh danh tính.
- Không gửi tin nhắn hàng loạt hoặc quảng cáo không được phép.
- Luôn kiểm duyệt thủ công trước khi đưa vào CRM hoặc hoạt động kinh doanh.
