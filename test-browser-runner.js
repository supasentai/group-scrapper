"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const runner = require("./browser-runner.js");

assert.equal(
  runner.validateGroupUrl("https://www.facebook.com/groups/example/?ref=bookmarks"),
  "https://www.facebook.com/groups/example/",
);
assert.throws(() => runner.validateGroupUrl("https://www.facebook.com/groups/example/posts/123/"), /group root/);
assert.throws(() => runner.validateGroupUrl("https://example.com/groups/example/"), /facebook\.com/);
assert.equal(runner.validateCdpEndpoint("http://127.0.0.1:9222/"), "http://127.0.0.1:9222");

const config = runner.parseArgs([
  "--group-url", "https://www.facebook.com/groups/example/",
  "--group-name", "Trusted Input Group",
  "--collector-path", "fb-group-lead-pilot.js",
  "--cdp-endpoint", "http://127.0.0.1:9333",
  "--days", "3",
  "--max-rounds", "4",
  "--max-runtime-ms", "90000",
  "--results-dir", "results/runner-test",
]);
assert.equal(config.groupUrl, "https://www.facebook.com/groups/example/");
assert.equal(config.groupName, "Trusted Input Group");
assert.equal(config.days, 3);
assert.equal(config.maxRounds, 4);
assert.equal(config.maxRuntimeMs, 90000);
assert.equal(config.cdpEndpoint, "http://127.0.0.1:9333");
assert.equal(config.childTimeoutMs, 120000);
assert.equal(config.collectorPath, path.resolve("fb-group-lead-pilot.js"));
assert.throws(() => runner.parseArgs(["--days", "3"]), /--group-url is required/);

const launch = runner.buildEdgeLaunchCommand({
  cdpEndpoint: "http://127.0.0.1:9222",
  profileDir: "C:\\runner-profile",
});
assert.equal(launch.executable, "msedge.exe");
assert.ok(launch.args.includes("--remote-debugging-port=9222"));
assert.ok(launch.args.some((arg) => arg.startsWith("--user-data-dir=")));

assert.deepEqual(runner.buildCollectorOptions(config), {
  days: 3,
  maxRounds: 4,
  maxRuntimeMs: 90000,
  groupName: "Trusted Input Group",
});
assert.equal(runner.validateGroupName("  Trusted   Input Group  "), "Trusted Input Group");
assert.throws(() => runner.validateGroupName("   "), /must not be empty/);

const csv = "fb_group_scan_3d_scan_123.csv";
const manifest = "fb_group_scan_3d_scan_123.manifest.json";
assert.equal(runner.isScanFilename(csv), true);
assert.equal(runner.isScanFilename(`${csv}.crdownload`), false);
assert.deepEqual(runner.findDownloadPair([
  "unrelated.txt",
  `${csv}.crdownload`,
  csv,
  manifest,
]), { csv, manifest });
assert.equal(runner.findDownloadPair([csv]), null);
assert.equal(runner.manifestFilenameFor(csv), manifest);
assert.equal(runner.safeDownloadName(csv), csv);
assert.throws(() => runner.safeDownloadName("..\\escape.csv"), /Unsafe/);

const ingest = runner.makeIngestCommand({ sourceDir: "C:\\staging", resultsDir: "C:\\results" });
assert.equal(ingest.executable, process.execPath);
assert.equal(ingest.args.at(-2), "C:\\staging");
assert.equal(ingest.args.at(-1), "C:\\results");
const merge = runner.makeMergeCommand({ rawDir: "C:\\results\\scan_3d_scan_123\\raw", days: 3 });
assert.equal(merge.executable, process.execPath);
assert.deepEqual(merge.args.slice(-2), ["C:\\results\\scan_3d_scan_123\\raw", "3"]);

console.log("Browser runner tests passed.");
