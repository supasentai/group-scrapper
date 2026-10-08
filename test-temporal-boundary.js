"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const aggregate = require("./aggregate-results.js");
const mergeResults = require("./merge-results.js");
const pilot = require("./fb-group-lead-pilot.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "group-scrapper-temporal-test-"));
try {
  const resultsDir = path.join(tempDir, "results");
  const batchManifestPath = path.join(tempDir, "batch_manifest.json");
  const checkpointGroup = "https://www.facebook.com/groups/checkpoint-boundary/";
  const fallbackGroup = "https://www.facebook.com/groups/fallback-boundary/";
  const groups = [
    {
      input_row: 2,
      group_name: "Checkpoint Boundary",
      group_url: checkpointGroup,
      checkpoint: "2026-10-01T00:00:00.000Z",
      run_id: "run-checkpoint-boundary",
      status: "completed_with_rows",
      row_count: 4,
    },
    {
      input_row: 3,
      group_name: "Fallback Boundary",
      group_url: fallbackGroup,
      checkpoint: null,
      run_id: "run-fallback-boundary",
      status: "completed_with_rows",
      row_count: 4,
    },
  ];
  fs.writeFileSync(batchManifestPath, JSON.stringify({
    batch_run_id: "batch_temporal_boundary",
    input_row_count: groups.length,
    requested_group_count: groups.length,
    groups,
  }), "utf8");

  function row(groupName, groupUrl, id, publishedAt, text = "I am considering a facelift.") {
    return {
      group_name: groupName,
      group_url: groupUrl,
      content_url: `${groupUrl}posts/${id}/`,
      name: `Author ${id}`,
      profile_url: `https://www.facebook.com/author-${id}/`,
      source_type: "post",
      published_at_text: publishedAt,
      text_excerpt: text,
    };
  }

  function writeRun(runId, groupName, groupUrl, rows) {
    const rawDir = path.join(resultsDir, runId, "raw");
    fs.mkdirSync(rawDir, { recursive: true });
    const csvFilename = `fb_group_scan_30d_${runId}.csv`;
    fs.writeFileSync(path.join(rawDir, csvFilename), pilot.buildCsv(rows), "utf8");
    fs.writeFileSync(path.join(rawDir, `${csvFilename.slice(0, -4)}.manifest.json`), JSON.stringify({
      group_url: groupUrl,
      group_name: groupName,
      run_id: runId,
      started_at: "2026-10-08T01:00:00.000Z",
      completed_at: "2026-10-08T01:01:00.000Z",
      row_count: rows.length,
      status: "completed",
      output_file: csvFilename,
    }), "utf8");
  }

  writeRun("run-checkpoint-boundary", "Checkpoint Boundary", checkpointGroup, [
    row("Checkpoint Boundary", checkpointGroup, 1, "2026-09-30T23:59:59.999Z"),
    row("Checkpoint Boundary", checkpointGroup, 2, "2026-10-01T00:00:00.000Z"),
    row("Checkpoint Boundary", checkpointGroup, 3, "2026-10-01T07:00:00+07:00"),
    row("Checkpoint Boundary", checkpointGroup, 4, "unknown time"),
  ]);
  writeRun("run-fallback-boundary", "Fallback Boundary", fallbackGroup, [
    row("Fallback Boundary", fallbackGroup, 5, "2026-09-07T23:59:59.999Z"),
    row("Fallback Boundary", fallbackGroup, 6, "2026-09-08T00:00:00.000Z"),
    row("Fallback Boundary", fallbackGroup, 7, "2026-09-15T12:00:00+07:00"),
    row("Fallback Boundary", fallbackGroup, 8, "not available"),
  ]);

  const now = new Date("2026-10-08T00:00:00.000Z");
  const report = aggregate.runAggregate(aggregate.parseArgs([
    "--batch-manifest", batchManifestPath,
    "--results-dir", resultsDir,
    "--no-cleanup",
  ]), { now });

  assert.equal(report.status, "completed");
  assert.equal(report.raw_rows, 8);
  assert.equal(report.dropped_old_rows, 2);
  assert.equal(report.quarantined_time_rows, 2);
  assert.equal(report.in_window_rows, 4);
  assert.equal(report.unresolved_time_rows, 2);
  assert.equal(report.temporal_boundaries[checkpointGroup].boundary, "2026-10-01T00:00:00.000Z");
  assert.equal(report.temporal_boundaries[checkpointGroup].boundary_type, "checkpoint");
  assert.equal(report.temporal_boundaries[fallbackGroup].boundary, "2026-09-08T00:00:00.000Z");
  assert.equal(report.temporal_boundaries[fallbackGroup].boundary_type, "fallback_30d");

  const finalRows = mergeResults.parseCsv(fs.readFileSync(report.outputs.all, "utf8"));
  const quarantineRows = mergeResults.parseCsv(fs.readFileSync(report.outputs.unresolved, "utf8"));
  assert.equal(finalRows.length, 4);
  assert.equal(quarantineRows.length, 2);
  assert.ok(finalRows.every((entry) => entry.published_at && !Number.isNaN(new Date(entry.published_at).getTime())));
  assert.ok(finalRows.every((entry) => !["1", "5"].some((id) => entry.content_url.endsWith(`/posts/${id}/`))));
  assert.ok(finalRows.some((entry) => entry.content_url.endsWith("/posts/2/")));
  assert.ok(finalRows.some((entry) => entry.content_url.endsWith("/posts/6/")));
  assert.ok(quarantineRows.every((entry) => !entry.published_at));

  const isoBoundary = aggregate.temporalBoundaryForGroup(
    { checkpoint: "2026-10-01T07:00:00+07:00" },
    now,
  );
  assert.equal(isoBoundary.boundary_iso, "2026-10-01T00:00:00.000Z");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("Temporal boundary tests passed.");
