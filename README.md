# Facebook Group Lead Pilot

Công cụ pilot 30 ngày để phát hiện hai nhóm người dùng trong bài viết và bình luận Facebook Group:

- `potential_customer`: đang tìm hiểu hoặc có kế hoạch làm dịch vụ.
- `experienced_customer`: đã làm và đang chia sẻ trải nghiệm.

Các trường hợp nghi seeding và nội dung không đủ tín hiệu được phân loại ở bước downstream để kiểm duyệt, không bị trộn vào danh sách lead.

## Điều phối multi-agent

Quy trình giao việc, phạm vi của 4 worker và format handoff được ghi trong [ORCHESTRATION.md](ORCHESTRATION.md). Chat Orchestrator là đầu mối nhận kết quả từ các session, chuyển output sang QA/Evaluator và chỉ cho phép release sau khi các gate đạt.

Bốn vai trò hiện tại:

- Script Engineer: sửa crawler, checkpoint và test.
- Browser Collector: chạy scan, lưu CSV và trạng thái từng group.
- Output QA: kiểm tra độc lập chất lượng output, chỉ đọc.
- Classifier Evaluator: đánh giá false positive/false negative, chỉ đề xuất.

Các session dùng chung project local nên phân quyền hiện tại là quy ước vận hành theo role; không để nhiều agent cùng sửa một file. Chỉ Orchestrator điều phối commit/push.

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
- Cờ chất lượng như `anonymous_author`, `ui_chrome_removed`, `ui_chrome_contamination`, `text_truncated` hoặc `comment_permalink_missing`.

CSV pilot cố định 8 cột theo thứ tự: `group_name`, `group_url`, `content_url`, `name`, `profile_url`, `source_type`, `published_at_text`, `text_excerpt`. Collector chỉ xuất một file raw/all cho mỗi group; các điểm số và trường phân loại được giữ nội bộ để bước merge/QA downstream tạo `leads`/`audit` khi cần. `published_at_text` được ghi thành ISO timestamp khi Facebook cung cấp đủ thông tin; nếu không phân giải được thì giữ text gốc để tránh đoán sai ngày.

Công cụ không mở từng profile, không tìm email/số điện thoại và không gọi endpoint nội bộ của Facebook.

## Cách chạy từ spreadsheet danh sách group

1. Mở spreadsheet chứa danh sách group Facebook (như bảng có các cột `TÊN HỘI NHÓM` và `LINK`) trên Edge. Kiểm tra các ô link trỏ tới `facebook.com/groups/...`.
2. Với từng dòng có link group, mở link đó trong một tab Facebook riêng. Không chạy bộ quét khi vẫn đang ở spreadsheet.
3. Trong tab group, mở **Discussion** và chọn cách sắp xếp bài mới nhất nếu Facebook hiển thị tùy chọn này.
4. Mở Developer Tools → **Console**, sao chép toàn bộ nội dung `fb-group-lead-pilot.js`, dán vào Console rồi nhấn Enter.
5. Chờ đến khi quét xong hoặc bấm **Dừng & xuất CSV**. Collector tải một file raw/all; nếu đổi tên theo group/ID, giữ tiền tố `fb_group_scan_<days>d_`, ví dụ `fb_group_scan_30d_20261006_group123.csv`.
6. Quay lại spreadsheet, mở link group kế tiếp và lặp lại từ bước 3.
7. Sau khi quét hết danh sách, giữ các file `scan` raw theo từng group. Không cần tự khử trùng lặp bằng tay nếu dùng bộ gom ở bước kế tiếp; bộ gom dùng profile/post/source/nội dung để khử trùng lặp và vẫn giữ các tài khoản ẩn danh.
8. Có thể dùng bộ gom chuẩn hóa:

```powershell
node .\merge-results.js .\results\30d_YYYYMMDD 30
node .\merge-results.js .\results\30d_YYYYMMDD 30 --classify
```

Bộ gom là bước tùy chọn cho các đợt mới: giữ lại danh tính, chuẩn hóa nội dung, suy ra bài/bình luận khi file nguồn không có permalink bình luận, loại dòng ngoài khoảng ngày và mặc định chỉ xuất `repaired_all` cùng `quality_report`. Classification là bước riêng và chỉ tạo `classified`, `repaired_leads`, `repaired_audit` khi thêm `--classify`. Nó chỉ tạo file mới, không sửa file CSV nguồn. Nếu quét 365 ngày, thay cả thư mục và tham số cuối thành `365`.

Luồng spreadsheet ở trên là legacy/manual. Luồng batch chính đọc `checkpoints.json`, tự chạy tuần tự các group đã bật và vẫn giữ spreadsheet CSV qua `--groups-file` để tương thích.

## Checkpoint quét hằng ngày

- Lần quét đầu tiên dùng `days` (mặc định 30 ngày).
- Checkpoint chính được lưu trong `checkpoints.json` ở thư mục dự án; `localStorage` của Edge chỉ còn là cơ chế dự phòng cho các lượt chạy cũ.
- Batch/browser runner tự inject map checkpoint từ `checkpoints.json` trước khi chạy collector và tự ghi checkpoint cùng `last_run` sau lượt tự nhiên có `checkpoint_saved=true`.
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
node .\checkpoint-tools.js record-run "https://www.facebook.com/groups/<group-id>/" "zero_result_after_checkpoint" "2026-10-07T01:39:00.000Z" 120 0 0 0 "Tên group"
node .\checkpoint-tools.js export-map
```

- Runner inject toàn bộ map checkpoint (kể cả giá trị `null`) vào `window.__FB_GROUP_CHECKPOINTS__`; khi đó file là nguồn chính và checkpoint cũ trong `localStorage` không ghi đè được giá trị từ file.
- Runner đọc `window.__FB_GROUP_LEAD_PILOT_LAST_RUN__`; chỉ `checkpoint_saved=true` mới tiến checkpoint. `stopped` và `no_records_seen` giữ nguyên mốc cũ.
- `last_run` được ghi cùng checkpoint mới để truy vết trạng thái, số record và `run_id`.
- Đổi profile hoặc xóa dữ liệu site không còn làm mất checkpoint chính trong dự án, nhưng vẫn có thể làm mất fallback `localStorage`.

Khi hoàn thành, trình duyệt tải một file scan và manifest tương ứng:

- `fb_group_scan_<days>d_*.csv`: toàn bộ dòng raw/all của một group, kể cả dòng sẽ được đưa vào audit.
- `fb_group_scan_<days>d_*.manifest.json`: metadata ISO UTC của cùng lượt chạy (`group_url`, `group_name`, `run_id`, thời gian, `row_count`, `status`, `output_file`). Lượt không có dòng dùng `status=zero_result`.
- `merge-results.js`: bước downstream raw-preserving; thêm `--classify` nếu cần tạo `classified`, `repaired_leads`, `repaired_audit` và `quality_report`.

Kể cả khi một nhóm không có dòng mới, script vẫn tải file scan chỉ có header. Vì vậy có thể phân biệt nhóm đã quét nhưng `zero result` với nhóm chưa chạy.

## Nhập file tải xuống

Sau khi tải xong cả CSV và manifest, chạy ingestion từ thư mục Downloads (hoặc path khác):

```powershell
node .\ingest-downloads.js "C:\Users\<user>\Downloads" .\results
```

Ingestion chỉ nhận cặp `fb_group_scan_*.csv` + manifest tương ứng, kiểm tra đúng 8 field trên từng dòng, `row_count` và khớp `group_url`/`group_name`, bỏ qua file thiếu manifest hoặc còn đuôi tải tạm, rồi copy không phá hủy vào `results\<run_id>\raw`. Chạy lại cùng nguồn là idempotent; kết quả được ghi ở `results\ingestion_report.json` và từng run có `ingestion_report.json` riêng.

## Browser Runner Phase 1

Runner dùng Edge CDP với profile riêng, không nhập mật khẩu, OTP hoặc CAPTCHA. Nếu Playwright chưa có, runner báo dependency thiếu và không tự cài.

Chuẩn bị profile một lần:

```powershell
node .\browser-runner.js --prepare-profile `
  --cdp-endpoint http://127.0.0.1:9222 `
  --profile-dir "$env:LOCALAPPDATA\Microsoft\Edge\User Data\CodexGroupScraper"
```

Dùng command trong JSON output để mở Edge, đăng nhập thủ công trong profile riêng, rồi chạy một group:

```powershell
node .\browser-runner.js `
  --group-url "https://www.facebook.com/groups/<group-id>/" `
  --collector-path .\fb-group-lead-pilot.js `
  --cdp-endpoint http://127.0.0.1:9222 `
  --days 30 `
  --max-rounds 0 `
  --max-runtime-ms 900000 `
  --results-dir .\results
```

Runner mở group root, đọc `checkpoints.json` (hoặc `--checkpoints-file`), inject checkpoint map và collector local qua CDP, chờ CSV + manifest, ingest không phá hủy rồi merge theo `run_id`. Sau khi hoàn tất an toàn, runner chỉ đóng page/tab do chính nó tạo và không đóng Edge hoặc các tab đang có; khi gặp login wall, checkpoint, CAPTCHA hoặc `needs_user_action`, page được giữ mở để người dùng xử lý. Thiếu dependency trả JSON `error`. Phase 1 chỉ xử lý một group mỗi lần; không tự nhập credential, không xử lý CAPTCHA và không điều khiển spreadsheet.

### Batch Runner Phase 2

`batch-runner.js` mặc định xử lý tuần tự `checkpoints.json`, trong đó `groups` là object keyed by canonical group URL:

```json
{
  "groups": {
    "https://www.facebook.com/groups/<group-id>/": {
      "group_url": "https://www.facebook.com/groups/<group-id>/",
      "group_name": "Tên group",
      "enabled": true,
      "checkpoint": null
    }
  }
}
```

```powershell
node .\batch-runner.js `
  --checkpoints-file .\checkpoints.json `
  --results-dir .\results `
  --days 3 `
  --max-runtime-ms 900000
```

`captureMode=all` là mặc định: collector chỉ áp dụng checkpoint/date window, dọn UI và technical dedupe; noise, seed-like, low-intent và text ngắn vẫn nằm trong scan raw. Classification chỉ là bước sau, dùng `--classify` ở aggregator/merge.

Batch ghi `batch_manifest_<id>.json` trong `results`, gồm hash/path input, thời gian ISO, số group yêu cầu, kết quả từng dòng và bộ đếm trạng thái. Key URL và `group_url` phải cùng canonical; `group_name` bắt buộc; `enabled=false` được ghi `skipped_disabled` và không chạy. CSV có cột `TÊN HỘI NHÓM`/`LINK` vẫn dùng được qua `--groups-file`. Nếu gặp `needs_user_action`, batch dừng an toàn và ghi các group hợp lệ phía sau là `not_run`. Batch không đăng nhập, không nhập credential và không xử lý CAPTCHA.

### Cross-group Aggregation Phase 3

Sau khi batch hoàn tất, tạo bộ master chỉ từ các `run_id` được liệt kê trong batch manifest. Có thể thêm một run hợp lệ được chạy lại bằng `--extra-run-id`:

```powershell
node .\aggregate-results.js `
  --batch-manifest .\results\batch_manifest_<id>.json `
  --results-dir .\results `
  --extra-run-id scan_3d_1791368600975

node .\aggregate-results.js `
  --batch-manifest .\results\batch_manifest_<id>.json `
  --results-dir .\results `
  --classify
```

Aggregator chỉ đọc cặp scan CSV/manifest trong `results\<run_id>\raw`, kiểm tra group, tên file, schema và `row_count`, bỏ qua zero-result khỏi master nhưng vẫn ghi trong report. Mặc định kết quả raw-preserving gồm `fb_group_aggregate_all` và report; các row unresolved-time vẫn nằm trong `all` và được đếm riêng. Thêm `--classify` để tạo thêm `classified`, `leads` và `audit` từ phần date-qualified mà không thay đổi `all`. Các run thiếu artifact, stopped hoặc không hợp lệ được ghi là pending/lỗi; không tự quét hoặc tự đưa run cũ/repaired/smoke vào danh sách.

### Batch Reliability Phase 4

Batch có thể resume bằng manifest trước đó. Các group `completed_with_rows`, `zero_result` và `skipped_*` luôn được reuse; chỉ retry khi nêu rõ trạng thái:

```powershell
node .\batch-runner.js `
  --checkpoints-file .\checkpoints.json `
  --results-dir .\results `
  --resume-manifest .\results\batch_manifest_<previous>.json `
  --retry-status stopped,failed
```

Manifest mới ghi `parent_batch_run_id`, mapping input row/group URL, `execution_counts`, cùng `reused`/`retried`/`new` trên từng group. Input bị đổi mapping sẽ dừng an toàn; manifest có `needs_user_action` chỉ được retry khi ghi rõ `--retry-status needs_user_action`, và login/CAPTCHA vẫn chặn các group còn lại. Staging cleanup là dry-run mặc định:

```powershell
node .\cleanup-staging.js --results-dir .\results
node .\cleanup-staging.js --results-dir .\results --older-than-ms 3600000 --apply
```

Chỉ staging directory cũ, không được tham chiếu và không còn hiện hành mới đủ điều kiện xóa.

### Scheduled Operations Phase 5

`cycle-runner.js` là entry point bounded-cycle cho Task Scheduler/cron. Nó chạy batch rồi aggregate, ghi `cycle_manifest_<id>.json` và không tự tạo lịch hệ thống:

```powershell
node .\cycle-runner.js `
  --checkpoints-file .\checkpoints.json `
  --results-dir .\results `
  --max-runtime-ms 900000 `
  --child-timeout-ms 1020000 `
  --previous-report .\results\aggregate_report_<previous>.json
```

Dùng `--dry-run` để chỉ ghi kế hoạch command, không khởi chạy child/browser. Cycle ghi lineage, config, exit status, batch/aggregate paths, counts và notification summary; needs-user-action, failed, stopped hoặc pending đều được đánh dấu actionable. `monitor-report.js` chỉ tạo JSON so sánh local (`notify`, reasons, nhóm mới/zero-result/failure và quality changes), không gửi notification ra ngoài:

```powershell
node .\monitor-report.js --report .\results\aggregate_report_<current>.json --previous-report .\results\aggregate_report_<previous>.json
```

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
- `no_post_rows_detected` trong quality report là cảnh báo coverage khi nguồn chỉ có comment; không tự tạo post giả để lấp dữ liệu.
