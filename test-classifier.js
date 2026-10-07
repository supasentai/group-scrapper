"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pilot = require("./fb-group-lead-pilot.js");
const mergeResults = require("./merge-results.js");

assert.deepEqual(pilot.CSV_HEADERS, [
  "group_name",
  "group_url",
  "content_url",
  "name",
  "profile_url",
  "source_type",
  "published_at_text",
  "text_excerpt",
]);
assert.equal(pilot.isLikelyUiGroupHeading("Thông báo"), true);
assert.equal(pilot.isLikelyUiGroupHeading("Facelift Support Group"), false);
assert.equal(pilot.isLikelyMemberCount("34,3K thành viên"), true);
assert.equal(pilot.isLikelyMemberCount("34,3K members"), true);
assert.equal(pilot.isLikelyMemberCount("Face | Neck Support Group"), false);
assert.equal(pilot.isLikelyPostTitle("deep plane facelift support group | Has anyone gotten a quote from Dr"), true);
assert.equal(pilot.isLikelyPostTitle("Face | Neck Support Group"), false);
assert.equal(pilot.isExactGroupLink("https://www.facebook.com/groups/123/", "https://www.facebook.com/groups/123/"), true);
assert.equal(pilot.isExactGroupLink("https://www.facebook.com/groups/123/posts/456/", "https://www.facebook.com/groups/123/"), false);
assert.equal(
  pilot.isPostInGroup(
    "https://www.facebook.com/groups/surgeryinturkiye/posts/2073705449939070/?comment_id=2074653926510889",
    "https://www.facebook.com/groups/1052731386791309/",
  ),
  false,
);
assert.equal(
  pilot.isPostInGroup(
    "https://www.facebook.com/groups/1052731386791309/posts/2073705449939070/",
    "https://www.facebook.com/groups/1052731386791309/",
  ),
  true,
);
assert.equal(pilot.makeScanFilename(30, 1234), "fb_group_scan_30d_1234.csv");
assert.equal(pilot.manifestStatusForRun("completed_with_rows", 3), "completed");
assert.equal(pilot.manifestStatusForRun("zero_result_after_checkpoint", 0), "zero_result");
assert.equal(pilot.manifestStatusForRun("stopped", 0), "zero_result");
assert.equal(pilot.manifestStatusForRun("stopped", 3), "stopped");
const previousDocument = global.document;
const previousLocation = global.location;
try {
  global.location = {
    href: "https://www.facebook.com/groups/123/",
    origin: "https://www.facebook.com",
    pathname: "/groups/123/",
  };
  global.document = {
    title: "deep plane facelift support group | Has anyone gotten a quote from Dr | Facebook",
    querySelectorAll: (selector) => selector === "a[href]"
      ? [
        {
          href: "https://www.facebook.com/groups/123/posts/456/",
          textContent: "Some post content",
          getAttribute: (name) => name === "href" ? "/groups/123/posts/456/" : null,
        },
        {
          href: "https://www.facebook.com/groups/123/",
          textContent: "34,3K thành viên",
          getAttribute: (name) => name === "href" ? "/groups/123/" : null,
        },
        {
          href: "https://www.facebook.com/groups/123/",
          textContent: "Face | Neck Support Group",
          getAttribute: (name) => name === "href" ? "/groups/123/" : null,
        },
      ]
      : [{ textContent: "Thông báo" }],
    querySelector: () => ({ getAttribute: () => "deep plane facelift support group | Has anyone gotten a quote from Dr" }),
  };
  assert.deepEqual(pilot.getGroupContext(), {
    groupName: "Face | Neck Support Group",
    groupUrl: "https://www.facebook.com/groups/123/",
  });
  assert.deepEqual(pilot.getGroupContext("Trusted Input Group"), {
    groupName: "Trusted Input Group",
    groupUrl: "https://www.facebook.com/groups/123/",
  });
  assert.equal(pilot.buildRunManifest({
    groupUrl: "https://www.facebook.com/groups/123/",
    groupName: pilot.getGroupContext("Trusted Input Group").groupName,
    runId: "scan_test",
    startedAt: "2026-10-07T00:00:00.000Z",
    completedAt: "2026-10-07T00:01:00.000Z",
    rowCount: 0,
    status: "zero_result",
    outputFile: "fb_group_scan_3d_test.csv",
  }).group_name, "Trusted Input Group");
} finally {
  if (previousDocument === undefined) delete global.document;
  else global.document = previousDocument;
  if (previousLocation === undefined) delete global.location;
  else global.location = previousLocation;
}

const emptyScanCsv = pilot.buildCsv([]);
assert.equal(emptyScanCsv.startsWith("\uFEFF"), true);
assert.deepEqual(emptyScanCsv.replace(/^\uFEFF/, "").split("\n")[0].split(",").map((value) => value.slice(1, -1)), pilot.CSV_HEADERS);
const scanFixtureRow = Object.fromEntries(pilot.CSV_HEADERS.map((header) => [header, header === "text_excerpt" ? "A quoted, useful question" : header]));
const parsedScanFixture = mergeResults.parseCsv(pilot.buildCsv([scanFixtureRow]));
assert.deepEqual(Object.keys(parsedScanFixture[0]), pilot.CSV_HEADERS);
assert.equal(parsedScanFixture[0].text_excerpt, "A quoted, useful question");

const prospect = pilot.analyzeText(
  "Hi, I'm considering a BBL next month and looking for a reputable surgeon in Vietnam. Has anyone had this procedure?",
);
assert.equal(prospect.segment, "potential_customer");
assert.ok(prospect.intentScore >= 45);
assert.match(prospect.procedures, /bbl/);

const experienced = pilot.analyzeText(
  "I had my tummy tuck six weeks ago. Recovery was difficult during the first week, but the result is improving.",
);
assert.equal(experienced.segment, "experienced_customer");
assert.ok(experienced.authenticityScore >= 50);

const seeding = pilot.analyzeText(
  "Our clinic has the best doctor. Limited discount today, WhatsApp +84 912 345 678 or inbox me to book now!",
);
assert.equal(seeding.segment, "seed_suspect");
assert.ok(seeding.seedingRisk >= 60);

const vietnameseProspect = pilot.analyzeText(
  "Mình đang muốn nâng ngực vào tháng tới, xin review bác sĩ uy tín và chi phí khoảng bao nhiêu?",
);
assert.equal(vietnameseProspect.segment, "potential_customer");
assert.match(vietnameseProspect.procedures, /breast/);

const parsed = pilot.parseFacebookTime("2d", new Date("2026-09-16T12:00:00Z"));
assert.equal(parsed.toISOString(), "2026-09-14T12:00:00.000Z");
const parsedYear = pilot.parseFacebookTime("1 năm", new Date("2026-10-06T12:00:00Z"));
assert.equal(parsedYear.toISOString(), "2025-10-06T12:00:00.000Z");
const parsedExact = pilot.parseFacebookTime("September 30, 2026 at 11:32 PM", new Date("2026-10-07T12:00:00Z"));
assert.equal(parsedExact.getFullYear(), 2026);
assert.equal(parsedExact.getMonth(), 8);
assert.equal(parsedExact.getDate(), 30);
assert.equal(parsedExact.getHours(), 23);
assert.equal(parsedExact.getMinutes(), 32);
const parsedToday = pilot.parseFacebookTime("today at 9:15 PM", new Date("2026-10-07T12:00:00Z"));
assert.equal(parsedToday.getDate(), 7);
assert.equal(parsedToday.getHours(), 21);
assert.equal(parsedToday.getMinutes(), 15);

assert.equal(
  pilot.normalizeProfileUrl("https://www.facebook.com/groups/123/user/61586129957690/?ref=group"),
  "https://www.facebook.com/61586129957690/",
);
assert.equal(
  pilot.canonicalContentUrl("https://www.facebook.com/groups/123/posts/456/?comment_id=789&ref=share"),
  "https://www.facebook.com/groups/123/posts/456/?comment_id=789",
);
assert.equal(
  pilot.canonicalPostUrl("https://www.facebook.com/permalink.php?story_fbid=456&id=123"),
  "https://www.facebook.com/groups/123/posts/456/",
);
assert.deepEqual(pilot.inferAuthorFromText("SunnyKangaroo8613 I had my facelift yesterday"), {
  name: "SunnyKangaroo8613",
  isAnonymous: true,
});
assert.deepEqual(pilot.inferAuthorFromText("Người tham gia ẩn danh 386 Prices are very high"), {
  name: "Người tham gia ẩn danh 386",
  isAnonymous: true,
});
assert.equal(
  pilot.cleanSourceText("Alex Davey\nI had my surgery 4 giờ\nThích\nTrả lời\nXem bản dịch", "Alex Davey", "4 giờ"),
  "I had my surgery",
);
assert.equal(
  pilot.cleanSourceText("Alex Davey\nI like this result", "Alex Davey", ""),
  "I like this result",
);
assert.equal(pilot.cleanSourceText("I like", "", ""), "I like");
assert.equal(pilot.cleanSourceText("I would share", "", ""), "I would share");
assert.equal(
  pilot.cleanSourceText("Maria CarlssonYeah be careful. I had a facelift1 tuầnThíchTrả lời Chia sẻ", "Maria Carlsson", "1 tuần"),
  "Yeah be careful. I had a facelift",
);
assert.equal(
  pilot.cleanSourceText("Maria Carlsson\nI had a facelift\n… Xem thêm\nTrả lời", "Maria Carlsson", ""),
  "I had a facelift",
);
assert.equal(pilot.cleanSourceText("· Theo dõi I am considering a facelift", "", ""), "I am considering a facelift");
assert.equal(pilot.cleanSourceText("· Đang theo dõi I had a facelift", "", ""), "I had a facelift");
assert.equal(pilot.cleanSourceText("· Following I need a surgeon", "", ""), "I need a surgeon");
assert.equal(pilot.cleanSourceText("· Theo dõiThisI had a facelift", "", ""), "ThisI had a facelift");
assert.equal(pilot.cleanSourceText("Follow the doctor instructions carefully.", "", ""), "Follow the doctor instructions carefully.");
assert.equal(pilot.cleanSourceText("Following the care plan matters.", "", ""), "Following the care plan matters.");
assert.equal(pilot.cleanSourceText("Active now is a natural phrase.", "", ""), "Active now is a natural phrase.");
const boundarySanitized = pilot.classifyRecords([{
  name: "Author",
  profile_url: "https://www.facebook.com/author/",
  source_type: "post",
  post_url: "https://www.facebook.com/groups/123/posts/456/",
  comment_url: "",
  published_at_text: "2026-10-06T12:00:00.000Z",
  text: "· Theo dõiThis is a genuine post text.",
  data_quality_flags: "ui_chrome_removed",
}], { groupName: "Test Group", groupUrl: "https://www.facebook.com/groups/123/" })[0];
assert.equal(boundarySanitized.text_excerpt, "This is a genuine post text.");
assert.match(boundarySanitized.data_quality_flags, /ui_chrome_removed/);
assert.doesNotMatch(boundarySanitized.text_excerpt, /^·\s*Theo dõi/i);
const liveResidueSanitized = pilot.sanitizeRecordText({
  name: "Sk Rahan",
  published_at_text: "",
  text: "Chỉ báo trạng thái onlineĐang hoạt độngSk RahanIf you’re considering a facelift.",
});
assert.equal(liveResidueSanitized, "If you’re considering a facelift.");
assert.equal(
  pilot.cleanAuthorLabel("Sk RahanChỉ báo trạng thái onlineĐang hoạt động"),
  "Sk Rahan",
);
assert.deepEqual(pilot.detectProcedures("I had a brow lift, lower bleph and a mommy makeover."), [
  "brow_lift",
  "eyelid",
  "mommy_makeover",
]);
assert.equal(
  pilot.analyzeText("Dr Kachare. Uses the same techniques as Nayak.").doctorOrClinic,
  "Dr Kachare",
);
assert.equal(pilot.inferSourceType(true, "comment", 0), "post");
assert.equal(pilot.inferSourceType(true, "post", 0), "post");
assert.equal(pilot.inferSourceType(false, "comment", 1), "comment");
assert.equal(pilot.inferSourceType(false, "post", 2), "reply");

assert.equal(pilot.isLikelyAnonymousAlias("SunnyKangaroo8613"), true);
assert.equal(pilot.isLikelyAnonymousAlias("PastelLychee5270"), true);
assert.equal(pilot.isLikelyAnonymousAlias("CalmGrapefruit8065"), true);
assert.equal(pilot.isLikelyAnonymousAlias("TrustyRhino842"), true);
assert.equal(pilot.isLikelyAnonymousAlias("BronzeQuince902"), true);
assert.equal(pilot.isLikelyAnonymousAlias("Anonymous participant"), true);
assert.equal(pilot.isLikelyAnonymousAlias("Người tham gia ẩn danh"), true);
assert.equal(pilot.isLikelyAnonymousAlias("Soojin1901"), false);
assert.equal(pilot.isLikelyAnonymousAlias("Amanda Jane Smith"), false);

const withAnonymous = pilot.classifyRecords([
  {
    name: "Anonymous participant",
    profile_url: "",
    is_anonymous: true,
    source_type: "post",
    post_url: "https://www.facebook.com/groups/123/posts/456/",
    comment_url: "",
    published_at_text: "1h",
    published_at: "2026-09-16T11:00:00.000Z",
    text: "I want a facelift. Has anyone had this procedure?",
  },
  {
    name: "SunnyKangaroo8613",
    profile_url: "https://www.facebook.com/1130830442601705/",
    is_anonymous: false,
    source_type: "post",
    post_url: "https://www.facebook.com/groups/123/posts/457/",
    comment_url: "",
    published_at_text: "1h",
    published_at: "2026-09-16T11:00:00.000Z",
    text: "I am considering a BBL and need recommendations.",
  },
  {
    name: "Named person",
    profile_url: "https://www.facebook.com/123456789/",
    is_anonymous: false,
    source_type: "comment",
    post_url: "https://www.facebook.com/groups/123/posts/456/",
    comment_url: "https://www.facebook.com/groups/123/posts/456/",
    published_at_text: "1h",
    published_at: "2026-09-16T11:00:00.000Z",
    text: "I am considering a facelift and need recommendations.",
    data_quality_flags: "comment_permalink_missing",
  },
], { groupName: "Test Group", groupUrl: "https://www.facebook.com/groups/123/" });
assert.equal(withAnonymous.length, 3);
assert.deepEqual(Object.keys(withAnonymous[0]).slice(0, 7), [
  "group_name",
  "group_url",
  "content_url",
  "content_assessment",
  "published_at",
  "procedure",
  "doctor_name",
]);
assert.equal(withAnonymous[0].group_name, "Test Group");
assert.equal(withAnonymous[0].content_assessment, "service_question");
assert.equal(Object.prototype.hasOwnProperty.call(withAnonymous[0], "captured_at"), false);
assert.equal(withAnonymous[0].is_anonymous, "yes");
assert.equal(withAnonymous[0].profile_url, "");
assert.equal(withAnonymous[1].is_anonymous, "yes");
assert.equal(withAnonymous[1].profile_url, "");
assert.equal(withAnonymous[2].name, "Named person");
assert.equal(withAnonymous[2].data_quality_flags, "comment_permalink_missing");

const postWithCommentUrl = pilot.classifyRecords([{
  name: "Named person",
  profile_url: "https://www.facebook.com/123456789/",
  is_anonymous: false,
  source_type: "post",
  post_url: "https://www.facebook.com/groups/123/posts/456/",
  comment_url: "https://www.facebook.com/groups/123/posts/456/?comment_id=789",
  published_at_text: "1h",
  published_at: "2026-09-16T11:00:00.000Z",
  text: "I had my facelift and the recovery was difficult.",
}], { groupName: "Test Group", groupUrl: "https://www.facebook.com/groups/123/" });
assert.equal(postWithCommentUrl[0].source_type, "post");
assert.equal(postWithCommentUrl[0].content_url, "https://www.facebook.com/groups/123/posts/456/");
assert.equal(postWithCommentUrl[0].published_at_text, "2026-09-16T11:00:00.000Z");

const duplicatePostUrlRows = pilot.classifyRecords([
  {
    name: "Root Author",
    profile_url: "https://www.facebook.com/root-author/",
    source_type: "post",
    post_url: "https://www.facebook.com/groups/123/posts/456/",
    comment_url: "",
    published_at_text: "1h",
    published_at: "2026-09-16T11:00:00.000Z",
    text: "I had a facelift and the recovery was difficult.",
  },
  {
    name: "Second Author",
    profile_url: "https://www.facebook.com/second-author/",
    source_type: "post",
    post_url: "https://www.facebook.com/groups/123/posts/456/",
    comment_url: "",
    published_at_text: "50m",
    published_at: "2026-09-16T11:10:00.000Z",
    text: "I am considering a facelift and need recommendations.",
  },
  {
    name: "Explicit Comment",
    profile_url: "https://www.facebook.com/explicit-comment/",
    source_type: "comment",
    post_url: "https://www.facebook.com/groups/123/posts/456/",
    comment_url: "https://www.facebook.com/groups/123/posts/456/?comment_id=789",
    published_at_text: "40m",
    published_at: "2026-09-16T11:20:00.000Z",
    text: "The recovery was much easier than I expected.",
  },
], { groupName: "Test Group", groupUrl: "https://www.facebook.com/groups/123/" });
assert.equal(duplicatePostUrlRows[0].source_type, "post");
assert.equal(duplicatePostUrlRows[1].source_type, "comment");
assert.equal(duplicatePostUrlRows[1].comment_url, "https://www.facebook.com/groups/123/posts/456/");
assert.match(duplicatePostUrlRows[1].data_quality_flags, /source_type_inferred/);
assert.match(duplicatePostUrlRows[1].data_quality_flags, /comment_permalink_missing/);
assert.equal(duplicatePostUrlRows[2].source_type, "comment");
assert.equal(duplicatePostUrlRows[2].comment_url, "https://www.facebook.com/groups/123/posts/456/?comment_id=789");

const duplicatePostClones = pilot.classifyRecords([
  {
    name: "Root Author",
    profile_url: "https://www.facebook.com/root-author/",
    source_type: "post",
    post_url: "https://www.facebook.com/groups/123/posts/456/",
    comment_url: "",
    published_at_text: "1h",
    published_at: "2026-09-16T11:00:00.000Z",
    text: "I had a facelift and the recovery was difficult.",
  },
  {
    name: "Root Author",
    profile_url: "https://www.facebook.com/root-author/",
    source_type: "post",
    post_url: "https://www.facebook.com/groups/123/posts/456/",
    comment_url: "",
    published_at_text: "1h",
    published_at: "2026-09-16T11:00:00.000Z",
    text: "I had a facelift and the recovery was difficult.",
  },
], { groupName: "Test Group", groupUrl: "https://www.facebook.com/groups/123/" });
assert.deepEqual(duplicatePostClones.map((row) => row.source_type), ["post", "post"]);
const structuralQualityFlags = mergeResults.qualityFlagsForReport(
  { post: 1, comment: 1 },
  { source_type_inferred: 1, comment_permalink_missing: 1 },
  2,
);
assert.deepEqual(structuralQualityFlags, ["source_type_inferred", "comment_permalink_missing"]);
const duplicateScanPostUrl = "https://www.facebook.com/groups/123/posts/456/";
const mergedDuplicatePostRows = mergeResults.normalizeRows([
  {
    group_url: "https://www.facebook.com/groups/123/",
    content_url: duplicateScanPostUrl,
    source_type: "post",
    name: "Root Author",
    profile_url: "https://www.facebook.com/root-author/",
    published_at_text: "2026-09-16T11:00:00.000Z",
    text_excerpt: "I had a facelift and the recovery was difficult.",
  },
  {
    group_url: "https://www.facebook.com/groups/123/",
    content_url: duplicateScanPostUrl,
    source_type: "post",
    name: "Second Author",
    profile_url: "https://www.facebook.com/second-author/",
    published_at_text: "2026-09-16T11:10:00.000Z",
    text_excerpt: "I am considering a facelift and need recommendations.",
  },
], new Date("2026-09-17T12:00:00.000Z"));
assert.deepEqual(mergedDuplicatePostRows.map((row) => row.source_type), ["post", "comment"]);
assert.match(mergedDuplicatePostRows[1].data_quality_flags, /source_type_inferred/);
assert.match(mergedDuplicatePostRows[1].data_quality_flags, /comment_permalink_missing/);
const mergedPostClones = mergeResults.normalizeRows([
  {
    group_url: "https://www.facebook.com/groups/123/",
    content_url: duplicateScanPostUrl,
    source_type: "post",
    name: "Root Author",
    profile_url: "https://www.facebook.com/root-author/",
    published_at_text: "2026-09-16T11:00:00.000Z",
    text_excerpt: "I had a facelift and the recovery was difficult.",
  },
  {
    group_url: "https://www.facebook.com/groups/123/",
    content_url: duplicateScanPostUrl,
    source_type: "post",
    name: "Root Author",
    profile_url: "https://www.facebook.com/root-author/",
    published_at_text: "2026-09-16T11:00:00.000Z",
    text_excerpt: "I had a facelift and the recovery was difficult.",
  },
], new Date("2026-09-17T12:00:00.000Z"));
assert.deepEqual(mergedPostClones.map((row) => row.source_type), ["post", "post"]);

const noiseRow = pilot.classifyRecords([{
  name: "Someone",
  profile_url: "https://www.facebook.com/someone/",
  is_anonymous: false,
  source_type: "comment",
  post_url: "https://www.facebook.com/groups/123/posts/456/",
  comment_url: "https://www.facebook.com/groups/123/posts/456/?comment_id=789",
  published_at_text: "1h",
  published_at: "2026-09-16T11:00:00.000Z",
  text: "Nice photo, thanks for sharing.",
}], { groupName: "Test Group", groupUrl: "https://www.facebook.com/groups/123/" });
assert.equal(noiseRow[0].segment, "noise");
assert.equal(noiseRow[0].review_status, "excluded_noise");

const since = pilot.filterRecordsSince([
  { published_at: "2026-10-05T08:59:00.000Z" },
  { published_at: "2026-10-05T09:00:00.000Z" },
  { published_at: "" },
], new Date("2026-10-05T09:00:00.000Z"));
assert.equal(since.length, 2);

const repeatedPromotion = pilot.analyzeText(
  "I recommend Doctor Example. Inbox me for consultation.",
  { duplicateCount: 4, authorActivityCount: 9 },
);
assert.equal(repeatedPromotion.segment, "seed_suspect");

const clinicPromotion = pilot.analyzeText(
  "For our clients, we use JCI-accredited hospitals and can recommend the best plastic surgeon.",
);
assert.equal(clinicPromotion.segment, "seed_suspect");

const scanPostUrl = "https://www.facebook.com/groups/123/posts/456/";
const scanCommentUrl = `${scanPostUrl}?comment_id=789`;
const mergedScanRows = mergeResults.normalizeRows([
  {
    group_name: "Test Group",
    group_url: "https://www.facebook.com/groups/123/",
    content_url: scanPostUrl,
    name: "Post Author",
    profile_url: "https://www.facebook.com/post-author/",
    source_type: "post",
    published_at_text: "2026-10-06T12:00:00.000Z",
    text_excerpt: "I am considering a facelift and need recommendations.",
  },
  {
    group_name: "Test Group",
    group_url: "https://www.facebook.com/groups/123/",
    content_url: scanCommentUrl,
    name: "Comment Author",
    profile_url: "https://www.facebook.com/comment-author/",
    source_type: "comment",
    published_at_text: "2026-10-06T12:05:00.000Z",
    text_excerpt: "I had my facelift six weeks ago and recovery was difficult.",
  },
  {
    group_name: "Test Group",
    group_url: "https://www.facebook.com/groups/123/",
    content_url: `${scanPostUrl}?reply_comment_id=790`,
    name: "Reply Author",
    profile_url: "https://www.facebook.com/reply-author/",
    source_type: "reply",
    published_at_text: "2026-10-06T12:06:00.000Z",
    text_excerpt: "I agree, the recovery took time.",
  },
], new Date("2026-10-07T12:00:00.000Z"));
assert.equal(mergedScanRows[0].post_url, scanPostUrl);
assert.equal(mergedScanRows[0].content_url, scanPostUrl);
assert.equal(mergedScanRows[1].post_url, scanPostUrl);
assert.equal(mergedScanRows[1].content_url, scanCommentUrl);
assert.equal(mergedScanRows[1].comment_url, scanCommentUrl);
assert.equal(mergedScanRows[2].post_url, scanPostUrl);
assert.equal(mergedScanRows[2].source_type, "reply");
assert.equal(mergedScanRows[2].content_url, `${scanPostUrl}?reply_comment_id=790`);
assert.equal(mergedScanRows[0].published_at, "2026-10-06T12:00:00.000Z");

const contaminatedMergedRow = mergeResults.normalizeRows([{
  group_name: "Test Group",
  group_url: "https://www.facebook.com/groups/123/",
  content_url: scanPostUrl,
  source_type: "post",
  name: "Sk RahanChỉ báo trạng thái onlineĐang hoạt động",
  profile_url: "https://www.facebook.com/sk-rahan/",
  published_at_text: "2026-10-06T12:00:00.000Z",
  text_excerpt: "· Theo dõiThisI had a facelift",
}], new Date("2026-10-07T12:00:00.000Z"))[0];
assert.equal(contaminatedMergedRow.name, "Sk Rahan");
assert.match(contaminatedMergedRow.data_quality_flags, /ui_chrome_contamination/);
const naturalFollowMergedRow = mergeResults.normalizeRows([{
  group_name: "Test Group",
  group_url: "https://www.facebook.com/groups/123/",
  content_url: scanPostUrl,
  source_type: "post",
  name: "Named person",
  profile_url: "https://www.facebook.com/named-person/",
  published_at_text: "2026-10-06T12:00:00.000Z",
  text_excerpt: "Follow the doctor instructions carefully.",
}], new Date("2026-10-07T12:00:00.000Z"))[0];
assert.doesNotMatch(naturalFollowMergedRow.data_quality_flags, /ui_chrome_contamination/);

const inferredComment = mergeResults.normalizeRows([{
  group_url: "https://www.facebook.com/groups/123/",
  content_url: scanCommentUrl,
  name: "Comment Author",
  text_excerpt: "I am considering a facelift and need recommendations.",
}], new Date("2026-10-07T12:00:00.000Z"))[0];
assert.equal(inferredComment.source_type, "comment");
assert.equal(inferredComment.post_url, scanPostUrl);

const relativeTimeRow = mergeResults.normalizeRows([{
  group_name: "Thông báo",
  group_url: "https://www.facebook.com/groups/123/",
  content_url: scanPostUrl,
  source_type: "post",
  published_at_text: "1h",
  text_excerpt: "I am considering a facelift and need recommendations.",
}], new Date("2026-10-07T12:00:00.000Z"))[0];
assert.equal(relativeTimeRow.group_name, "");
assert.equal(relativeTimeRow.published_at_text, "2026-10-07T11:00:00.000Z");

const unparsedTimeRow = mergeResults.normalizeRows([{
  group_name: "Test Group",
  group_url: "https://www.facebook.com/groups/123/",
  content_url: scanPostUrl,
  source_type: "post",
  published_at_text: "time unavailable",
  text_excerpt: "I am considering a facelift and need recommendations.",
}], new Date("2026-10-07T12:00:00.000Z"))[0];
assert.equal(unparsedTimeRow.published_at_text, "time unavailable");

const sourceFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "group-scrapper-source-test-"));
try {
  for (const filename of [
    "fb_group_scan_30d_group-a.csv",
    "fb_group_leads_30d_legacy.csv",
    "fb_group_audit_30d_legacy.csv",
    "fb_group_leads_30d_merged_20261007.csv",
    "fb_group_audit_30d_merged_20261007.csv",
    "fb_group_scan_30d_repaired_all_20261007.csv",
  ]) fs.writeFileSync(path.join(sourceFixtureDir, filename), "", "utf8");
  assert.deepEqual(mergeResults.chooseSourceFiles(sourceFixtureDir).sort(), [
    "fb_group_audit_30d_legacy.csv",
    "fb_group_leads_30d_legacy.csv",
    "fb_group_scan_30d_group-a.csv",
  ]);
} finally {
  fs.rmSync(sourceFixtureDir, { recursive: true, force: true });
}

console.log("Classifier tests passed.");
