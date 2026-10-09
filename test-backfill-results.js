"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const backfill = require("./backfill-results.js");

const input = path.join(os.tmpdir(), "filtered-posts.csv");
const config = backfill.parseArgs([
  "--input", input,
  "--results-dir", path.join(os.tmpdir(), "group-scrapper-results"),
  "--cdp-endpoint", "http://127.0.0.1:9333/",
  "--post-root-timeout-ms", "5000",
]);
assert.equal(config.inputPath, path.resolve(input));
assert.equal(config.cdpEndpoint, "http://127.0.0.1:9333");
assert.equal(config.postRootTimeoutMs, 5000);
assert.throws(() => backfill.parseArgs(["--input", "not-a-csv.txt"]), /\.csv/);
assert.throws(() => backfill.parseArgs(["--input", input, "--unknown", "x"]), /Unknown option/);
assert.throws(() => backfill.assertSafeOutputParent(path.join("results", "run", "raw")), /raw archive/);

const root = "https://www.facebook.com/groups/example/posts/123/";
const rows = [
  { group_url: "https://www.facebook.com/groups/example/", source_type: "comment", content_url: `${root}?comment_id=456`, post_url: root },
  { group_url: "https://www.facebook.com/groups/example/", source_type: "post", content_url: root, post_url: root },
  { group_url: "https://www.facebook.com/groups/example/", source_type: "post", content_url: "https://www.facebook.com/groups/example/posts/789/", post_url: "https://www.facebook.com/groups/example/posts/789/", data_quality_flags: "post_root_unavailable" },
];
const selected = backfill.selectRetryRows(rows);
assert.equal(selected.selected.length, 1, "a healthy post root suppresses only its comment retry");
assert.equal(selected.skippedExistingRoots, 1);
assert.equal(backfill.shouldRetryRow(rows[2]), true);
assert.equal(backfill.shouldRetryRow({ source_type: "post", content_url: root, post_url: root }), false);

const outputParent = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-output-parent-"));
const outputDir = backfill.createRetryOutputDir(outputParent, input, new Date("2026-10-09T01:02:03.000Z"));
assert.equal(path.basename(outputDir), "backfill_retry_20261009T010203Z");
fs.rmSync(outputParent, { recursive: true, force: true });

console.log("backfill-results tests passed");
