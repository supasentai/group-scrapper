"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const aggregate = require("./aggregate-results.js");
const merge = require("./merge-results.js");
const pilot = require("./fb-group-lead-pilot.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "group-scrapper-cleanup-test-"));
try {
  const resultsDir = path.join(tempDir, "results");
  fs.mkdirSync(path.join(resultsDir, "scan_30d_demo", "raw"), { recursive: true });
  fs.writeFileSync(path.join(resultsDir, "scan_30d_demo", "raw", "fb_group_scan_30d_demo.csv"), "raw,csv\n", "utf8");
  fs.writeFileSync(path.join(resultsDir, "scan_30d_demo", "raw", "fb_group_scan_30d_demo.manifest.json"), "{}\n", "utf8");
  fs.mkdirSync(path.join(resultsDir, ".runner-staging-demo"), { recursive: true });
  fs.writeFileSync(path.join(resultsDir, ".runner-staging-demo", "partial.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(resultsDir, "batch_manifest_demo.json"), "{}\n", "utf8");

  const finalOutput = path.join(resultsDir, "fb_group_aggregate_all_current_utf8.csv");
  fs.writeFileSync(finalOutput, "final\n", "utf8");
  for (const name of [
    "fb_group_aggregate_all_old_utf8.csv",
    "fb_group_aggregate_posts_old_utf8.csv",
    "fb_group_aggregate_comments_context_old_utf8.csv",
    "fb_group_aggregate_unresolved_context_old_utf8.csv",
    "aggregate_report_old.json",
    "aggregate_report_old.md",
    "quality_report_old.json",
    "ingestion_report.json",
  ]) fs.writeFileSync(path.join(resultsDir, name), "intermediate\n", "utf8");

  const cleanup = aggregate.cleanupResults(resultsDir, {
    sourceRunIds: ["scan_30d_demo"],
    finalOutputPath: finalOutput,
  });
  assert.equal(cleanup.status, "completed");
  assert.equal(fs.existsSync(path.join(resultsDir, "raw", "scan_30d_demo", "fb_group_scan_30d_demo.csv")), true);
  assert.equal(fs.existsSync(path.join(resultsDir, "raw", "scan_30d_demo", "fb_group_scan_30d_demo.manifest.json")), true);
  assert.equal(fs.existsSync(path.join(resultsDir, "scan_30d_demo")), false);
  assert.equal(fs.existsSync(path.join(resultsDir, ".runner-staging-demo")), false);
  assert.equal(fs.existsSync(path.join(resultsDir, "batch_manifest_demo.json")), true);
  assert.equal(fs.existsSync(finalOutput), true);
  assert.equal(fs.existsSync(path.join(resultsDir, "fb_group_aggregate_posts_old_utf8.csv")), false);
  assert.equal(fs.existsSync(path.join(resultsDir, "aggregate_report_old.json")), false);
  assert.equal(fs.existsSync(path.join(resultsDir, "ingestion_report.json")), false);

  // Idempotence: the second cleanup has no source/staging entries to remove
  // and must leave the raw archive and final CSV intact.
  const secondCleanup = aggregate.cleanupResults(resultsDir, {
    sourceRunIds: ["scan_30d_demo"],
    finalOutputPath: finalOutput,
  });
  assert.equal(secondCleanup.status, "completed");
  assert.equal(fs.existsSync(path.join(resultsDir, "raw", "scan_30d_demo", "fb_group_scan_30d_demo.csv")), true);

  // rmSync receives retry options. The real filesystem adapter handles
  // transient EBUSY/EPERM conditions internally.
  const retryDir = path.join(tempDir, "retry-results");
  fs.mkdirSync(retryDir, { recursive: true });
  const retryFile = path.join(retryDir, "fb_group_aggregate_posts_old_utf8.csv");
  fs.writeFileSync(retryFile, "old\n", "utf8");
  let retryCalls = 0;
  const retryCleanup = aggregate.cleanupResults(retryDir, {
    removeSync(target, options) {
      assert.equal(options.maxRetries, 5);
      assert.equal(options.retryDelay, 200);
      if (target === retryFile) retryCalls += 1;
      return fs.rmSync(target, options);
    },
  });
  assert.equal(retryCalls, 1);
  assert.equal(retryCleanup.status, "completed");
  assert.equal(retryCleanup.warnings.length, 0);
  assert.equal(fs.existsSync(retryFile), false);

  // A permanently locked intermediate is nonfatal. The final CSV remains and
  // a later cleanup run can remove the stale file once it is unlocked.
  const warningDir = path.join(tempDir, "warning-results");
  fs.mkdirSync(warningDir, { recursive: true });
  const warningFile = path.join(warningDir, "fb_group_aggregate_posts_locked_utf8.csv");
  const warningFinal = path.join(warningDir, "fb_group_aggregate_all_final_utf8.csv");
  fs.writeFileSync(warningFile, "locked\n", "utf8");
  fs.writeFileSync(warningFinal, "final\n", "utf8");
  const warningCleanup = aggregate.cleanupResults(warningDir, {
    finalOutputPath: warningFinal,
    removeSync(target, options) {
      if (target === warningFile) {
        const error = new Error("access denied");
        error.code = "EPERM";
        throw error;
      }
      return fs.rmSync(target, options);
    },
  });
  assert.equal(warningCleanup.status, "completed_with_warnings");
  assert.equal(warningCleanup.warnings.length, 1);
  assert.equal(warningCleanup.warnings[0].action, "kept_intermediate");
  assert.equal(fs.existsSync(warningFile), true);
  assert.equal(fs.existsSync(warningFinal), true);
  const rerunWarningCleanup = aggregate.cleanupResults(warningDir, { finalOutputPath: warningFinal });
  assert.equal(rerunWarningCleanup.status, "completed");
  assert.equal(fs.existsSync(warningFile), false);
  assert.equal(fs.existsSync(warningFinal), true);

  assert.throws(() => aggregate.cleanupResults(resultsDir, {
    sourceRunIds: ["../outside"],
    finalOutputPath: finalOutput,
  }), /Invalid run ID/);
  assert.throws(() => aggregate.cleanupResults(resultsDir, {
    sourceRunIds: [],
    finalOutputPath: path.join(tempDir, "outside.csv"),
  }), /cleanup_path_outside_results/);

  // Successful aggregate keeps one merged CSV and archives the source raw
  // artifact, while deleting the per-run directory and intermediates.
  const successDir = path.join(tempDir, "success-results");
  const successRun = "scan_30d_success";
  const successRaw = path.join(successDir, successRun, "raw");
  fs.mkdirSync(successRaw, { recursive: true });
  const successCsv = `fb_group_scan_30d_${successRun}.csv`;
  const successManifest = `${successCsv.slice(0, -4)}.manifest.json`;
  const successRow = {
    group_name: "Success Group",
    group_url: "https://www.facebook.com/groups/success/",
    content_url: "https://www.facebook.com/groups/success/posts/1/",
    name: "Customer",
    source_type: "post",
    published_at_text: "2026-10-08T08:00:00.000Z",
    text_excerpt: "I am considering a facelift and need recommendations.",
  };
  fs.writeFileSync(path.join(successRaw, successCsv), pilot.buildCsv([successRow]), "utf8");
  fs.writeFileSync(path.join(successRaw, successManifest), JSON.stringify({
    group_url: successRow.group_url,
    group_name: successRow.group_name,
    run_id: successRun,
    row_count: 1,
    status: "completed",
    output_file: successCsv,
  }), "utf8");
  const successBatch = path.join(tempDir, "success-batch.json");
  fs.writeFileSync(successBatch, JSON.stringify({
    input_row_count: 1,
    groups: [{
      input_row: 1,
      group_name: successRow.group_name,
      group_url: successRow.group_url,
      run_id: successRun,
      status: "completed_with_rows",
      row_count: 1,
    }],
  }), "utf8");
  const successReport = aggregate.runAggregate(aggregate.parseArgs([
    "--batch-manifest", successBatch,
    "--results-dir", successDir,
  ]), { now: new Date("2026-10-08T12:00:00.000Z") });
  assert.equal(successReport.status, "completed");
  assert.equal(successReport.cleanup.status, "completed");
  assert.equal(merge.parseCsv(fs.readFileSync(successReport.outputs.all, "utf8")).length, 1);
  assert.equal(fs.existsSync(successReport.outputs.all), true);
  assert.equal(fs.existsSync(path.join(successDir, "raw", successRun, successCsv)), true);
  assert.equal(fs.existsSync(path.join(successDir, successRun)), false);
  assert.equal(fs.existsSync(successReport.outputs.posts), false);
  assert.equal(fs.existsSync(successReport.outputs.report_json), false);

  // An aggregate with a missing artifact is not successful and must retain
  // the run directory and all generated evidence for diagnosis.
  const failureDir = path.join(tempDir, "failure-results");
  const failureRun = "scan_30d_failure";
  fs.mkdirSync(path.join(failureDir, failureRun), { recursive: true });
  const failureBatch = path.join(tempDir, "failure-batch.json");
  fs.writeFileSync(failureBatch, JSON.stringify({
    input_row_count: 1,
    groups: [{
      input_row: 1,
      group_name: "Failure Group",
      group_url: "https://www.facebook.com/groups/failure/",
      run_id: failureRun,
      status: "completed_with_rows",
      row_count: 1,
    }],
  }), "utf8");
  const failureReport = aggregate.runAggregate(aggregate.parseArgs([
    "--batch-manifest", failureBatch,
    "--results-dir", failureDir,
  ]), { now: new Date("2026-10-08T12:00:00.000Z") });
  assert.equal(failureReport.status, "completed_with_errors");
  assert.equal(failureReport.cleanup.status, "skipped");
  assert.equal(fs.existsSync(path.join(failureDir, failureRun)), true);
  assert.equal(fs.existsSync(failureReport.outputs.all), true);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("Aggregate cleanup tests passed.");
