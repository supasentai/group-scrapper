"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const runner = require("./browser-runner.js");

assert.equal(
  runner.validateGroupUrl("https://www.facebook.com/groups/example/?ref=bookmarks"),
  "https://www.facebook.com/groups/example/",
);
assert.equal(
  runner.buildGroupNavigationUrl("https://www.facebook.com/groups/example/?ref=bookmarks&sorting_setting=CHRONOLOGICAL"),
  "https://www.facebook.com/groups/example/?sorting_setting=CHRONOLOGICAL",
);
assert.throws(() => runner.validateGroupUrl("https://www.facebook.com/groups/example/posts/123/"), /group root/);
assert.throws(() => runner.validateGroupUrl("https://example.com/groups/example/"), /facebook\.com/);
assert.equal(runner.validateCdpEndpoint("http://127.0.0.1:9222/"), "http://127.0.0.1:9222");

const config = runner.parseArgs([
  "--group-url", "https://www.facebook.com/groups/example/?sorting_setting=CHRONOLOGICAL",
  "--group-name", "Trusted Input Group",
  "--collector-path", "fb-group-lead-pilot.js",
  "--cdp-endpoint", "http://127.0.0.1:9333",
  "--days", "3",
  "--max-rounds", "4",
  "--max-runtime-ms", "90000",
  "--results-dir", "results/runner-test",
]);
assert.equal(config.groupUrl, "https://www.facebook.com/groups/example/");
assert.equal(runner.buildGroupNavigationUrl(config.groupUrl), "https://www.facebook.com/groups/example/?sorting_setting=CHRONOLOGICAL");
const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "group-navigation-checkpoint-"));
const checkpointFile = path.join(checkpointDir, "checkpoints.json");
fs.writeFileSync(checkpointFile, JSON.stringify({
  version: 1,
  groups: {
    "https://www.facebook.com/groups/example/": {
      group_url: "https://www.facebook.com/groups/example/",
      group_name: "Trusted Input Group",
      checkpoint: "2026-10-08T00:00:00.000Z",
    },
  },
}), "utf8");
const checkpointMap = runner.loadCheckpointMap(
  checkpointFile,
  "https://www.facebook.com/groups/example/?sorting_setting=CHRONOLOGICAL",
);
assert.deepEqual(Object.keys(checkpointMap), ["https://www.facebook.com/groups/example/"]);
assert.equal(checkpointMap["https://www.facebook.com/groups/example/"], "2026-10-08T00:00:00.000Z");
fs.rmSync(checkpointDir, { recursive: true, force: true });
assert.equal(config.groupName, "Trusted Input Group");
assert.equal(config.days, 3);
assert.equal(config.maxRounds, 4);
assert.equal(config.maxRuntimeMs, 90000);
assert.equal(config.cdpEndpoint, "http://127.0.0.1:9333");
assert.equal(config.postRootBackfillTimeoutMs, 120000);
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
  captureMode: "all",
  deferClassification: true,
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

const commentUrl = "https://www.facebook.com/groups/example/posts/456/?comment_id=789";
const canonicalPostUrl = "https://www.facebook.com/groups/example/posts/456/";
assert.equal(runner.postRootUrlFromRow({ content_url: commentUrl }), canonicalPostUrl);
assert.equal(runner.normalizePublishedTimeText("7\u034f giờ"), "7 giờ");
assert.equal(runner.extractPublishedTimeText("ResilientLlama7062 · 7 giờ"), "7 giờ");
assert.equal(runner.isPublishedTimeText("7 giờ"), true);
assert.equal(runner.isPublishedTimeText("2.5 months"), false);
assert.equal(runner.extractPublishedTimeText("I had this result for 2.5 months"), "");
const normalizedTimestampCandidate = runner.normalizeBackfilledPostRoot({
  post_url: canonicalPostUrl,
  name: "Patricia Duran Nobrega",
  published_at_text: "13 giờ",
  text_excerpt: "I have had fat grafting under eyes 2.5 months before. Is this the final result?",
}, canonicalPostUrl);
assert.equal(normalizedTimestampCandidate.source_type, "post");
assert.match(normalizedTimestampCandidate.text_excerpt, /2\.5 months/);
assert.deepEqual(runner.deduplicateBackfilledPostRoots([
  { content_url: `${canonicalPostUrl}?ref=share`, source_type: "post", text_excerpt: "Root question" },
  { content_url: canonicalPostUrl, source_type: "post", text_excerpt: "Duplicate root" },
]), [{
  content_url: canonicalPostUrl,
  source_type: "post",
  text_excerpt: "Root question",
}]);
assert.deepEqual(runner.normalizeBackfilledPostRoot({
  post_url: `${canonicalPostUrl}?ref=share`,
  name: "Root Author",
  published_at_text: "Hôm qua lúc 03:17",
  text_excerpt: "Has anyone had this procedure?",
}, canonicalPostUrl, {
  groupName: "Example Group",
  groupUrl: "https://www.facebook.com/groups/example/",
}), {
  group_name: "Example Group",
  group_url: "https://www.facebook.com/groups/example/",
  content_url: canonicalPostUrl,
  name: "Root Author",
  profile_url: "",
  source_type: "post",
  published_at_text: "Hôm qua lúc 03:17",
  text_excerpt: "Has anyone had this procedure?",
});
assert.equal(runner.normalizeBackfilledPostRoot({
  post_url: "https://www.facebook.com/groups/example/posts/999/",
  text_excerpt: "Wrong post",
}, canonicalPostUrl), null);

const ingest = runner.makeIngestCommand({ sourceDir: "C:\\staging", resultsDir: "C:\\results" });
assert.equal(ingest.executable, process.execPath);
assert.equal(ingest.args.at(-2), "C:\\staging");
assert.equal(ingest.args.at(-1), "C:\\results");
const merge = runner.makeMergeCommand({ rawDir: "C:\\results\\scan_3d_scan_123\\raw", days: 3 });
assert.equal(merge.executable, process.execPath);
assert.deepEqual(merge.args.slice(-2), ["C:\\results\\scan_3d_scan_123\\raw", "3"]);

console.log("Browser runner tests passed.");
