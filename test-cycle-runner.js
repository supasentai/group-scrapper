"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cycle = require("./cycle-runner.js");
const monitor = require("./monitor-report.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "group-scrapper-cycle-test-"));
try {
  const groupsFile = path.join(tempDir, "groups.csv");
  const resultsDir = path.join(tempDir, "results");
  fs.writeFileSync(groupsFile, "TÊN HỘI NHÓM,LINK\nAlpha Group,https://www.facebook.com/groups/alpha/\n", "utf8");
  const baseArgs = ["--groups-file", groupsFile, "--results-dir", resultsDir, "--days", "3", "--child-timeout-ms", "1000"];

  let dryCalls = 0;
  const dry = cycle.runCycle(cycle.parseArgs([...baseArgs, "--dry-run"]), {
    now: "2026-10-07T12:00:00.000Z",
    finishedAt: "2026-10-07T12:00:01.000Z",
    runChild: () => { dryCalls += 1; throw new Error("dry-run must not invoke child"); },
  });
  assert.equal(dry.status, "dry_run");
  assert.equal(dry.notification.notify, false);
  assert.deepEqual(dry.notification.reasons, ["dry_run_plan"]);
  assert.equal(dryCalls, 0);
  assert.equal(fs.existsSync(dry.manifest_path), true);

  const runCycleWithChildren = (args, behavior, now) => cycle.runCycle(cycle.parseArgs([...baseArgs, ...args]), {
    now,
    finishedAt: new Date(new Date(now).getTime() + 1000),
    runChild: behavior,
  });

  let completedCalls = 0;
  const completed = runCycleWithChildren([], (command) => {
    completedCalls += 1;
    if (completedCalls === 1) {
      const batchManifestPath = path.join(resultsDir, "batch-complete.json");
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.writeFileSync(batchManifestPath, JSON.stringify({ batch_run_id: "batch-complete", status: "completed", groups: [] }), "utf8");
      return { exit_code: 0, timed_out: false, json: { status: "completed", manifest_path: batchManifestPath, counts: { completed_with_rows: 1 } } };
    }
    const reportPath = path.join(resultsDir, "aggregate-complete.json");
    fs.writeFileSync(reportPath, JSON.stringify({ status: "completed", released_groups: [], pending_groups: [], quality_flag_counts: {} }), "utf8");
    return { exit_code: 0, timed_out: false, json: { status: "completed", outputs: { report_json: reportPath }, raw_rows: 1, deduped_rows: 1, in_window_rows: 1 } };
  }, "2026-10-07T12:01:00.000Z");
  assert.equal(completed.status, "completed");
  assert.equal(completedCalls, 2);
  assert.equal(completed.batch.status, "completed");
  assert.equal(completed.aggregate.status, "completed");
  assert.equal(completed.notification.notify, false);

  let failedStatusCalls = 0;
  const failedStatusCycle = runCycleWithChildren([], () => {
    failedStatusCalls += 1;
    if (failedStatusCalls === 1) {
      const batchManifestPath = path.join(resultsDir, "batch-status-failed.json");
      fs.writeFileSync(batchManifestPath, JSON.stringify({ batch_run_id: "batch-status-failed", status: "completed", groups: [] }), "utf8");
      return { exit_code: 0, timed_out: false, json: { status: "completed", manifest_path: batchManifestPath } };
    }
    return { exit_code: 0, timed_out: false, json: { status: "failed" } };
  }, "2026-10-07T12:01:30.000Z");
  assert.equal(failedStatusCycle.status, "failed");
  assert.equal(failedStatusCycle.notification.notify, true);
  assert.ok(failedStatusCycle.notification.reasons.includes("aggregate_status_failed"));

  let actionableCalls = 0;
  const actionable = runCycleWithChildren([], (command) => {
    actionableCalls += 1;
    if (actionableCalls === 1) {
      const batchManifestPath = path.join(resultsDir, "batch-actionable.json");
      fs.writeFileSync(batchManifestPath, JSON.stringify({ batch_run_id: "batch-actionable", status: "needs_user_action", groups: [] }), "utf8");
      return { exit_code: 2, timed_out: false, json: { status: "needs_user_action", manifest_path: batchManifestPath, needs_user_action: "login required" } };
    }
    const reportPath = path.join(resultsDir, "aggregate-actionable.json");
    fs.writeFileSync(reportPath, JSON.stringify({ status: "completed_with_pending", released_groups: [], pending_groups: [{ group_url: "https://www.facebook.com/groups/alpha/", status: "needs_user_action" }], quality_flag_counts: {} }), "utf8");
    return { exit_code: 2, timed_out: false, json: { status: "completed_with_pending", outputs: { report_json: reportPath } } };
  }, "2026-10-07T12:02:00.000Z");
  assert.equal(actionable.status, "action_required");
  assert.equal(actionableCalls, 2);
  assert.equal(actionable.notification.notify, true);
  assert.ok(actionable.notification.reasons.includes("batch_needs_user_action"));

  const previousReport = {
    status: "completed",
    released_groups: [{ group_url: "https://www.facebook.com/groups/alpha/", status: "completed_with_rows" }],
    pending_groups: [],
    quality_flag_counts: { ui_chrome_removed: 1 },
  };
  const currentReport = {
    status: "completed",
    released_groups: [
      { group_url: "https://www.facebook.com/groups/alpha/", status: "completed_with_rows" },
      { group_url: "https://www.facebook.com/groups/beta/", status: "completed_with_rows" },
      { group_url: "https://www.facebook.com/groups/zero/", status: "zero_result" },
    ],
    pending_groups: [{ group_url: "https://www.facebook.com/groups/fail/", status: "failed" }],
    quality_flag_counts: { ui_chrome_removed: 2, ui_chrome_contamination: 1 },
  };
  const comparison = monitor.compareReports(currentReport, previousReport);
  assert.equal(comparison.notify, true);
  assert.deepEqual(comparison.reasons.sort(), ["new_failures", "new_groups", "new_zero_result_groups", "quality_flags_changed"]);
  assert.deepEqual(comparison.quality_changes.added, ["ui_chrome_contamination"]);
  assert.deepEqual(comparison.quality_changes.increased, [{ flag: "ui_chrome_removed", from: 1, to: 2 }]);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("Cycle runner tests passed.");
