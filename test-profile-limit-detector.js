"use strict";

const assert = require("node:assert/strict");
const { detectProfileLimit } = require("./profile-limit-detector.js");

assert.equal(
  detectProfileLimit({ url: "https://www.facebook.com/checkpoint/?next=/groups/1" }).status,
  "profile_limited_hard",
);
assert.equal(
  detectProfileLimit({ body: "Your account has been temporarily blocked. Confirm your identity." }).status,
  "profile_limited_hard",
);
assert.equal(
  detectProfileLimit({
    body: "Something went wrong. Please try again later.",
    feed: { scrollAttempts: 4, progressEvents: 0 },
  }).status,
  "profile_limited_soft",
);
assert.equal(
  detectProfileLimit({
    feed: { scrollAttempts: 4, progressEvents: 0, loadingSkeletonSeen: true },
  }).status,
  "feed_dom_stalled",
);
assert.equal(
  detectProfileLimit({ networkError: "connect ECONNRESET" }).status,
  "network_or_cdp_error",
);
assert.equal(
  detectProfileLimit({ feed: { scrollAttempts: 5, progressEvents: 4 } }).status,
  "healthy",
);
assert.equal(
  detectProfileLimit({ body: "No new posts after the checkpoint.", feed: { scrollAttempts: 3, progressEvents: 2 } }).status,
  "healthy",
);

console.log("profile-limit-detector tests passed");
