"use strict";

const assert = require("node:assert/strict");
const runner = require("./browser-runner.js");

function pageFor(state) {
  return { evaluate: async () => state };
}

(async () => {
  const notMember = await runner.detectGroupAccess(pageFor({
    body: "This is a private group. Request to join group to see posts.",
    controls: "Request to join group",
  }));
  assert.equal(notMember.status, "not_member");
  assert.equal(notMember.confidence, "high");
  assert.equal(notMember.action, "try_next_profile");

  const vietnameseNotMember = await runner.detectGroupAccess(pageFor({
    body: "Tham gia nhóm để xem nội dung.",
    controls: "Tham gia nhóm",
  }));
  assert.equal(vietnameseNotMember.status, "not_member");

  const accessible = await runner.detectGroupAccess(pageFor({
    body: "Group feed. Recent posts are visible.",
    controls: "Write a post Comment Share",
  }));
  assert.equal(accessible.status, "member_or_unknown");
  assert.equal(accessible.action, "continue");

  const publicGroup = await runner.detectGroupAccess(pageFor({
    body: "Public group. Recent posts are visible.",
    controls: "Join group Write something Comment",
  }));
  assert.equal(publicGroup.status, "member_or_unknown");

  console.log("Group access tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
