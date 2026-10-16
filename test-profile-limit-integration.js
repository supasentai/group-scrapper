"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const runner = require("./browser-runner.js");

function makePage({ url, body }) {
  let evaluateCalls = 0;
  return {
    evaluate: async () => {
      evaluateCalls += 1;
      return { url, body };
    },
    get evaluateCalls() { return evaluateCalls; },
  };
}

(async () => {
  const hardPage = makePage({
    url: "https://www.facebook.com/checkpoint/",
    body: "Confirm your identity to continue.",
  });
  const hard = await runner.inspectFacebookPage(hardPage);
  assert.equal(hard.status, "profile_limited_hard");
  assert.equal(hard.action, "stop_and_switch_manually");
  assert.equal(hardPage.evaluateCalls, 1);

  const softPage = makePage({
    url: "https://www.facebook.com/groups/example/",
    body: "Something went wrong. Please try again later.",
  });
  const soft = await runner.inspectFacebookPage(softPage, {
    scrollAttempts: 4,
    progressEvents: 0,
    topLevelArticlesBefore: 3,
    topLevelArticlesAfter: 3,
    loadingSkeletonSeen: false,
  });
  assert.equal(soft.status, "profile_limited_soft");
  assert.equal(soft.action, "stop_and_switch_manually");

  const healthyPage = makePage({
    url: "https://www.facebook.com/groups/example/",
    body: "Group feed with normal posts",
  });
  const healthy = await runner.inspectFacebookPage(healthyPage, {
    scrollAttempts: 4,
    progressEvents: 2,
    topLevelArticlesBefore: 3,
    topLevelArticlesAfter: 8,
    loadingSkeletonSeen: false,
  });
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.action, "continue");

  const profiles = JSON.parse(fs.readFileSync("cdp-profiles.json", "utf8"));
  assert.deepEqual(profiles.profiles.map((profile) => profile.port), [9222, 9223, 9224, 9225]);
  assert.equal(profiles.one_port_per_batch, true);
  assert.equal(profiles.auto_switch, true);
  assert.deepEqual(profiles.switch_after, ["profile_limited", "not_member"]);

  console.log("Profile limit integration tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
