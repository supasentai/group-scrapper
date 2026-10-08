"use strict";

const assert = require("node:assert/strict");
const merge = require("./merge-results.js");

const now = new Date("2026-10-08T12:00:00.000Z");
const groupUrl = "https://www.facebook.com/groups/example/";
const postUrl = "https://www.facebook.com/groups/example/posts/123/";

function row(overrides = {}) {
  return {
    group_name: "Example Group",
    group_url: groupUrl,
    content_url: postUrl,
    name: "Customer",
    profile_url: "https://www.facebook.com/customer/",
    source_type: "post",
    published_at_text: "2026-10-08T10:00:00.000Z",
    text_excerpt: "I am considering this procedure and would like recommendations.",
    ...overrides,
  };
}

function comment(commentId, overrides = {}) {
  return row({
    content_url: `${postUrl}?comment_id=${commentId}`,
    comment_url: `${postUrl}?comment_id=${commentId}`,
    source_type: "comment",
    name: `Commenter ${commentId}`,
    profile_url: `https://www.facebook.com/commenter-${commentId}/`,
    text_excerpt: `Comment ${commentId} with useful context.`,
    ...overrides,
  });
}

function policy(rawRows) {
  return merge.applyPostOnlyPolicy(merge.dedupe(merge.normalizeRows(rawRows, now)));
}

function policyWithManifestFailures(rawRows, manifest) {
  const normalized = merge.dedupe(merge.normalizeRows(rawRows, now));
  return merge.applyPostOnlyPolicy(normalized, {
    postRootFailures: merge.postRootFailuresFromManifest(manifest),
  });
}

// Multiple comments under one recovered post collapse to exactly one post row.
const rawWithRoot = [row(), comment("1"), comment("2")];
const collapsed = policy(rawWithRoot);
assert.equal(collapsed.length, 1);
assert.equal(collapsed[0].source_type, "post");
assert.equal(collapsed[0].content_url, postUrl);
assert.equal(collapsed[0].post_url, postUrl);
assert.equal(collapsed[0].comment_url, "");
assert.equal(rawWithRoot[1].source_type, "comment");
assert.match(rawWithRoot[1].content_url, /comment_id=1/);

// Without a post root, comments remain comments and are explicitly marked fallback.
const fallback = policy([comment("3")]);
assert.equal(fallback.length, 1);
assert.equal(fallback[0].source_type, "comment");
assert.match(fallback[0].content_url, /comment_id=3/);
assert.match(fallback[0].comment_url, /comment_id=3/);
assert.match(fallback[0].data_quality_flags, /post_root_unavailable/);
assert.match(fallback[0].data_quality_flags, /comment_fallback/);

// A failed backfill is not a valid root, even when a post-shaped row exists.
const failedRoot = policy([
  row({ data_quality_flags: "post_root_backfill_failed" }),
  comment("4"),
]);
assert.equal(failedRoot.length, 1);
assert.equal(failedRoot[0].source_type, "comment");
assert.match(failedRoot[0].content_url, /comment_id=4/);
assert.match(failedRoot[0].data_quality_flags, /post_root_unavailable/);
assert.match(failedRoot[0].data_quality_flags, /comment_fallback/);

// The CSV has no failure flag; the child manifest alone invalidates the root.
const manifestOnlyFailure = policyWithManifestFailures([row(), comment("5")], {
  group_url: groupUrl,
  post_root_backfill: {
    failures: [{ post_url: postUrl, status: "timeout" }],
  },
});
assert.equal(manifestOnlyFailure.length, 1);
assert.equal(manifestOnlyFailure[0].source_type, "comment");
assert.match(manifestOnlyFailure[0].content_url, /comment_id=5/);
assert.match(manifestOnlyFailure[0].data_quality_flags, /post_root_backfill_failed/);
assert.match(manifestOnlyFailure[0].data_quality_flags, /post_root_unavailable/);
assert.match(manifestOnlyFailure[0].data_quality_flags, /comment_fallback/);

console.log("Post-only merge policy tests passed.");
