"use strict";

const HARD_URL_PATTERNS = [
  /\/(?:login|checkpoint|challenge|recover|two_factor)\b/i,
];

const HARD_TEXT_PATTERNS = [
  /confirm your identity/i,
  /security check/i,
  /unusual activity/i,
  /suspicious login/i,
  /you(?:'|’)ve been temporarily blocked/i,
  /temporarily blocked/i,
  /your account has been restricted/i,
  /action blocked/i,
  /you can(?:not|'t|’t) use this feature right now/i,
  /we limit how often/i,
  /too many requests/i,
  /captcha/i,
];

const SOFT_TEXT_PATTERNS = [
  /something went wrong/i,
  /content isn(?:'|’)t available/i,
  /try again later/i,
  /couldn(?:'|’)t load/i,
  /please wait/i,
];

function normalizeText(value) {
  return String(value || "")
    .replace(/[\u00a0\u200b-\u200d\u2060\ufeff\u034f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(text, patterns) {
  return patterns.find((pattern) => pattern.test(text)) || null;
}

function detectProfileLimit(input = {}) {
  const url = normalizeText(input.url);
  const body = normalizeText(input.body);
  const networkError = normalizeText(input.networkError || input.cdpError || input.navigationError);
  const feed = input.feed && typeof input.feed === "object" ? input.feed : {};
  const evidence = [];

  const hardUrl = firstMatch(url, HARD_URL_PATTERNS);
  const hardText = firstMatch(body, HARD_TEXT_PATTERNS);
  if (hardUrl) evidence.push(`hard_url:${hardUrl.source}`);
  if (hardText) evidence.push(`hard_text:${hardText.source}`);
  if (hardUrl || hardText) {
    return {
      status: "profile_limited_hard",
      confidence: "high",
      evidence,
      action: "stop_and_switch_manually",
    };
  }

  if (networkError) {
    return {
      status: "network_or_cdp_error",
      confidence: "high",
      evidence: [`network_error:${networkError.slice(0, 240)}`],
      action: "retry_same_profile_after_connectivity_check",
    };
  }

  const softText = firstMatch(body, SOFT_TEXT_PATTERNS);
  if (softText) evidence.push(`soft_text:${softText.source}`);

  const scrollAttempts = Number(feed.scrollAttempts || 0);
  const progressEvents = Number(feed.progressEvents || 0);
  const topLevelArticlesBefore = Number(feed.topLevelArticlesBefore || 0);
  const topLevelArticlesAfter = Number(feed.topLevelArticlesAfter || 0);
  const loadingSkeletonSeen = feed.loadingSkeletonSeen === true;
  const feedHasArticles = topLevelArticlesBefore > 0 || topLevelArticlesAfter > 0;
  const feedProgressed = progressEvents > 0 || topLevelArticlesAfter > topLevelArticlesBefore;
  // A visible feed that has already progressed is evidence against a profile
  // limit. Facebook commonly leaves a loading skeleton in the DOM during a
  // normal virtualized-feed transition.
  const noFeedProgress = scrollAttempts >= 3 && progressEvents === 0 && !feedHasArticles;
  const articleCountStalled = topLevelArticlesBefore > 0
    && topLevelArticlesAfter <= topLevelArticlesBefore
    && scrollAttempts >= 3
    && !feedHasArticles;

  if (noFeedProgress) evidence.push("feed_no_progress_after_retries");
  if (articleCountStalled) evidence.push("article_count_stalled_after_retries");
  if (loadingSkeletonSeen && !feedHasArticles) evidence.push("loading_skeleton_seen");
  if (feedHasArticles) evidence.push("feed_articles_present");
  if (feedProgressed) evidence.push("feed_progress_observed");

  const independentSoftSignals = [
    Boolean(softText),
    noFeedProgress,
    articleCountStalled,
  ].filter(Boolean).length;
  if (independentSoftSignals >= 2) {
    return {
      status: "profile_limited_soft",
      confidence: "medium",
      evidence,
      action: "stop_and_switch_manually",
    };
  }

  if (noFeedProgress || articleCountStalled || (loadingSkeletonSeen && !feedHasArticles)) {
    return {
      status: "feed_dom_stalled",
      confidence: "low",
      evidence,
      action: "reload_once_then_recheck",
    };
  }

  return {
    status: "healthy",
    confidence: "high",
    evidence: [],
    action: "continue",
  };
}

module.exports = {
  detectProfileLimit,
  normalizeText,
};
