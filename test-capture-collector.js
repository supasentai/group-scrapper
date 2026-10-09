"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const mergeResults = require("./merge-results.js");
const pilot = require("./fb-group-lead-pilot.js");

const collectorSource = fs.readFileSync(require.resolve("./fb-group-lead-pilot.js"), "utf8");
assert.doesNotMatch(collectorSource, /text\.length\s*<\s*12/);

assert.equal(pilot.CONFIG.captureMode, "all");
assert.equal(pilot.CONFIG.deferClassification, true);
assert.equal(
  pilot.boundaryStopReason({
    recordCount: 0,
    parsedTimestampCount: 0,
    noRecordRounds: pilot.CONFIG.maxNoRecordRounds,
  }),
  "no_records_boundary_unverified",
);
assert.equal(
  pilot.boundaryStopReason({
    recordCount: 2,
    parsedTimestampCount: 0,
    unresolvedTimestampRounds: pilot.CONFIG.maxUnresolvedTimestampRounds,
  }),
  "timestamps_unresolved_boundary_unverified",
);
assert.equal(
  pilot.boundaryStopReason({
    recordCount: 2,
    parsedTimestampCount: 1,
    unresolvedTimestampRounds: pilot.CONFIG.maxUnresolvedTimestampRounds,
  }),
  "",
);
assert.equal(
  pilot.boundaryStopReason({
    recordCount: 0,
    parsedTimestampCount: 0,
    noRecordRounds: 99,
    config: { maxNoRecordRounds: 0, maxUnresolvedTimestampRounds: 0 },
  }),
  "",
);
assert.deepEqual(
  pilot.extractCommentPermalinkFromValue("https://www.facebook.com/groups/capture/posts/1/?comment_id=123", "https://www.facebook.com/groups/capture/posts/1/"),
  { url: "https://www.facebook.com/groups/capture/posts/1/?comment_id=123", sourceType: "comment" },
);
assert.deepEqual(
  pilot.extractCommentPermalinkFromValue('data-comment-id="456"', "https://www.facebook.com/groups/capture/posts/1/"),
  { url: "https://www.facebook.com/groups/capture/posts/1/?comment_id=456", sourceType: "comment" },
);

const groupUrl = "https://www.facebook.com/groups/capture/";
const postUrl = `${groupUrl}posts/1/`;
const rows = [
  { key: "noise", name: "Noise", source_type: "comment", post_url: postUrl, comment_url: `${postUrl}?comment_id=1`, published_at: "2026-10-07T10:00:00.000Z", text: "Nice" },
  { key: "seed", name: "Promoter", source_type: "comment", post_url: postUrl, comment_url: `${postUrl}?comment_id=2`, published_at: "2026-10-07T10:01:00.000Z", text: "Our clinic is the best, message me for a discount today!" },
  { key: "low-intent", name: "Reader", source_type: "comment", post_url: postUrl, comment_url: `${postUrl}?comment_id=3`, published_at: "2026-10-07T10:02:00.000Z", text: "Thanks for sharing this update." },
  { key: "short", name: "Short", source_type: "comment", post_url: postUrl, comment_url: `${postUrl}?comment_id=4`, published_at: "2026-10-07T10:03:00.000Z", text: "Agree" },
  { key: "post", name: "Post Author", source_type: "post", post_url: postUrl, published_at: "2026-10-07T10:04:00.000Z", text: "I am considering a facelift." },
  { key: "comment", name: "Comment Author", source_type: "comment", post_url: postUrl, comment_url: `${postUrl}?comment_id=5`, published_at: "2026-10-07T10:05:00.000Z", text: "I had surgery last year." },
  { key: "reply", name: "Reply Author", source_type: "reply", post_url: postUrl, comment_url: `${postUrl}?reply_comment_id=6`, published_at: "2026-10-07T10:06:00.000Z", text: "Same here." },
  { key: "unresolved", name: "Unknown Time", source_type: "comment", post_url: postUrl, comment_url: `${postUrl}?comment_id=7`, published_at_text: "time unavailable", text: "The result looks good." },
  { key: "post", name: "Post Author", source_type: "post", post_url: postUrl, published_at: "2026-10-07T10:04:00.000Z", text: "I am considering a facelift." },
  { key: "ui-only", name: "UI", source_type: "comment", post_url: postUrl, comment_url: `${postUrl}?comment_id=8`, published_at_text: "1m", text: "Like\nReply\nXem bản dịch" },
];

const captured = pilot.captureRecords(rows, { groupName: "Capture Group", groupUrl });
assert.equal(captured.length, 8);
assert.deepEqual(captured.map((row) => row.source_type).sort(), ["comment", "comment", "comment", "comment", "comment", "comment", "post", "reply"].sort());
assert.ok(captured.some((row) => row.text_excerpt === "Nice"));
assert.ok(captured.some((row) => row.text_excerpt === "Agree"));
assert.ok(captured.some((row) => row.text_excerpt.includes("discount")));
assert.ok(captured.some((row) => row.text_excerpt === "Same here."));
assert.ok(captured.some((row) => row.published_at_text === "time unavailable" && row.data_quality_flags.includes("missing_or_unparsed_time")));
assert.equal(captured.some((row) => row.text_excerpt.includes("Xem bản dịch")), false);

const unresolvedComment = pilot.captureRecords([{
  key: "unresolved-comment",
  name: "Unresolved Comment",
  source_type: "comment",
  post_url: postUrl,
  comment_url: postUrl,
  published_at: "2026-10-07T10:07:00.000Z",
  text: "A comment without a permalink must not inherit the post URL.",
}], { groupName: "Capture Group", groupUrl })[0];
assert.equal(unresolvedComment.source_type, "unresolved");
assert.equal(unresolvedComment.comment_url, "");
assert.equal(unresolvedComment.content_url, "");
assert.match(unresolvedComment.data_quality_flags, /source_type_unresolved/);
assert.match(unresolvedComment.data_quality_flags, /comment_permalink_missing/);

const commentUrlCopiedFromPost = pilot.captureRecords([{
  key: "comment-url-copied-from-post",
  name: "Copied URL Comment",
  source_type: "comment",
  post_url: postUrl,
  content_url: postUrl,
  comment_url: postUrl,
  published_at: "2026-10-07T10:08:00.000Z",
  text: "A copied post URL must fail closed.",
}], { groupName: "Capture Group", groupUrl })[0];
assert.equal(commentUrlCopiedFromPost.source_type, "unresolved");
assert.equal(commentUrlCopiedFromPost.content_url, "");
assert.equal(commentUrlCopiedFromPost.comment_url, "");
assert.match(commentUrlCopiedFromPost.data_quality_flags, /comment_permalink_missing/);

const classifiedCaptured = pilot.classifyRecords(captured, { groupName: "Capture Group", groupUrl });
assert.equal(classifiedCaptured.length, captured.length);
assert.ok(classifiedCaptured.some((row) => row.text_excerpt === "Agree"));

const exported = mergeResults.parseCsv(pilot.buildCsv(captured));
assert.equal(exported.length, captured.length);
assert.ok(exported.some((row) => row.text_excerpt === "Agree"));
assert.ok(exported.some((row) => row.source_type === "reply"));
assert.ok(exported.some((row) => row.published_at_text === "time unavailable"));

const unresolved = pilot.filterRecordsSince([
  { published_at_text: "unresolved time", text: "Keep this row" },
], new Date("2026-10-07T00:00:00.000Z"));
assert.equal(unresolved.length, 1);

console.log("Capture collector tests passed.");
