"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const aggregate = require("./aggregate-results.js");
const pilot = require("./fb-group-lead-pilot.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "group-scrapper-aggregate-test-"));
try {
  const resultsDir = path.join(tempDir, "results");
  const batchManifestPath = path.join(tempDir, "batch_manifest.json");
  const groups = [
    { input_row: 2, group_name: "Alpha Group", group_url: "https://www.facebook.com/groups/alpha/", run_id: "run-alpha", status: "completed_with_rows", row_count: 2 },
    { input_row: 3, group_name: "Zero Group", group_url: "https://www.facebook.com/groups/zero/", run_id: "run-zero", status: "zero_result", row_count: 0 },
    { input_row: 4, group_name: "Stopped Group", group_url: "https://www.facebook.com/groups/stopped/", run_id: "run-stopped", status: "stopped", row_count: 1 },
    { input_row: 5, group_name: "Pending Group", group_url: "https://www.facebook.com/groups/pending/", run_id: null, status: "not_run", row_count: null },
    { input_row: 6, group_name: "Duplicate Alpha", group_url: "https://www.facebook.com/groups/alpha/", run_id: null, status: "skipped_duplicate", row_count: null },
    { input_row: 7, group_name: "Missing Group", group_url: "https://www.facebook.com/groups/missing/", run_id: "run-missing", status: "completed_with_rows", row_count: 1 },
  ];
  fs.writeFileSync(batchManifestPath, JSON.stringify({
    batch_run_id: "batch_test",
    input_row_count: groups.length,
    requested_group_count: 5,
    groups,
  }), "utf8");

  function writeRun(runId, groupName, groupUrl, status, rows) {
    const rawDir = path.join(resultsDir, runId, "raw");
    fs.mkdirSync(rawDir, { recursive: true });
    const csvFilename = `fb_group_scan_3d_${runId}.csv`;
    const manifestFilename = `${csvFilename.slice(0, -4)}.manifest.json`;
    fs.writeFileSync(path.join(rawDir, csvFilename), pilot.buildCsv(rows), "utf8");
    fs.writeFileSync(path.join(rawDir, manifestFilename), JSON.stringify({
      group_url: groupUrl,
      group_name: groupName,
      run_id: runId,
      started_at: "2026-10-07T10:00:00.000Z",
      completed_at: "2026-10-07T10:01:00.000Z",
      row_count: rows.length,
      status,
      output_file: csvFilename,
    }), "utf8");
  }

  const alphaRow = {
    group_name: "Alpha Group",
    group_url: "https://www.facebook.com/groups/alpha/",
    content_url: "https://www.facebook.com/groups/alpha/posts/1/",
    name: "Alpha Author",
    profile_url: "https://www.facebook.com/alpha-author/",
    source_type: "post",
    published_at_text: "2026-10-07T09:00:00.000Z",
    text_excerpt: "Tài khoản đã xác minh nổi bật Dr erham.last yearGreat results. I am considering a facelift and need recommendations. Has anyone had this procedure?",
  };
  writeRun("run-alpha", "Alpha Group", "https://www.facebook.com/groups/alpha/", "completed", [alphaRow, { ...alphaRow }]);
  writeRun("run-zero", "Zero Group", "https://www.facebook.com/groups/zero/", "zero_result", []);
  writeRun("run-stopped", "Stopped Group", "https://www.facebook.com/groups/stopped/", "stopped", [{
    ...alphaRow,
    group_name: "Stopped Group",
    group_url: "https://www.facebook.com/groups/stopped/",
    content_url: "https://www.facebook.com/groups/stopped/posts/1/",
  }]);
  writeRun("run-extra", "Extra Group", "https://www.facebook.com/groups/extra/", "completed", [{
    ...alphaRow,
    group_name: "Extra Group",
    group_url: "https://www.facebook.com/groups/extra/",
    content_url: "https://www.facebook.com/groups/extra/posts/1/",
    name: "Extra Author",
    profile_url: "https://www.facebook.com/extra-author/",
    text_excerpt: "I had a facelift and the recovery was difficult.",
  }]);
  fs.mkdirSync(path.join(resultsDir, "run-missing"), { recursive: true });
  fs.writeFileSync(path.join(resultsDir, "run-alpha", "raw", "fb_group_3d_repaired_all.csv"), "must not be selected", "utf8");

  const config = aggregate.parseArgs([
    "--batch-manifest", batchManifestPath,
    "--results-dir", resultsDir,
    "--extra-run-id", "run-extra",
    "--days", "30",
  ]);
  assert.deepEqual(config.extraRunIds, ["run-extra"]);
  const report = aggregate.runAggregate(config, { now: new Date("2026-10-07T12:00:00.000Z") });
  assert.equal(report.status, "completed_with_errors");
  assert.equal(report.input_row_count, 6);
  assert.equal(report.raw_rows, 3);
  assert.equal(report.deduped_rows, 2);
  assert.equal(report.in_window_rows, 2);
  assert.deepEqual(report.source_run_ids.sort(), ["run-alpha", "run-extra", "run-stopped", "run-zero"]);
  assert.equal(report.artifact_issues.length, 1);
  assert.equal(report.artifact_issues[0].run_id, "run-missing");
  assert.equal(report.group_counts_by_status.completed_with_rows, 2);
  assert.equal(report.group_counts_by_status.zero_result, 1);
  assert.equal(report.group_counts_by_status.stopped, 1);
  assert.equal(report.group_counts_by_status.failed, 1);
  assert.equal(report.group_counts_by_status.not_run, 1);
  assert.equal(report.group_counts_by_status.skipped_duplicate, 1);
  assert.equal(report.released_groups.length, 3);
  assert.equal(report.pending_groups.length, 3);
  for (const output of Object.values(report.outputs)) assert.equal(fs.existsSync(output), true);
  const masterRows = require("./merge-results.js").parseCsv(fs.readFileSync(report.outputs.all, "utf8"));
  assert.equal(masterRows.length, 2);
  assert.ok(masterRows.every((row) => ["Alpha Group", "Extra Group"].includes(row.group_name)));
  assert.ok(masterRows.every((row) => !row.text_excerpt.includes("Tài khoản đã xác minh")));
  const aggregateLead = masterRows.find((row) => row.group_name === "Alpha Group");
  assert.equal(aggregateLead.doctor_name, "Dr erham");
  assert.match(aggregateLead.text_excerpt, /Dr erham\.last year\. Great results\./);
  assert.doesNotMatch(aggregateLead.text_excerpt, /last yearGreat/);

  writeRun("run-rerun", "Stopped Group", "https://www.facebook.com/groups/stopped/", "completed", [{
    ...alphaRow,
    group_name: "Stopped Group",
    group_url: "https://www.facebook.com/groups/stopped/",
    content_url: "https://www.facebook.com/groups/stopped/posts/2/",
  }]);
  const replacementBatchManifestPath = path.join(tempDir, "batch_manifest_replacement.json");
  fs.writeFileSync(replacementBatchManifestPath, JSON.stringify({
    input_row_count: 1,
    requested_group_count: 1,
    groups: [{
      input_row: 4,
      group_name: "Stopped Group",
      group_url: "https://www.facebook.com/groups/stopped/",
      run_id: "run-stopped",
      status: "stopped",
      row_count: 1,
    }],
  }), "utf8");
  const replacementReport = aggregate.runAggregate(aggregate.parseArgs([
    "--batch-manifest", replacementBatchManifestPath,
    "--results-dir", resultsDir,
    "--extra-run-id", "run-rerun",
  ]), { now: new Date("2026-10-07T12:00:00.000Z") });
  assert.equal(replacementReport.status, "completed");
  assert.deepEqual(replacementReport.source_run_ids, ["run-rerun"]);
  assert.equal(replacementReport.artifact_issues.length, 0);
  assert.equal(replacementReport.group_counts_by_status.completed_with_rows, 1);
  assert.equal(replacementReport.group_counts_by_status.stopped, undefined);
  assert.equal(replacementReport.released_groups.length, 1);
  assert.equal(replacementReport.pending_groups.length, 0);
  assert.equal(replacementReport.released_groups[0].input_row, 4);
  assert.equal(replacementReport.released_groups[0].run_id, "run-rerun");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("Aggregate results tests passed.");
