"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const monitor = require("./monitor-report.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "group-scrapper-monitor-test-"));
try {
  const previous = {
    status: "completed",
    released_groups: [{ group_url: "https://www.facebook.com/groups/alpha/", status: "completed_with_rows" }],
    pending_groups: [],
    quality_flag_counts: { ui_chrome_removed: 1 },
  };
  const unchanged = monitor.compareReports(previous, previous);
  assert.equal(unchanged.notify, false);
  assert.deepEqual(unchanged.reasons, []);
  assert.deepEqual(unchanged.new_groups, []);
  assert.deepEqual(unchanged.failures, []);

  const changed = {
    status: "completed_with_pending",
    released_groups: [{ group_url: "https://www.facebook.com/groups/alpha/", status: "completed_with_rows" }],
    pending_groups: [{ group_url: "https://www.facebook.com/groups/beta/", status: "failed", error: "artifact missing" }],
    quality_flag_counts: { ui_chrome_removed: 2, ui_chrome_contamination: 1 },
  };
  const actionable = monitor.compareReports(changed, previous);
  assert.equal(actionable.notify, true);
  assert.ok(actionable.reasons.includes("new_failures"));
  assert.ok(actionable.reasons.includes("quality_flags_changed"));
  assert.equal(actionable.failures[0].group_url, "https://www.facebook.com/groups/beta/");
  assert.deepEqual(actionable.quality_changes.added, ["ui_chrome_contamination"]);
  assert.deepEqual(actionable.quality_changes.increased, [{ flag: "ui_chrome_removed", from: 1, to: 2 }]);

  const previousPath = path.join(tempDir, "previous.json");
  const aggregatePath = path.join(tempDir, "aggregate.json");
  const cyclePath = path.join(tempDir, "cycle.json");
  fs.writeFileSync(previousPath, `${JSON.stringify(previous)}\n`, "utf8");
  fs.writeFileSync(aggregatePath, `${JSON.stringify(changed)}\n`, "utf8");
  fs.writeFileSync(cyclePath, `${JSON.stringify({ aggregate_report_path: aggregatePath, status: "completed_with_pending" })}\n`, "utf8");
  const parsed = monitor.compareReports(cyclePath, previousPath);
  assert.equal(parsed.current_status, "completed_with_pending");
  assert.equal(parsed.previous_status, "completed");
  assert.equal(parsed.notify, true);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("Monitor report tests passed.");
