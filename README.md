# Facebook Group Lead Pilot

Công cụ pilot 30 ngày để phát hiện hai nhóm người dùng trong bài viết và bình luận Facebook Group:

- `potential_customer`: đang tìm hiểu hoặc có kế hoạch làm dịch vụ.
- `experienced_customer`: đã làm và đang chia sẻ trải nghiệm.

Các trường hợp nghi seeding và nội dung không đủ tín hiệu được xuất sang file audit để kiểm duyệt, không bị trộn vào danh sách lead.

## Dữ liệu được lấy

Công cụ chỉ đọc nội dung Facebook đã tải và hiển thị trong tab hiện tại:

- Tên hiển thị và URL profile.
- Tên group và URL group.
- Link nội dung nguồn (`content_url`), là link bài viết/bình luận đang được ghi nhận.
- Đánh giá nội dung: `review`, `service_question`, `seed_suspect` hoặc `noise`.
- Loại nguồn: bài đăng, bình luận hoặc reply.
- Mốc thời gian Facebook đang hiển thị.
- Loại thẩm mỹ và tên bác sĩ/phòng khám được nhắc tới.
- Điểm ý định, tính xác thực và rủi ro seeding.
- Một đoạn nội dung ngắn phục vụ kiểm duyệt.
- Cờ chất lượng như `anonymous_author`, `ui_chrome_removed`, `text_truncated` hoặc `comment_permalink_missing`.

Trong CSV, các cột chính được đặt ở đầu theo thứ tự: `group_name`, `group_url`, `content_url`, `content_assessment`, `published_at`, `procedure`, `doctor_name`. Các trường phân tích và nội dung chi tiết nằm ở cuối. CSV không có cột `captured_at`.

Công cụ không mở từng profile, không tìm email/số điện thoại và không gọi endpoint nội bộ của Facebook.

## Cách chạy từ spreadsheet danh sách group

1. Mở spreadsheet chứa danh sách group Facebook (như bảng có các cột `TÊN HỘI NHÓM` và `LINK`) trên Edge. Kiểm tra các ô link trỏ tới `facebook.com/groups/...`.
2. Với từng dòng có link group, mở link đó trong một tab Facebook riêng. Không chạy bộ quét khi vẫn đang ở spreadsheet.
3. Trong tab group, mở **Discussion** và chọn cách sắp xếp bài mới nhất nếu Facebook hiển thị tùy chọn này.
4. Mở Developer Tools → **Console**, sao chép toàn bộ nội dung `fb-group-lead-pilot.js`, dán vào Console rồi nhấn Enter.
5. Chờ đến khi quét xong hoặc bấm **Dừng & xuất CSV**. Nếu đổi tên file theo group/ID, giữ tiền tố `fb_group_leads_<days>d_` hoặc `fb_group_audit_<days>d_`, ví dụ `fb_group_leads_30d_20261006_group123.csv`.
6. Quay lại spreadsheet, mở link group kế tiếp và lặp lại từ bước 3.
7. Sau khi quét hết danh sách, giữ các file `leads` và `audit` theo từng group. Không cần tự khử trùng lặp bằng tay nếu dùng bộ gom ở bước kế tiếp; bộ gom dùng profile/post/source/nội dung để khử trùng lặp và vẫn giữ các tài khoản ẩn danh.
8. Có thể dùng bộ gom chuẩn hóa:

```powershell
node .\merge-results.js .\results\30d_YYYYMMDD 30
```

Bộ gom là bước tùy chọn cho các đợt mới: giữ lại danh tính, chuẩn hóa nội dung, suy ra bài/bình luận khi file nguồn không có permalink bình luận, loại dòng ngoài khoảng ngày và xuất ba file `repaired_all`, `repaired_leads`, `repaired_audit` cùng một `quality_report`. Nó chỉ tạo file mới, không sửa file CSV nguồn. Nếu quét 365 ngày, thay cả thư mục và tham số cuối thành `365`.

Lưu ý: phiên bản hiện tại chưa tự đọc spreadsheet, tự chuyển tab hoặc tự gộp nhiều group. Spreadsheet là danh sách đầu vào; mỗi link vẫn được xử lý độc lập để giới hạn phạm vi và giúp truy vết đúng group nguồn.

## Checkpoint quét hằng ngày

- Lần quét đầu tiên dùng `days` (mặc định 30 ngày).
- Checkpoint chính được lưu trong `checkpoints.json` ở thư mục dự án; `localStorage` của Edge chỉ còn là cơ chế dự phòng cho các lượt chạy cũ.
- Sau mỗi lượt quét hoàn tất tự nhiên, agent phải ghi `scan_started_at` vào manifest bằng `checkpoint-tools.js`.
- Lần quét kế tiếp chỉ giữ nội dung có thời gian từ checkpoint đó trở đi. Ví dụ lần trước bắt đầu lúc 09:00 thì lần sau quét từ 09:00 trở đi.
- Nếu bấm **Dừng & xuất CSV**, checkpoint không được cập nhật để tránh bỏ sót dữ liệu.
- Nếu trang không trả về bản ghi nào, checkpoint cũng không được cập nhật để tránh tiến mốc khi Facebook chưa tải nội dung hoặc đã thay đổi DOM.
- Muốn quét lại từ đầu, chạy trong Console: `FBGroupLeadPilot.clearCheckpoint('https://www.facebook.com/groups/<group-id>/')`.
- Có thể xem hoặc cập nhật manifest bằng các lệnh:

```powershell
node .\checkpoint-tools.js list
node .\checkpoint-tools.js get "https://www.facebook.com/groups/<group-id>/"
node .\checkpoint-tools.js register "https://www.facebook.com/groups/<group-id>/" "Tên group"
node .\checkpoint-tools.js set "https://www.facebook.com/groups/<group-id>/" "2026-10-07T01:39:00.000Z" "Tên group"
node .\checkpoint-tools.js export-map
```

- Trước khi dán script vào Console, agent đọc `checkpoints.json` và inject toàn bộ map (kể cả giá trị `null`) vào `window.__FB_GROUP_CHECKPOINTS__`. Khi đó file là nguồn chính; một key có giá trị `null` sẽ không bị checkpoint cũ trong `localStorage` ghi đè.
- Sau khi script hoàn tất, agent đọc `window.__FB_GROUP_LEAD_PILOT_LAST_RUN__`. Chỉ khi `checkpoint_saved=true` mới ghi checkpoint vào manifest.
- Đổi profile hoặc xóa dữ liệu site không còn làm mất checkpoint chính trong dự án, nhưng vẫn có thể làm mất fallback `localStorage`.

Khi hoàn thành, trình duyệt tải hai file:

- `fb_group_leads_<days>d_*.csv`: các lead đạt ngưỡng, kể cả tài khoản ẩn danh nếu nội dung đủ tín hiệu.
- `fb_group_audit_<days>d_*.csv`: seeding, nhiễu và các dòng có danh tính cần xem lại.

## Chạy kiểm thử bộ phân loại

```powershell
node .\test-classifier.js
```

## Điều chỉnh trước khi quét 365 ngày

Sau khi kiểm duyệt thủ công mẫu 30 ngày, chỉnh các trường sau trong `CONFIG`:

- `days`: đổi từ `30` thành `365`.
- `minimumIntentScore`: tăng để giảm lead yếu.
- `maximumSeedingRisk`: giảm để lọc seeding mạnh hơn.
- `scrollIntervalMs`: nên giữ từ 2 giây trở lên.

Không nên mở rộng lên 365 ngày trước khi đánh dấu tối thiểu 100 dòng pilot là đúng/sai. Các ví dụ này cần được dùng để bổ sung từ khóa riêng của doanh nghiệp và tên những tài khoản seeding đã biết.

## Lưu ý vận hành

- Facebook sử dụng DOM ảo nên nội dung cũ biến mất khi cuộn; công cụ lưu cuốn chiếu để tránh mất dữ liệu đã thấy.
- Một số bình luận chỉ xuất hiện sau khi bấm “View more comments/replies”. Công cụ cố mở các nút đang hiển thị nhưng không thể bảo đảm mọi bình luận của bài lớn đều được tải.
- Nếu Facebook không cung cấp permalink riêng cho bình luận, `content_url` vẫn trỏ về bài viết và cột `data_quality_flags` ghi `comment_permalink_missing`; không coi đây là link bình luận chính xác.
- `review_status=excluded_noise` nghĩa là dòng không đạt tín hiệu lead; `pending_human_review` chỉ dành cho review/câu hỏi cần người kiểm duyệt.
- Bài và bình luận ẩn danh vẫn được giữ lại để sàng lọc. Cột `is_anonymous` được đặt là `yes`; nếu Facebook không cung cấp URL hồ sơ thật thì `profile_url` để trống, không tự suy đoán URL.
- Nickname Facebook tự sinh dạng `TrustyRhino842`, `SunnyKangaroo8613` hoặc `PastelLychee5270` được đánh dấu ẩn danh thay vì loại bỏ.
- Link dạng `/groups/.../user/ID/` được chuẩn hóa thành `https://www.facebook.com/ID/`.
- Kết quả phân loại là bước sàng lọc, không phải xác minh danh tính. Cần duyệt thủ công trước khi sử dụng cho hoạt động kinh doanh.
