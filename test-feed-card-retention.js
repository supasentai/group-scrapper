"use strict";

const assert = require("node:assert/strict");
const pilot = require("./fb-group-lead-pilot.js");

async function main() {
  const visiblePost = { key: "post-1", source_type: "post", text: "A post that disappears during expansion" };
  let cardVisible = true;
  const operations = {
    readPosts: async () => cardVisible ? [visiblePost] : [],
    expandDiscussion: async () => { cardVisible = false; },
    readDiscussion: async () => [{ key: "comment-1", source_type: "comment" }],
  };
  const captured = await pilot.collectFeedRound({}, false, operations);
  assert.deepEqual(captured.map(item => item.key), ["post-1", "comment-1"]);

  cardVisible = true;
  const postsOnly = await pilot.collectFeedRound({}, true, operations);
  assert.deepEqual(postsOnly.map(item => item.key), ["post-1"]);
  assert.equal(cardVisible, true);

  const timeLink = {
    innerText: "1d", textContent: "1d",
    getAttribute: name => name === "aria-label" ? "Tuesday 17 November 2026 at 05:39" : null,
  };
  assert.equal(pilot.getTimeLinkLabel(timeLink), "Tuesday 17 November 2026 at 05:39");
  assert.equal(pilot.nextFeedScrollTop(0, 1000, 10000), 800);
  assert.equal(pilot.nextFeedScrollTop(8800, 1000, 10000), 9000);
  assert.equal(pilot.nextFeedScrollTop(0, 1000, 700), 0);
  console.log("Feed card retention tests passed.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
