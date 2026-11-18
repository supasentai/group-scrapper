# Quy trình điều phối multi-agent

Tài liệu này là quy ước làm việc chung cho các session của dự án `group-scrapper`.

## Mô hình

```text
Orchestrator
  ├── Script Engineer
  ├── Browser Collector
  ├── Output QA
  └── Classifier Evaluator
```

Orchestrator là đầu mối giao việc, nhận kết quả và báo cáo cho người dùng. Riêng Collector được người dùng cho phép tự bàn giao batch đã kiểm tra sang Aggregate theo mục bên dưới. Các agent không tự ý sửa chồng file hoặc tự push GitHub.

## Vai trò và phạm vi

### Orchestrator

- Chia task và đặt tiêu chí hoàn thành.
- Gửi prompt cho worker, chờ kết quả và chuyển kết quả sang worker tiếp theo.
- Kiểm tra acceptance gate trước khi cho phép release.
- Quyết định tiếp tục sửa, chạy lại scan, chấp nhận output hoặc yêu cầu human review.
- Là agent duy nhất được phép điều phối commit/push.

### Script Engineer

Được sửa:

- `fb-group-lead-pilot.js`
- `checkpoint-tools.js`
- `test-classifier.js`
- Tài liệu kỹ thuật liên quan.

Không được tự sửa CSV trong `results/`, tự đổi threshold hoặc push GitHub nếu chưa được Orchestrator giao.

### Browser Collector

- Chạy script trên các group được giao.
- Lưu một file `scan` raw/all theo đúng schema 8 cột; không tự chia `leads`/`audit` ở bước thu thập.
- Lưu thêm manifest JSON tương ứng, dùng ISO UTC và có `run_id`, `row_count`, `status`, `output_file`.
- Ghi checkpoint và trạng thái run.
- Không sửa code, không chỉnh tay nội dung CSV, không loại dòng để làm đẹp số liệu.

### Output QA

Chỉ đọc code/output và tạo báo cáo QA. Kiểm tra tối thiểu:

- Schema đúng 8 cột.
- `source_type` đúng `post`, `comment` hoặc `reply`.
- `content_url` khớp với loại nguồn.
- Text không còn UI như `Trả lời`, `Like`, `Share`, `Xem thêm`.
- Quality report phải nêu `ui_chrome_contamination` nếu raw text còn prefix/status UI sau cleanup.
- `published_at_text` là ISO timestamp khi parse được.
- Có output hoặc trạng thái rõ cho từng group.
- Không có duplicate bất thường.

### Classifier Evaluator

Chỉ đọc output và classifier. Lấy mẫu độc lập, đánh nhãn đúng/sai, tính precision/recall và đề xuất thay đổi keyword/threshold. Không tự áp dụng thay đổi.

## Luồng một lượt chạy

1. Orchestrator đọc `checkpoints.json`, dùng các key URL canonical làm danh sách group, bỏ qua record `enabled=false` và tạo task.
2. Gửi task cho Script Engineer và Browser Collector nếu cần chạy song song.
3. Browser Collector trả về cặp file scan raw/manifest, số dòng, group đã xử lý và `run_status`.
4. Orchestrator chạy `node .\ingest-downloads.js <downloads-dir> .\results` để đưa dữ liệu vào `results\<run_id>\raw`; ingestion không xóa file nguồn và có idempotency.
5. Orchestrator chuyển output cho Output QA và Classifier Evaluator.
6. Nếu QA fail, Orchestrator gửi lỗi có bằng chứng cho Script Engineer; không sửa trực tiếp ở QA.
7. Nếu classifier có false positive/false negative đáng kể, Evaluator chỉ đề xuất; Orchestrator quyết định có tạo task sửa hay không.
8. Orchestrator chạy lại test, kiểm tra diff và tổng hợp báo cáo.
9. Chỉ sau khi tất cả gate pass, Release Agent/Orchestrator mới commit và push.

## Trạng thái run bắt buộc

Mỗi group phải có một trong các trạng thái:

- `completed_with_rows`: đã quét và có dòng sau filter.
- `zero_result_after_checkpoint`: đã quét nhưng không có dòng mới.
- `no_records_seen`: DOM không trả về bản ghi; không được tiến checkpoint.
- `stopped`: người dùng dừng thủ công; không được tiến checkpoint.

Ghi trạng thái bằng:

```powershell
node .\checkpoint-tools.js record-run `
  "https://www.facebook.com/groups/<group-id>/" `
  "zero_result_after_checkpoint" `
  "2026-10-07T01:39:00.000Z" 120 0 0 0 "Tên group"
```

File scan vẫn phải được tải kể cả khi chỉ có header. Không có file không được xem là `zero result`; đó là trạng thái chưa xác định. Việc chia `leads`/`audit` chỉ thực hiện ở bước merge/QA downstream.

Manifest có `status=zero_result` khi lượt chạy không có dòng; `status=completed` khi có dữ liệu hoàn tất. Lượt bị dừng thủ công có dữ liệu partial dùng `status=stopped` và không được ingestion nhận; lượt dừng khi chỉ có header vẫn là `zero_result`.

`no_post_rows_detected` là warning về coverage khi run chỉ thu được comment; không được tự sinh post row.

### Browser Runner Phase 1

Runner tùy chọn `browser-runner.js` kết nối Edge qua CDP bằng profile riêng. Trước khi chạy, người dùng phải mở và kiểm tra phiên CDP bằng `Invoke-RestMethod http://127.0.0.1:<port>/json/version`; quy ước hiện tại hỗ trợ hai cổng 9222 và 9223, mỗi cổng dùng một `user-data-dir` riêng theo `cdp-profiles.json`. Chỉ khi endpoint trả về `Browser`, `Protocol-Version` và `webSocketDebuggerUrl` mới được bắt đầu batch. Batch nhận danh sách endpoint qua `--cdp-endpoints` và tự thử vòng tròn 9222 → 9223 → 9222. Người dùng đăng nhập thủ công một lần trong 2 profile, sau đó runner mới mở group root, đọc `checkpoints.json` và inject map vào `window.__FB_GROUP_CHECKPOINTS__` trước collector. Runner kiểm tra limit và quyền truy cập group trước collector; hard/soft limit trả `profile_limited`, còn chưa được duyệt vào group trả `not_member`. `profile_limited` vô hiệu hóa profile cho phần còn lại của batch; `not_member` chỉ vô hiệu hóa cặp profile/group hiện tại. Runner đối chiếu kết quả và manifest, chỉ ghi checkpoint và `last_run` atomically sau lượt tự nhiên có record, boundary xác minh và checkpoint đầu vào không đổi; chỉ báo `checkpoint_saved=true` sau khi ghi file thành công. Lỗi `localStorage` được ghi thành cảnh báo, không chặn ghi file. Stopped/no-records/boundary chưa xác minh/profile-limited/not-member/no-available-profile hoặc lỗi ghi file giữ nguyên checkpoint; batch đánh dấu lỗi checkpoint là `failed` để retry rõ ràng. Runner không nhập credential/OTP, không xử lý CAPTCHA và trả `needs_user_action` khi gặp login wall/checkpoint; page do runner tạo được giữ mở để người dùng xử lý. Sau completion, zero-result, stopped hoặc lỗi an toàn, runner chỉ đóng page/tab do chính nó tạo, không đóng browser Edge hay các tab khác. Phase 1 chỉ chạy một group, chờ đúng cặp CSV/manifest, ingest idempotent và merge theo `run_id`.

### Batch Runner Phase 2

`batch-runner.js` mặc định nhận `checkpoints.json`, chạy các group `enabled` theo thứ tự, tuần tự từng child process. CSV có cột `TÊN HỘI NHÓM` và `LINK` vẫn được hỗ trợ legacy bằng `--groups-file`:

```powershell
node .\batch-runner.js --checkpoints-file .\checkpoints.json --results-dir .\results --days 3 --max-runtime-ms 900000
```

Batch phải tạo một `batch_manifest_<id>.json` có `input_path`, `input_hash`, `input_type`, danh sách `cdp_endpoints`, timestamp ISO, `requested_group_count`, `groups` và `counts`. Với JSON, key URL phải canonical và khớp `group_url`; `group_name` bắt buộc; `enabled=false` được ghi `skipped_disabled`. Với CSV legacy, dòng trống, URL sai và URL trùng lần lượt là `skipped_blank`, `skipped_invalid`, `skipped_duplicate`. Chỉ manifest hợp lệ do browser runner trả về với `status=zero_result` mới được ghi `zero_result`; thiếu artifact là `failed`. Khi gặp `needs_user_action`, batch dừng để người dùng xử lý thủ công và đánh dấu các group còn lại là `not_run`. Với `profile_limited` hoặc `not_member`, batch tự thử endpoint tiếp theo; nếu không còn profile truy cập được thì ghi `no_available_profile`, không tiến checkpoint. Không tự nhập credential và không bypass CAPTCHA.

`allowed_profile_ports` trong từng group của `checkpoints.json` là danh sách profile được phép chạy theo phân công hiện hành. Batch chỉ thử các cổng trong danh sách, kể cả khi đầu vào là CSV legacy có group trùng với file checkpoint; group bị tắt không có profile được phép. Nếu không còn cổng phù hợp, ghi `no_available_profile` và giữ nguyên checkpoint. Group không có trường này giữ cách chọn profile cũ để tương thích dữ liệu legacy. Phân công ngày 18/11/2026 gồm 19 group cho 9222, trong đó 16 group cũng dùng được 9223; ba group chỉ 9222 là `2038671846493827`, `670648272394036`, `290533306574241`.

Khi chạy trực tiếp `browser-runner.js` hoặc công cụ khác ngoài batch, người điều phối phải đối chiếu `enabled` và `allowed_profile_ports` trước khi chọn profile; cơ chế lọc cổng tự động ở trên thuộc về `batch-runner.js`.

Collector mặc định chạy `captureMode=all`: chỉ áp dụng date/checkpoint window, UI cleanup và technical dedupe; không dùng segment, intent, authenticity hoặc seeding để loại row. Classification chỉ chạy explicit ở bước aggregate/merge với `--classify`.

### Cross-group Aggregation Phase 3

`aggregate-results.js` là bước downstream xác định phạm vi bằng batch manifest và mặc định giữ raw/all:

```powershell
node .\aggregate-results.js `
  --batch-manifest .\results\batch_manifest_<id>.json `
  --results-dir .\results `
  --extra-run-id scan_3d_1791368600975
```

Chỉ các `run_id` trong batch manifest hoặc được nêu rõ bằng `--extra-run-id` mới được resolve. Aggregator tìm đúng cặp scan CSV/manifest trong `results\<run_id>\raw`, kiểm tra `group_url`, `group_name`, `output_file`, schema và `row_count`, rồi tạo ba tầng đầu ra: `fb_group_aggregate_all` giữ nguyên mọi dòng raw; `fb_group_aggregate_deduped` áp dụng checkpoint/time-window và technical dedup; `fb_group_aggregate_backfilled` áp dụng post-root/backfill policy sau dedup, mỗi post root một dòng và comment fallback khi không có root hợp lệ. `posts`/`comments_context` được tách từ tầng deduped, không dùng để ghi đè raw. Dùng `--classify` mới tạo thêm `classified/leads/audit` từ tầng backfilled, không thay đổi `all`. `zero_result` không tạo row trong master nhưng vẫn được tính; stopped, pending, missing hoặc mismatched artifacts nằm trong pending/issue report. Không đọc repaired outputs, old smoke runs hoặc thư mục ngoài danh sách run IDs.

### Quy trình downstream theo yêu cầu người dùng

Các bước lọc nội dung và formatting chỉ thực hiện khi người dùng yêu cầu riêng;
handoff tự động chỉ ủy quyền aggregate. Chỉ gộp batch hoặc so trùng với batch
trước khi người dùng yêu cầu; báo nguy cơ chồng khoảng thời gian nếu có.

1. **Đầu vào và thời gian:** đối soát manifest, hash, từng run được chọn, alias,
   checkpoint đầu vào và các mốc người dùng yêu cầu; giữ raw và comment context,
   không cleanup, không browser/network backfill nếu chưa được yêu cầu. Mốc
   bắt đầu/kết thúc phải ghi rõ có bao gồm hay không; khi cần, mặc định khoảng
   liên tiếp dùng `[đầu, cuối)`. Không suy đoán timestamp từ nội dung bài. Ghi
   riêng dòng thiếu thời gian hoặc có khoảng thời gian tương đối giao với mốc;
   báo số lượng và đường dẫn. Chỉ đưa chúng vào file khi người dùng yêu cầu,
   đánh dấu chưa xác định và không khẳng định thuộc khoảng; khi tách BEFORE/
   AFTER, ghi rõ khả năng trùng nếu ghép file. Những group pending không phải
   zero-result; giữ nguyên bằng chứng về checkpoint runner và checkpoint thủ công.
2. **Một dòng cho mỗi bài:** sau dedup kỹ thuật từng URL nội dung, đối chiếu
   toàn bộ post và comment đủ điều kiện theo URL nhóm canonical và URL post
   gốc canonical. Giữ post gốc hợp lệ nếu có; nếu không có, giữ một comment
   đại diện mới nhất theo thời gian đáng tin cậy, dùng thứ tự nguồn để phá hòa.
   Với thời gian không so sánh được, dùng quy tắc ổn định, ghi rõ giới hạn và
   không tự gán thời gian. Không coi nội dung comment là nội dung post, không
   đổi `source_type`; giữ toàn bộ comment trong `comments_context` và tạo audit
   các dòng không được chọn. Nếu không xác định được URL post gốc, giữ riêng
   để xem lại thay vì gộp dựa trên phỏng đoán. Nếu post chưa rõ thời gian được
   chọn thay comment có thời gian trong khoảng, đánh dấu thời gian post chưa
   xác định và lưu liên kết tới comment để không nhầm chứng cứ thời gian.
3. **Lọc nội dung:** chỉ đánh giá dòng `post`, không dùng nội dung comment để
   quyết định loại post. Loại các post khen kết quả/trải nghiệm, đang hậu phẫu
   hoặc hồi phục, đã đặt lịch/sắp làm phẫu thuật, và post mô tả hành động đã
   xảy ra của bác sĩ người viết theo tiêu chí “my doctor + V-ed”. Giữ comment
   đại diện qua bước lọc này; chỉ lọc comment khi người dùng yêu cầu rõ. Giữ
   post thiếu ngữ cảnh, ghi vào danh sách cần xem lại; lưu các dòng loại và lý
   do. Theo yêu cầu ngày 18/11/2026, đưa laser CO2 (kể cả fractional CO2 và
   CO₂ laser) vào phạm vi dịch vụ cần tìm; bài hỏi nơi thực hiện, chi phí hoặc
   xin giới thiệu vẫn được xét theo các tiêu chí nội dung và ngoại lệ đã chốt.
   Không tự thêm bộ lọc quảng cáo hay tiêu chí nội dung khác.
4. **Formatting:** xuất đúng sáu cột `Tên nhóm`, `URL nhóm`, `URL nội dung`,
   `Tên tài khoản`, `Thời điểm đăng`, `Trích đoạn nội dung`. Dùng một mốc tính
   thời gian tương đối là thời điểm thực hiện formatting, trừ khi người dùng
   chỉ định mốc khác. Sắp xếp theo độ tuổi số tăng dần (mới nhất trước), không
   sắp chữ; nhãn thời gian ước tính phải có thể truy vết. Dòng không xác định
   thời gian đặt cuối, ghi rõ trạng thái và nhãn gốc nếu có.
5. **Báo cáo và kiểm tra:** nêu số dòng raw, ngoài khoảng, chưa rõ thời gian,
   dedup kỹ thuật, post/comment context, trùng theo URL post, post/comment đại
   diện, loại nội dung và cuối cùng; nêu group zero-result, pending, thiếu URL,
   backfill thất bại và checkpoint thủ công khi có. Kiểm tra output, hash input,
   số dòng và URL post duy nhất; cung cấp file kết quả và audit cần thiết.

### Batch Reliability Phase 4

Batch resume phải dùng manifest trước đó và giữ nguyên mapping `input_row` + canonical `group_url`:

```powershell
node .\batch-runner.js --groups-file .\groups.csv --results-dir .\results `
  --resume-manifest .\results\batch_manifest_<previous>.json `
  --retry-status stopped,failed
```

`completed_with_rows`, `zero_result` và `skipped_*` không bao giờ chạy lại. `failed`, `stopped`, `not_run` và `needs_user_action` chỉ chạy lại khi được liệt kê trong `--retry-status`; nếu manifest cũ có `needs_user_action` mà không có quyền retry rõ ràng, batch fail-safe và không chạy child nào. Login/CAPTCHA từ lượt mới vẫn dừng phần còn lại thành `not_run`. Manifest resume mới phải ghi `parent_batch_run_id`, action reuse/retry/new và execution counts.

`cleanup-staging.js` chỉ xóa khi có `--apply`; mặc định là dry-run. Utility chỉ xét `.runner-staging-*` cũ hơn ngưỡng, bỏ qua directory đang hiện hành hoặc được tham chiếu trong artifact/report.

### Scheduled Operations Phase 5

Task Scheduler/cron chỉ nên gọi một cycle bounded; không tạo system automation từ repo:

```powershell
node .\cycle-runner.js --checkpoints-file .\checkpoints.json --results-dir .\results `
  --max-runtime-ms 900000 --child-timeout-ms 1020000 `
  --previous-report .\results\aggregate_report_<previous>.json
```

`cycle-runner.js` tuần tự gọi batch và aggregate, ghi `cycle_manifest_<id>.json` với lineage, command/config, timestamps, paths, exit statuses, counts và notification summary. `--dry-run` chỉ lập kế hoạch, không gọi child/browser. Needs-user-action, failed, stopped và pending là actionable/fail-safe; không tự login, bypass CAPTCHA hoặc gửi notification. `monitor-report.js` so sánh report hiện tại với report trước đó và chỉ trả JSON machine-readable gồm `notify`, reasons, nhóm mới, zero-result, failures và quality changes.

## Format báo cáo handoff

### Automatic Collector-to-Aggregate handoff

Người dùng đã cấp quyền thường trực ngày 03/11/2026 trong chat Orchestrator
`01a175c0-ecad-7743-9013-476730013b56`: "setup cho collector khi gom data về rồi thì tự động bàn giao cho Aggregate downstream formatting".
Quyền này thay thế quy ước cũ yêu cầu Collector chờ lệnh bàn giao riêng.

- Đích duy nhất: chat **Aggregate downstream formatting**, host `local`, thread
  `01a175b3-4470-7571-a7eb-fc766f05f8e3`.
- Sau khi hoàn tất batch được giao, Collector kiểm tra schema 8 cột, số dòng,
  hash CSV/manifest, mapping group/alias, selected run duy nhất cho mỗi group,
  checkpoint đầu vào thực tế và coverage. Chỉ bàn giao batch hoàn chỉnh sau khi
  tất cả group được giao có trạng thái được đối soát: completed hoặc zero-result
  đã xác minh. `no_records_seen`, boundary chưa xác minh, stopped, failed hoặc
  needs-user-action không phải zero-result thành công; giữ checkpoint liên quan
  và báo người dùng. Chỉ bàn giao partial nếu người dùng đã yêu cầu rõ.
- Giữ raw bất biến, snapshot checkpoint trước batch và báo cáo validation. Nếu
  có mốc kết thúc cố định, bàn giao đúng các run bounded đã kiểm tra, kèm quy ước
  đầu/cuối khoảng thời gian và audit ngoài khoảng/unresolved riêng.
- Dùng tool `read_thread` đọc trạng thái chat đích rồi
  `send_message_to_thread` gửi yêu cầu **aggregate batch này**, không cần hỏi lại
  người dùng. Nội dung phải có đường dẫn tuyệt đối của batch root, complete batch
  manifest, validation report, checkpoint snapshot; batch ID và SHA-256 manifest;
  selected run/group count, số dòng post/comment, zero-result, cảnh báo, alias và
  khung thời gian. Không gửi raw text bài viết trong tin nhắn nếu không cần thiết.
- Yêu cầu Aggregate chỉ dùng selected runs trong complete manifest, không gộp
  attempt lỗi/batch cũ; kiểm tra hash/checkpoint/time window; giữ comment context
  và unresolved riêng; chạy offline với `--no-cleanup` để giữ toàn bộ input.
  Không tự lọc nội dung, formatting, mở browser/network backfill, sửa source hoặc
  checkpoint, commit/push. Các bước đó cần yêu cầu riêng của người dùng.
- Ghi `aggregate_handoff.json` trong batch root sau khi tool xác nhận gửi thành
  công: batch ID, manifest path/hash, target host/thread, sent_at UTC và tham chiếu
  phản hồi tool nếu có. Trước khi gửi, đối chiếu receipt và lịch sử chat đích để
  không bàn giao lại cùng batch/manifest hash. Nếu batch đã được gửi hoặc đã
  aggregate thì chỉ báo trạng thái hiện có. Manifest thay đổi sau rerun cần chỉ rõ
  bản mới thay thế bản cũ, tránh merge cả hai.
- Nếu tool gửi không khả dụng hoặc lỗi, không ghi receipt thành công; lưu trạng
  thái pending/lỗi và báo người dùng. Nếu kết quả gửi không chắc chắn, kiểm tra
  lịch sử chat đích trước khi thử lại. Không giả lập bằng sửa database chat hoặc
  gọi API nội bộ không được hỗ trợ.
- Báo người dùng "đã bàn giao" sau khi xác nhận gửi; chỉ báo "đã aggregate" khi
  đã đọc được kết quả hoàn tất từ chat đích. Quy tắc này không tạo lịch chạy batch
  mới và không tự chạy lại batch lịch sử.

Mỗi agent trả kết quả theo mẫu:

```text
ROLE: <tên vai trò>
STATUS: <pass|fail|blocked>
INPUTS: <file/task đã nhận>
OUTPUTS: <file hoặc artifact đã tạo>
METRICS: <số dòng, số group, test, tỷ lệ lỗi>
FINDINGS: <phát hiện chính>
NEXT_ACTION: <việc Orchestrator cần giao tiếp>
MUTATIONS: <file đã sửa, hoặc none>
```

## Quy tắc an toàn

- Không để hai agent cùng sửa một file trong cùng thời điểm.
- Không dùng output raw có thông tin profile làm fixture test; phải ẩn danh hoặc rút gọn.
- Không coi classifier là xác minh danh tính.
- Không tự động liên hệ người dùng Facebook.
- Không push khi còn lỗi QA hoặc khi chưa có xác nhận release.
