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

Orchestrator là đầu mối duy nhất giao việc, nhận kết quả, chuyển handoff giữa các agent và báo cáo cho người dùng. Các agent không tự ý sửa chồng file hoặc tự push GitHub.

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
- Lưu file `leads` và `audit` theo đúng schema 8 cột.
- Ghi checkpoint và trạng thái run.
- Không sửa code, không chỉnh tay nội dung CSV, không loại dòng để làm đẹp số liệu.

### Output QA

Chỉ đọc code/output và tạo báo cáo QA. Kiểm tra tối thiểu:

- Schema đúng 8 cột.
- `source_type` đúng `post`, `comment` hoặc `reply`.
- `content_url` khớp với loại nguồn.
- Text không còn UI như `Trả lời`, `Like`, `Share`, `Xem thêm`.
- `published_at_text` là ISO timestamp khi parse được.
- Có output hoặc trạng thái rõ cho từng group.
- Không có duplicate bất thường.

### Classifier Evaluator

Chỉ đọc output và classifier. Lấy mẫu độc lập, đánh nhãn đúng/sai, tính precision/recall và đề xuất thay đổi keyword/threshold. Không tự áp dụng thay đổi.

## Luồng một lượt chạy

1. Orchestrator đọc `checkpoints.json`, xác định danh sách group và tạo task.
2. Gửi task cho Script Engineer và Browser Collector nếu cần chạy song song.
3. Browser Collector trả về file, số dòng, group đã xử lý và `run_status`.
4. Orchestrator chuyển output cho Output QA và Classifier Evaluator.
5. Nếu QA fail, Orchestrator gửi lỗi có bằng chứng cho Script Engineer; không sửa trực tiếp ở QA.
6. Nếu classifier có false positive/false negative đáng kể, Evaluator chỉ đề xuất; Orchestrator quyết định có tạo task sửa hay không.
7. Orchestrator chạy lại test, kiểm tra diff và tổng hợp báo cáo.
8. Chỉ sau khi tất cả gate pass, Release Agent/Orchestrator mới commit và push.

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

`leads` và `audit` vẫn phải được tải kể cả khi file chỉ có header. Không có file không được xem là `zero result`; đó là trạng thái chưa xác định.

## Format báo cáo handoff

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
