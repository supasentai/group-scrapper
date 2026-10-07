"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const batch = require("./batch-runner.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "group-scrapper-batch-test-"));
try {
  const groupsFile = path.join(tempDir, "groups.csv");
  const resultsDir = path.join(tempDir, "results");
  fs.writeFileSync(groupsFile, [
    "TÊN HỘI NHÓM,LINK",
    "Alpha Group,https://www.facebook.com/groups/alpha/",
    ",",
    "Invalid Group,https://example.com/groups/invalid/",
    "Duplicate Alpha,https://www.facebook.com/groups/alpha/?ref=bookmarks",
    "Zero Group,https://www.facebook.com/groups/zero/",
    "Blocked Group,https://www.facebook.com/groups/blocked/",
    "After Block,https://www.facebook.com/groups/after/",
  ].join("\n"), "utf8");

  const csvHeader = "group_name,group_url,content_url,name,profile_url,source_type,published_at_text,text_excerpt";
  const writeArtifacts = (name, groupUrl, runId, status, rowCount) => {
    const csvPath = path.join(resultsDir, `${name}.csv`);
    const manifestPath = path.join(resultsDir, `${name}.manifest.json`);
    fs.mkdirSync(resultsDir, { recursive: true });
    const rows = Array.from({ length: rowCount }, (_value, index) => `"Group","${groupUrl}","${groupUrl}posts/${index + 1}/","Author ${index + 1}","https://www.facebook.com/author-${index + 1}/","post","2026-10-07T00:00:00.000Z","A valid post text for fixture ${index + 1}."`);
    fs.writeFileSync(csvPath, `${csvHeader}\n${rows.join("\n")}\n`, "utf8");
    fs.writeFileSync(manifestPath, JSON.stringify({
      group_url: groupUrl,
      run_id: runId,
      status,
      row_count: rowCount,
      output_file: path.basename(csvPath),
    }), "utf8");
    return { manifestPath, csvPath };
  };

  const config = batch.parseArgs([
    "--groups-file", groupsFile,
    "--results-dir", resultsDir,
    "--days", "3",
    "--max-runtime-ms", "1000",
    "--child-timeout-ms", "2000",
  ]);
  const runCalls = [];
  const fakeRunner = (group) => {
    runCalls.push(group.group_url);
    if (group.group_url.endsWith("/alpha/")) {
      const artifacts = writeArtifacts("alpha", group.group_url, "scan_alpha", "completed", 2);
      return { status: "completed", run_id: "scan_alpha", files: { manifest: artifacts.manifestPath, csv: artifacts.csvPath } };
    }
    if (group.group_url.endsWith("/zero/")) {
      const artifacts = writeArtifacts("zero", group.group_url, "scan_zero", "zero_result", 0);
      return { status: "zero_result", run_id: "scan_zero", files: { manifest: artifacts.manifestPath, csv: artifacts.csvPath } };
    }
    return { status: "needs_user_action", needs_user_action: "Facebook login required" };
  };

  const manifest = batch.runBatch(config, { runGroup: fakeRunner });
  assert.equal(manifest.status, "needs_user_action");
  assert.equal(manifest.input_row_count, 7);
  assert.equal(manifest.requested_group_count, 4);
  assert.equal(manifest.input_hash, batch.sha256(fs.readFileSync(groupsFile)));
  assert.deepEqual(runCalls, [
    "https://www.facebook.com/groups/alpha/",
    "https://www.facebook.com/groups/zero/",
    "https://www.facebook.com/groups/blocked/",
  ]);
  assert.deepEqual(manifest.groups.map((group) => group.status), [
    "completed_with_rows",
    "skipped_blank",
    "skipped_invalid",
    "skipped_duplicate",
    "zero_result",
    "needs_user_action",
    "not_run",
  ]);
  assert.equal(manifest.groups[0].run_id, "scan_alpha");
  assert.equal(manifest.groups[0].row_count, 2);
  assert.equal(manifest.groups[4].row_count, 0);
  assert.equal(manifest.groups[5].needs_user_action, "Facebook login required");
  assert.equal(manifest.groups[6].error, "batch_stopped_after_needs_user_action");
  assert.deepEqual(manifest.counts, {
    completed_with_rows: 1,
    skipped_blank: 1,
    skipped_invalid: 1,
    skipped_duplicate: 1,
    zero_result: 1,
    needs_user_action: 1,
    not_run: 1,
  });
  assert.equal(fs.existsSync(manifest.manifest_path), true);
  assert.equal(batch.normalizeOutcome({ status: "zero_result" }).status, "failed");
  assert.equal(batch.normalizeOutcome({ status: "completed", files: {} }).status, "failed");

  const stoppedGroupsFile = path.join(tempDir, "stopped-groups.csv");
  fs.writeFileSync(stoppedGroupsFile, "TÊN HỘI NHÓM,LINK\nStopped Group,https://www.facebook.com/groups/stopped/\n", "utf8");
  const stoppedConfig = batch.parseArgs([
    "--groups-file", stoppedGroupsFile,
    "--results-dir", resultsDir,
    "--days", "3",
  ]);
  const stoppedManifest = batch.runBatch(stoppedConfig, {
    runGroup: (group) => {
      const artifacts = writeArtifacts("stopped", group.group_url, "scan_stopped", "stopped", 1);
      return { status: "stopped", run_id: "scan_stopped", files: { manifest: artifacts.manifestPath, csv: artifacts.csvPath } };
    },
  });
  assert.equal(stoppedManifest.status, "completed_with_stopped");
  assert.equal(stoppedManifest.groups[0].status, "stopped");

  const mismatchedGroupsFile = path.join(tempDir, "mismatched-groups.csv");
  fs.writeFileSync(mismatchedGroupsFile, "TÊN HỘI NHÓM,LINK\nMismatch Group,https://www.facebook.com/groups/mismatch/\n", "utf8");
  const mismatchedConfig = batch.parseArgs([
    "--groups-file", mismatchedGroupsFile,
    "--results-dir", resultsDir,
    "--days", "3",
  ]);
  const mismatchedManifest = batch.runBatch(mismatchedConfig, {
    runGroup: () => {
      const artifacts = writeArtifacts("mismatch", "https://www.facebook.com/groups/other/", "scan_mismatch", "zero_result", 0);
      return { status: "zero_result", files: { manifest: artifacts.manifestPath, csv: artifacts.csvPath } };
    },
  });
  assert.equal(mismatchedManifest.status, "completed_with_errors");
  assert.equal(mismatchedManifest.groups[0].status, "failed");
  assert.match(mismatchedManifest.groups[0].error, /group_url_mismatch/);

  const badCountArtifacts = writeArtifacts("bad-count", "https://www.facebook.com/groups/bad-count/", "scan_bad_count", "zero_result", 1);
  const badCountManifest = JSON.parse(fs.readFileSync(badCountArtifacts.manifestPath, "utf8"));
  badCountManifest.row_count = 0;
  fs.writeFileSync(badCountArtifacts.manifestPath, JSON.stringify(badCountManifest), "utf8");
  const badCountOutcome = batch.normalizeOutcome(
    { status: "zero_result", files: { manifest: badCountArtifacts.manifestPath, csv: badCountArtifacts.csvPath } },
    "https://www.facebook.com/groups/bad-count/",
  );
  assert.equal(badCountOutcome.status, "failed");
  assert.match(badCountOutcome.error, /csv_row_count_mismatch/);

  const missingCsvManifestPath = path.join(resultsDir, "missing-csv.manifest.json");
  fs.writeFileSync(missingCsvManifestPath, JSON.stringify({
    group_url: "https://www.facebook.com/groups/missing-csv/",
    run_id: "scan_missing_csv",
    status: "zero_result",
    row_count: 0,
    output_file: "missing-csv.csv",
  }), "utf8");
  const missingCsvOutcome = batch.normalizeOutcome(
    { status: "zero_result", files: { manifest: missingCsvManifestPath, csv: path.join(resultsDir, "missing-csv.csv") } },
    "https://www.facebook.com/groups/missing-csv/",
  );
  assert.equal(missingCsvOutcome.status, "failed");
  assert.match(missingCsvOutcome.error, /csv_missing/);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("Batch runner tests passed.");
