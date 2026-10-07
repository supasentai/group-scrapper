"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pilot = require("./fb-group-lead-pilot.js");
const ingestion = require("./ingest-downloads.js");

const runId = "scan_30d_test-run";
const csvFilename = "fb_group_scan_30d_test-run.csv";
const manifestFilename = pilot.makeManifestFilename(csvFilename);
const startedAt = new Date("2026-10-07T12:00:00.000Z");
const completedAt = new Date("2026-10-07T12:00:01.000Z");
const manifest = pilot.buildRunManifest({
  groupUrl: "https://www.facebook.com/groups/123/",
  groupName: "Test Group",
  runId,
  startedAt,
  completedAt,
  rowCount: 0,
  status: "zero_result",
  outputFile: csvFilename,
});

assert.deepEqual(Object.keys(manifest), [
  "group_url",
  "group_name",
  "run_id",
  "started_at",
  "completed_at",
  "row_count",
  "status",
  "output_file",
]);
assert.equal(manifest.started_at, "2026-10-07T12:00:00.000Z");
assert.equal(manifest.completed_at, "2026-10-07T12:00:01.000Z");
assert.equal(ingestion.makeManifestFilename(csvFilename), manifestFilename);

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "group-scrapper-ingestion-test-"));
const sourceDir = path.join(fixtureRoot, "Downloads");
const resultsDir = path.join(fixtureRoot, "results");
fs.mkdirSync(sourceDir, { recursive: true });
try {
  fs.writeFileSync(path.join(sourceDir, csvFilename), pilot.buildCsv([]), "utf8");
  fs.writeFileSync(path.join(sourceDir, manifestFilename), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const first = ingestion.ingestDirectory(sourceDir, resultsDir);
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].action, "ingested");
  assert.equal(first.entries[0].status, "zero_result");
  assert.equal(first.entries[0].row_count, 0);
  assert.equal(
    fs.existsSync(path.join(resultsDir, runId, "raw", csvFilename)),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(resultsDir, runId, "raw", manifestFilename)),
    true,
  );
  assert.equal(fs.existsSync(path.join(sourceDir, csvFilename)), true);
  assert.equal(fs.existsSync(path.join(sourceDir, manifestFilename)), true);
  assert.equal(fs.existsSync(path.join(resultsDir, "ingestion_report.json")), true);
  assert.equal(fs.existsSync(path.join(resultsDir, runId, "ingestion_report.json")), true);

  const second = ingestion.ingestDirectory(sourceDir, resultsDir);
  assert.equal(second.entries[0].action, "already_ingested");

  const missingCsv = "fb_group_scan_30d_missing-manifest.csv";
  fs.writeFileSync(path.join(sourceDir, missingCsv), pilot.buildCsv([]), "utf8");

  const pendingCsv = "fb_group_scan_30d_pending.csv";
  const pendingManifestFilename = pilot.makeManifestFilename(pendingCsv);
  const pendingManifest = pilot.buildRunManifest({
    groupUrl: manifest.group_url,
    groupName: manifest.group_name,
    runId: "scan_30d_pending",
    startedAt,
    completedAt,
    rowCount: 0,
    status: "zero_result",
    outputFile: pendingCsv,
  });
  fs.writeFileSync(path.join(sourceDir, pendingCsv), pilot.buildCsv([]), "utf8");
  fs.writeFileSync(path.join(sourceDir, pendingManifestFilename), `${JSON.stringify(pendingManifest)}\n`, "utf8");
  fs.writeFileSync(path.join(sourceDir, `${pendingManifestFilename}.crdownload`), "partial", "utf8");

  const third = ingestion.ingestDirectory(sourceDir, resultsDir);
  const missingEntry = third.entries.find((entry) => entry.csv_file === missingCsv);
  const pendingEntry = third.entries.find((entry) => entry.csv_file === pendingCsv);
  assert.equal(missingEntry.reason, "manifest_missing");
  assert.equal(pendingEntry.reason, "temporary_download_detected");

  const widthCsv = "fb_group_scan_30d_width-mismatch.csv";
  const widthManifestFilename = pilot.makeManifestFilename(widthCsv);
  const widthManifest = pilot.buildRunManifest({
    groupUrl: manifest.group_url,
    groupName: manifest.group_name,
    runId: "scan_30d_width-mismatch",
    startedAt,
    completedAt,
    rowCount: 1,
    status: "completed",
    outputFile: widthCsv,
  });
  const header = pilot.buildCsv([]).replace(/^\uFEFF/, "").split("\n", 1)[0];
  fs.writeFileSync(path.join(sourceDir, widthCsv), `${header}\n"group","url"\n`, "utf8");
  fs.writeFileSync(path.join(sourceDir, widthManifestFilename), `${JSON.stringify(widthManifest)}\n`, "utf8");

  const groupMismatchCsv = "fb_group_scan_30d_group-mismatch.csv";
  const groupMismatchManifestFilename = pilot.makeManifestFilename(groupMismatchCsv);
  const groupMismatchManifest = pilot.buildRunManifest({
    groupUrl: manifest.group_url,
    groupName: manifest.group_name,
    runId: "scan_30d_group-mismatch",
    startedAt,
    completedAt,
    rowCount: 1,
    status: "completed",
    outputFile: groupMismatchCsv,
  });
  fs.writeFileSync(path.join(sourceDir, groupMismatchCsv), pilot.buildCsv([{
    group_name: "Other Group",
    group_url: "https://www.facebook.com/groups/999/",
    content_url: "https://www.facebook.com/groups/999/posts/1/",
    name: "Author",
    profile_url: "https://www.facebook.com/author/",
    source_type: "post",
    published_at_text: "2026-10-07T12:00:00.000Z",
    text_excerpt: "A valid row with a different group.",
  }]), "utf8");
  fs.writeFileSync(path.join(sourceDir, groupMismatchManifestFilename), `${JSON.stringify(groupMismatchManifest)}\n`, "utf8");

  const fourth = ingestion.ingestDirectory(sourceDir, resultsDir);
  const widthEntry = fourth.entries.find((entry) => entry.csv_file === widthCsv);
  const groupMismatchEntry = fourth.entries.find((entry) => entry.csv_file === groupMismatchCsv);
  assert.match(widthEntry.reason, /^row_width_mismatch:/);
  assert.equal(groupMismatchEntry.reason, "manifest_csv_group_url_mismatch");
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log("Ingestion tests passed.");
