"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const pilot = require("./fb-group-lead-pilot.js");
const mergeResults = require("./merge-results.js");

const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
const DEFAULT_MAX_RUNTIME_MS = 15 * 60 * 1000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const DEFAULT_CHILD_TIMEOUT_MS = 120 * 1000;
const DEFAULT_POST_ROOT_BACKFILL_TIMEOUT_MS = 120 * 1000;
const DEFAULT_COLLECTOR_PATH = path.join(__dirname, "fb-group-lead-pilot.js");
const DEFAULT_RESULTS_DIR = path.join(__dirname, "results");
const DEFAULT_CHECKPOINTS_FILE = path.join(__dirname, "checkpoints.json");
const TEMPORARY_DOWNLOAD_PATTERN = /\.(?:crdownload|part|tmp)$/i;
const SCAN_FILENAME_PATTERN = /^fb_group_scan_(\d+)d_(.+)\.csv$/i;
const GROUP_SORTING_SETTING = "CHRONOLOGICAL";
const PUBLISHED_TIME_UNITS = "m|min|mins|h|hr|hrs|d|w|wk|wks|mo|mos|month|months|y|yr|yrs|year|years|phút|giờ|ngày|tuần|tháng|năm";
const PUBLISHED_TIME_PATTERN = new RegExp(
  `^(?:just now|now|vừa xong|hôm nay(?:\\s+lúc\\s+\\d{1,2}(?::\\d{2})?)?|hôm qua(?:\\s+lúc\\s+\\d{1,2}(?::\\d{2})?)?|today(?:\\s+at\\s+\\d{1,2}(?::\\d{2})?)?|yesterday(?:\\s+at\\s+\\d{1,2}(?::\\d{2})?)?|\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}(?:[T\\s].*)?|\\d+\\s*(?:${PUBLISHED_TIME_UNITS})(?:\\s+(?:ago|trước))?|\\d{1,2}\\s+tháng\\s+\\d{1,2}(?:\\s+năm\\s+\\d{4})?(?:\\s+lúc\\s+\\d{1,2}(?::\\d{2})?)?|\\d{1,2}\\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:\\s+\\d{2,4})?(?:\\s+at\\s+\\d{1,2}(?::\\d{2})?)?)$`,
  "i",
);
const EMBEDDED_PUBLISHED_TIME_PATTERN = new RegExp(
  `(?<![\\d.,])\\d+\\s*(?:${PUBLISHED_TIME_UNITS})(?:\\s+(?:ago|trước))?(?![\\w])`,
  "i",
);

function normalizePublishedTimeText(value) {
  return String(value || "")
    .replace(/[\u00a0\u200b-\u200d\u2060\ufeff\u034f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isPublishedTimeText(value) {
  const text = normalizePublishedTimeText(value);
  return Boolean(text && text.length <= 100 && PUBLISHED_TIME_PATTERN.test(text));
}

function extractPublishedTimeText(value, { allowEmbedded = true } = {}) {
  const normalized = normalizePublishedTimeText(value);
  if (!normalized) return "";
  const parts = normalized.split(/\r?\n|[·•]/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    if (isPublishedTimeText(part)) return part;
  }
  if (!allowEmbedded) return "";
  const embedded = normalized.match(EMBEDDED_PUBLISHED_TIME_PATTERN);
  return embedded ? embedded[0].trim() : "";
}

function normalizePublishedAt(value) {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function usage() {
  return [
    "Usage:",
    "  node browser-runner.js --group-url <url> [options]",
    "  node browser-runner.js --prepare-profile [--cdp-endpoint <url>] [--profile-dir <path>]",
    "Options:",
    "  --group-name <name>        Trusted group name for batch runs",
    "  --collector-path <path>    Local collector source",
    "  --cdp-endpoint <url>       Edge CDP endpoint (default http://127.0.0.1:9222)",
    "  --days <n>                 Collector lookback days (default 30)",
    "  --capture-mode <mode>      Capture mode: all (default) or classified",
    "  --max-rounds <n>           Bounded collector rounds (default 0)",
    "  --max-runtime-ms <n>       Bounded collector runtime (default 900000)",
    "  --results-dir <path>       Results directory",
    "  --checkpoints-file <path>  Primary JSON group/checkpoint source",
    "  --profile-dir <path>       Dedicated Edge profile directory for instructions",
    "  --download-timeout-ms <n>  Download wait timeout",
    "  --child-timeout-ms <n>     Ingestion/merge subprocess timeout",
    "  --post-root-timeout-ms <n> Post-root backfill budget per post (default 120000)",
  ].join("\n");
}

function parsePositiveInteger(value, flag, { allowZero = false } = {}) {
  if (!/^\d+$/.test(String(value || ""))) throw new Error(`${flag} must be a non-negative integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (!allowZero && number <= 0)) throw new Error(`${flag} is out of range`);
  return number;
}

function validateGroupUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_error) {
    throw new Error(`Invalid Facebook group URL: ${rawUrl}`);
  }
  if (!/^https?:$/i.test(url.protocol) || !/(^|\.)facebook\.com$/i.test(url.hostname)) {
    throw new Error(`Group URL must be on facebook.com: ${rawUrl}`);
  }
  const match = url.pathname.match(/^\/groups\/([^/]+)\/?$/i);
  if (!match) throw new Error(`Group URL must point to a group root: ${rawUrl}`);
  return `${url.protocol}//${url.hostname}/groups/${match[1]}/`;
}

function buildGroupNavigationUrl(rawUrl) {
  // Sorting is a navigation concern only. Always derive it from the
  // canonical group identity so query parameters never enter checkpoints,
  // manifests, or collector output.
  const canonicalGroupUrl = validateGroupUrl(rawUrl);
  const navigationUrl = new URL(canonicalGroupUrl);
  navigationUrl.searchParams.set("sorting_setting", GROUP_SORTING_SETTING);
  return navigationUrl.toString();
}

function validateGroupName(rawName) {
  const name = String(rawName || "").replace(/\s+/g, " ").trim();
  if (!name) throw new Error("Group name must not be empty");
  if (name.length > 200) throw new Error("Group name is too long");
  return name;
}

function validateCdpEndpoint(rawEndpoint) {
  let endpoint;
  try {
    endpoint = new URL(rawEndpoint);
  } catch (_error) {
    throw new Error(`Invalid CDP endpoint: ${rawEndpoint}`);
  }
  if (!/^(?:https?|wss?):$/i.test(endpoint.protocol)) {
    throw new Error(`CDP endpoint must use http(s) or ws(s): ${rawEndpoint}`);
  }
  return endpoint.toString().replace(/\/$/, "");
}

function parseArgs(argv = process.argv.slice(2)) {
  const config = {
    groupUrl: "",
    groupName: "",
    collectorPath: DEFAULT_COLLECTOR_PATH,
    cdpEndpoint: DEFAULT_CDP_ENDPOINT,
    days: 30,
    captureMode: "all",
    maxRounds: 0,
    maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS,
    resultsDir: DEFAULT_RESULTS_DIR,
    checkpointsFile: DEFAULT_CHECKPOINTS_FILE,
    profileDir: path.join(os.homedir(), "AppData", "Local", "Microsoft", "Edge", "User Data", "CodexGroupScraper"),
    downloadTimeoutMs: DEFAULT_DOWNLOAD_TIMEOUT_MS,
    childTimeoutMs: DEFAULT_CHILD_TIMEOUT_MS,
    postRootBackfillTimeoutMs: DEFAULT_POST_ROOT_BACKFILL_TIMEOUT_MS,
    prepareProfile: false,
    help: false,
  };
  const valueFlags = new Set([
    "--group-url", "--group-name", "--collector-path", "--cdp-endpoint", "--days", "--capture-mode", "--max-rounds",
    "--max-runtime-ms", "--results-dir", "--checkpoints-file", "--profile-dir", "--download-timeout-ms", "--child-timeout-ms", "--post-root-timeout-ms",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      config.help = true;
      continue;
    }
    if (flag === "--prepare-profile") {
      config.prepareProfile = true;
      continue;
    }
    if (!valueFlags.has(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    index += 1;
    if (flag === "--group-url") config.groupUrl = validateGroupUrl(value);
    else if (flag === "--group-name") config.groupName = validateGroupName(value);
    else if (flag === "--collector-path") config.collectorPath = path.resolve(value);
    else if (flag === "--cdp-endpoint") config.cdpEndpoint = validateCdpEndpoint(value);
    else if (flag === "--days") config.days = parsePositiveInteger(value, flag);
    else if (flag === "--capture-mode") {
      if (!["all", "classified"].includes(String(value).toLowerCase())) throw new Error("--capture-mode must be all or classified");
      config.captureMode = String(value).toLowerCase();
    }
    else if (flag === "--max-rounds") config.maxRounds = parsePositiveInteger(value, flag, { allowZero: true });
    else if (flag === "--max-runtime-ms") config.maxRuntimeMs = parsePositiveInteger(value, flag);
    else if (flag === "--results-dir") config.resultsDir = path.resolve(value);
    else if (flag === "--checkpoints-file") config.checkpointsFile = path.resolve(value);
    else if (flag === "--profile-dir") config.profileDir = path.resolve(value);
    else if (flag === "--download-timeout-ms") config.downloadTimeoutMs = parsePositiveInteger(value, flag);
    else if (flag === "--child-timeout-ms") config.childTimeoutMs = parsePositiveInteger(value, flag);
    else if (flag === "--post-root-timeout-ms") config.postRootBackfillTimeoutMs = parsePositiveInteger(value, flag);
  }
  if (!config.help && !config.prepareProfile && !config.groupUrl) {
    throw new Error("--group-url is required unless --prepare-profile is used");
  }
  return config;
}

function buildEdgeLaunchCommand({ cdpEndpoint = DEFAULT_CDP_ENDPOINT, profileDir, edgePath = "msedge.exe" }) {
  const endpoint = new URL(validateCdpEndpoint(cdpEndpoint));
  const args = [
    `--remote-debugging-port=${endpoint.port || "9222"}`,
    `--user-data-dir=${path.resolve(profileDir)}`,
  ];
  if (endpoint.hostname && !/^(?:127\.0\.0\.1|localhost|::1)$/i.test(endpoint.hostname)) {
    args.push(`--remote-debugging-address=${endpoint.hostname}`);
  }
  return { executable: edgePath, args };
}

function buildCollectorOptions(config) {
  return {
    days: config.days,
    captureMode: config.captureMode || "all",
    deferClassification: (config.captureMode || "all") !== "classified",
    maxRounds: config.maxRounds,
    maxRuntimeMs: config.maxRuntimeMs,
    groupName: config.groupName || "",
  };
}

function postRootUrlFromRow(row) {
  return pilot.canonicalPostUrl(row?.content_url || row?.post_url || "");
}

function hasCommentIdentity(value) {
  try {
    const url = new URL(String(value || ""));
    return url.searchParams.has("comment_id") || url.searchParams.has("reply_comment_id");
  } catch (_error) {
    return false;
  }
}

function postRootNavigationUrlFromRow(row, expectedPostUrl = postRootUrlFromRow(row)) {
  const expected = pilot.canonicalPostUrl(expectedPostUrl);
  if (!expected) return "";
  const candidates = [row?.content_url, row?.comment_url, row?.post_url]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return candidates.find((value) => (
    hasCommentIdentity(value) && pilot.canonicalPostUrl(value) === expected
  )) || expected;
}

function uniquePostRootSources(rows) {
  const sources = new Map();
  for (const row of rows || []) {
    const postUrl = postRootUrlFromRow(row);
    if (!postUrl || sources.has(postUrl)) continue;
    sources.set(postUrl, postRootNavigationUrlFromRow(row, postUrl));
  }
  return [...sources.entries()].map(([postUrl, navigationUrl]) => ({ postUrl, navigationUrl }));
}

function uniquePostRootUrls(rows) {
  return uniquePostRootSources(rows).map(({ postUrl }) => postUrl);
}

function remainingBackfillTimeoutMs(startedAt, timeoutMs, now = Date.now()) {
  return Math.max(0, Number(timeoutMs || 0) - (now - startedAt));
}

function classifyBackfillError(error, remainingMs = 1) {
  if (Number(remainingMs) <= 0) return "post_root_backfill_timeout";
  const message = String(error?.message || error || "").trim();
  if (/timeout|timed out|time\s*out/i.test(message)) return "navigation_timeout";
  return message.slice(0, 240) || "post_root_not_found";
}

function normalizeBackfilledPostRoot(candidate, expectedPostUrl, context = {}) {
  if (!candidate || typeof candidate !== "object") return null;
  const expected = pilot.canonicalPostUrl(expectedPostUrl);
  const postUrl = pilot.canonicalPostUrl(candidate.post_url || candidate.content_url || candidate.permalink);
  if (!expected || !postUrl || postUrl !== expected) return null;
  const rawText = String(candidate.text_excerpt || candidate.text || "").trim();
  if (!rawText) return null;
  const text = pilot.cleanSourceText(
    rawText,
    String(candidate.name || "").trim(),
    String(candidate.published_at_text || "").trim(),
  );
  if (!text) return null;
  const name = String(candidate.name || "").trim();
  const publishedAt = normalizePublishedAt(candidate.published_at);
  const publishedAtText = String(candidate.published_at_text || publishedAt || "").trim();
  // A root is accepted only when the page exposed all identifying fields we
  // need to distinguish it from a comment-shaped DOM node. Missing author or
  // time stays in the original comment context instead of becoming a partial
  // synthetic post.
  if (!name || !publishedAtText) return null;
  return {
    group_name: context.groupName || candidate.group_name || "",
    group_url: context.groupUrl || candidate.group_url || "",
    content_url: postUrl,
    post_url: postUrl,
    comment_url: "",
    name,
    profile_url: String(candidate.profile_url || "").trim(),
    source_type: "post",
    published_at: publishedAt,
    published_at_text: publishedAtText,
    text_excerpt: text,
    data_quality_flags: publishedAt ? "" : "time_unresolved",
  };
}

function deduplicateBackfilledPostRoots(rows) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows || []) {
    const postUrl = pilot.canonicalPostUrl(row?.content_url || row?.post_url || "");
    if (!postUrl || seen.has(postUrl)) continue;
    seen.add(postUrl);
    deduped.push({
      ...row,
      content_url: postUrl,
      post_url: postUrl,
      comment_url: "",
      source_type: "post",
    });
  }
  return deduped;
}

async function readPostRootCandidates(page, expectedPostUrl = "") {
  return page.evaluate((expectedUrl) => {
    // Facebook sometimes inserts U+034F and other format characters between
    // the number and unit in relative timestamps (for example `25͏ phút`).
    // Remove them before matching time, author, and message text.
    const normalize = (value) => String(value || "")
      .replace(/[\p{Cf}\u034f]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    const hrefOf = (node) => node?.href || node?.getAttribute?.("href") || "";
    const safeUrl = (value) => {
      try { return new URL(value || "", location.href); } catch (_error) { return null; }
    };
    const normalizedPath = (value) => {
      const url = safeUrl(value);
      return url ? url.pathname.replace(/\/+$/, "/") : "";
    };
    const expectedPath = normalizedPath(expectedUrl);
    const hasCommentIdentity = (href) => {
      const url = safeUrl(href);
      return Boolean(url && (url.searchParams.has("comment_id") || url.searchParams.has("reply_comment_id")));
    };
    const isPostHref = (href) => {
      const url = safeUrl(href);
      return Boolean(url
        && /\/groups\/[^/]+\/posts\/\d+\/?$/i.test(url.pathname)
        && !hasCommentIdentity(href));
    };
    const storyMessages = [...new Set([
      ...document.querySelectorAll('[data-ad-rendering-role="story_message"]'),
      ...document.querySelectorAll('[role="dialog"] [role="article"], [role="dialog"] article'),
      ...document.querySelectorAll('[role="main"] [role="article"]'),
    ])];
    const storySelector = '[data-ad-rendering-role="story_message"]';
    const titleHints = String(document.title || "")
      .split("|")
      .map(normalize)
      .filter((part, index, parts) => part && index > 0 && !/^facebook$/i.test(part) && part !== parts[0]);
    const compact = (value) => normalize(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const titleMatchesText = (text) => {
      const compactText = compact(text);
      if (compactText.length < 12) return false;
      return titleHints.some((hint) => {
        const compactHint = compact(hint);
        if (compactHint.length < 12) return false;
        const probe = compactHint.slice(0, 60);
        return compactText.includes(probe) || compactHint.includes(compactText.slice(0, 60));
      });
    };
    const looksLikeTime = (value) => {
      const text = normalize(value)
        .replace(/[\u00a0\u200b-\u200d\u2060\ufeff\u034f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text || text.length > 100) return false;
      return /^(?:just now|now|vừa xong|hôm nay(?:\s+lúc\s+\d{1,2}(?::\d{2})?)?|hôm qua(?:\s+lúc\s+\d{1,2}(?::\d{2})?)?|today(?:\s+at\s+\d{1,2}(?::\d{2})?)?|yesterday(?:\s+at\s+\d{1,2}(?::\d{2})?)?|\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s].*)?|\d+\s*(?:m|min|mins|h|hr|hrs|d|w|wk|wks|mo|mos|month|months|y|yr|yrs|year|years|phút|giờ|ngày|tuần|tháng|năm)(?:\s+(?:ago|trước))?|\d{1,2}\s+tháng\s+\d{1,2}(?:\s+năm\s+\d{4})?(?:\s+lúc\s+\d{1,2}(?::\d{2})?)?|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:\s+\d{2,4})?(?:\s+at\s+\d{1,2}(?::\d{2})?)?)$/i.test(text);
    };
    const extractTime = (value, { allowEmbedded = true } = {}) => {
      const normalized = normalize(value)
        .replace(/[\u00a0\u200b-\u200d\u2060\ufeff\u034f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!normalized) return "";
      const parts = normalized.split(/\r?\n|[·•]/).map((part) => part.trim()).filter(Boolean);
      for (const part of parts) {
        if (looksLikeTime(part)) return part;
      }
      if (!allowEmbedded) return "";
      const embedded = normalized.match(/(?<![\d.,])\d+\s*(?:m|min|mins|h|hr|hrs|d|w|wk|wks|mo|mos|month|months|y|yr|yrs|year|years|phút|giờ|ngày|tuần|tháng|năm)(?:\s+(?:ago|trước))?(?![\w])/i);
      return embedded ? embedded[0].trim() : "";
    };
    const textLines = (node) => String(node?.innerText || node?.textContent || "")
      .split(/\r?\n/)
      .map(normalize)
      .filter(Boolean);
    const authorLinkFor = (links) => links.find((link) => {
      const href = hrefOf(link);
      const url = safeUrl(href);
      const text = normalize(link.innerText || link.textContent || link.getAttribute("aria-label"));
      const pathname = url?.pathname || "";
      return Boolean(text)
        && !/\/groups\/[^/]+\/posts\//i.test(pathname)
        && !hasCommentIdentity(href)
        && !/\/groups\/[^/]+\/?$/i.test(pathname)
        && (/\/user\//i.test(pathname)
          || /\/profile\.php/i.test(pathname)
          || /^\/\d+\/?$/i.test(pathname));
    });
    const valuesFor = (link) => [
      link?.getAttribute("aria-label"),
      link?.getAttribute("title"),
      link?.getAttribute("data-tooltip-content"),
      link?.innerText,
      link?.textContent,
    ].map(normalize).filter(Boolean);
    const timeFor = (scope, postLinks) => {
      const timeNodeValues = [...scope.querySelectorAll("time[datetime], [datetime]")]
        .flatMap((node) => [node.getAttribute("datetime"), node.innerText, node.textContent])
        .map(normalize)
        .filter(Boolean);
      const postLinkValues = postLinks.flatMap(valuesFor);
      const lineValues = textLines(scope);
      const fromTimeNode = timeNodeValues.map((value) => extractTime(value, { allowEmbedded: false })).find(Boolean);
      if (fromTimeNode) return fromTimeNode;
      const fromPostLink = postLinkValues.map((value) => extractTime(value)).find(Boolean);
      if (fromPostLink) return fromPostLink;
      return lineValues.map((value) => extractTime(value, { allowEmbedded: false })).find(Boolean) || "";
    };
    const publishedAtFor = (scope) => [...scope.querySelectorAll("time[datetime], [datetime]")]
      .map((node) => node.getAttribute("datetime"))
      .map((value) => {
        const parsed = new Date(value || "");
        return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
      })
      .find(Boolean) || "";
    const nameFor = (scope, authorLink) => {
      const linkedName = normalize(authorLink?.innerText || authorLink?.textContent || authorLink?.getAttribute("aria-label"));
      if (linkedName) return linkedName;
      const lines = textLines(scope);
      const anonymousHeader = lines.find((line) => /^(?:bài viết của|post by)\s+/i.test(line));
      if (anonymousHeader) {
        return normalize(anonymousHeader.replace(/^(?:bài viết của|post by)\s+/i, ""));
      }
      return normalize(scope.querySelector(
        '[data-ad-rendering-role="story_actor_name"], [data-ad-rendering-role="actor_name"], h2, h3, [role="heading"]',
      )?.innerText || "");
    };
    const scopeFor = (message) => {
      const scopes = [];
      let node = message;
      for (let depth = 0; node && depth <= 14; depth += 1, node = node.parentElement) {
        const links = [...node.querySelectorAll("a[href]")];
        const postLinks = links.filter((link) => isPostHref(hrefOf(link)));
        const matchingPostLinks = expectedPath
          ? postLinks.filter((link) => normalizedPath(hrefOf(link)) === expectedPath)
          : postLinks;
        const matchingCommentLinks = expectedPath
          ? links.filter((link) => hasCommentIdentity(hrefOf(link))
            && normalizedPath(hrefOf(link)) === expectedPath)
          : [];
        const matchingLinks = matchingPostLinks.length ? matchingPostLinks : matchingCommentLinks;
        if (!matchingLinks.length) continue;
        // A page can retain a previous story while the requested post is
        // hydrating. An outer feed container may then expose links for both
        // stories; reject that container so stale text cannot be paired with
        // the requested post URL.
        const storyCount = (node.matches?.(storySelector) ? 1 : 0) + node.querySelectorAll(storySelector).length;
        if (storyCount > 1) continue;
        // Comment permalinks can expose only the comment URL inside the modal.
        // The expected canonical URL is safe once that comment proves the
        // requested post path.
        const postLink = matchingPostLinks[0] || { href: expectedUrl };
        const authorLink = authorLinkFor(links);
        const timeText = timeFor(node, matchingLinks);
        const publishedAt = publishedAtFor(node);
        const virtualized = node.getAttribute("data-virtualized") === "false";
        // Prefer the smallest ancestor that has enough root evidence, while
        // retaining the known virtualized card as a strong fallback.
        const score = (authorLink ? 5 : 0) + (timeText ? 4 : 0) + (virtualized ? 3 : 0) - (depth * 0.05);
        scopes.push({ node, depth, postLink, authorLink, timeText, publishedAt, score });
      }
      return scopes.sort((left, right) => right.score - left.score || left.depth - right.depth)[0] || null;
    };
    const candidates = storyMessages.map((message) => {
      // Expand only controls belonging to this story. The next polling pass
      // reads the DOM after Facebook has rendered the expanded text.
      let expandableAncestor = message;
      for (let depth = 0; expandableAncestor && depth <= 10; depth += 1, expandableAncestor = expandableAncestor.parentElement) {
        for (const control of expandableAncestor.querySelectorAll('button, [role="button"], a')) {
          const label = normalize(control.innerText || control.textContent || control.getAttribute("aria-label"));
          if (/^(?:xem thêm|see more|read more|view more)(?:\.{3})?$/i.test(label)) {
            try { control.click(); } catch (_error) { /* best-effort expansion */ }
          }
        }
      }
      const scope = scopeFor(message);
      if (!scope) return null;
      const messageNode = message.querySelector('[data-ad-preview="message"]')
        || scope.node.querySelector('[data-ad-preview="message"]')
        || scope.node.querySelector('[data-ad-rendering-role="story_message"]')
        || message;
      const rawMessage = normalize(messageNode.innerText || messageNode.textContent);
      return {
        post_url: hrefOf(scope.postLink),
        name: nameFor(scope.node, scope.authorLink),
        profile_url: hrefOf(scope.authorLink),
        published_at: scope.publishedAt,
        published_at_text: scope.timeText,
        text_excerpt: rawMessage,
        title_match: titleMatchesText(rawMessage),
      };
    }).filter((candidate) => candidate && candidate.post_url && candidate.text_excerpt);
    const titleMatched = candidates.filter((candidate) => candidate.title_match);
    // During navigation Facebook may expose a stale story with the new
    // permalink before the requested story text is hydrated. If the page has
    // a usable post title, wait for a matching story instead of pairing stale
    // content with the requested URL. Pages without a title hint retain the
    // structural fallback behavior.
    if (titleHints.length && titleMatched.length) return titleMatched;
    return candidates;
  }, expectedPostUrl);
}

async function backfillPostRoots({ context, rows, groupName = "", groupUrl = "", timeoutMs = DEFAULT_POST_ROOT_BACKFILL_TIMEOUT_MS }) {
  const rootSources = uniquePostRootSources(rows);
  const existingPostUrls = new Set((rows || [])
    .filter((row) => String(row?.source_type || "").toLowerCase() === "post")
    .map(postRootUrlFromRow)
    .filter(Boolean));
  const candidates = [];
  const stats = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    deduplicated: 0,
    failed_urls: [],
    quality_flags: [],
  };
  const pendingSources = rootSources.filter(({ postUrl }) => {
    if (existingPostUrls.has(postUrl)) {
      stats.deduplicated += 1;
      return false;
    }
    return true;
  });
  if (!pendingSources.length) return { rows: [...(rows || [])], stats };

  let backfillPage = null;
  const closeBackfillPage = async () => {
    if (!backfillPage) return;
    await backfillPage.close?.().catch(() => {});
    backfillPage = null;
  };
  try {
    for (const { postUrl, navigationUrl } of pendingSources) {
      stats.attempted += 1;
      // The CLI option is a per-post budget. A group with many comments must
      // not consume one shared clock and turn all later posts into synthetic
      // timeout failures.
      const postStartedAt = Date.now();
      const remaining = remainingBackfillTimeoutMs(postStartedAt, timeoutMs);
      if (remaining <= 0) {
        stats.failed += 1;
        stats.failed_urls.push({ post_url: postUrl, navigation_url: navigationUrl, reason: "post_root_backfill_timeout" });
        continue;
      }
      let backfilledRoot = null;
      let lastError = "post_root_not_found";
      // A fresh retry handles a transient Facebook hydration race without
      // allowing an unverified candidate to become a synthetic post.
      for (let attempt = 0; attempt < 2 && !backfilledRoot; attempt += 1) {
        try {
          // Reuse one sequential tab for the group. Navigation replaces the
          // previous DOM, while candidate extraction still validates the
          // requested permalink and title before accepting a root.
          if (!backfillPage) backfillPage = await context.newPage();
          const gotoTimeout = Math.min(20_000, remainingBackfillTimeoutMs(postStartedAt, timeoutMs));
          if (gotoTimeout <= 0) {
            lastError = "post_root_backfill_timeout";
            break;
          }
          await backfillPage.goto(navigationUrl, {
            waitUntil: "domcontentloaded",
            timeout: gotoTimeout,
          });
          if (typeof backfillPage.waitForLoadState === "function") {
            const loadTimeout = Math.min(5_000, remainingBackfillTimeoutMs(postStartedAt, timeoutMs));
            if (loadTimeout <= 0) {
              lastError = "post_root_backfill_timeout";
              break;
            }
            await backfillPage.waitForLoadState("load", {
              timeout: loadTimeout,
            }).catch(() => {});
          }
          let rawCandidates = [];
          const readBudget = Math.min(20_000, remainingBackfillTimeoutMs(postStartedAt, timeoutMs));
          if (readBudget <= 0) {
            lastError = "post_root_backfill_timeout";
            break;
          }
          const foundCandidates = await waitFor(async () => {
            try {
              rawCandidates = await readPostRootCandidates(backfillPage, postUrl);
              return rawCandidates.length > 0;
            } catch (_error) {
              return false;
            }
          }, readBudget, 350);
          if (!foundCandidates && remainingBackfillTimeoutMs(postStartedAt, timeoutMs) <= 0) {
            lastError = "post_root_backfill_timeout";
            break;
          }
          const root = deduplicateBackfilledPostRoots(rawCandidates
            .map((candidate) => normalizeBackfilledPostRoot(candidate, postUrl, { groupName, groupUrl })));
          if (root.length && root[0].content_url === postUrl) backfilledRoot = root[0];
          else lastError = "post_root_not_found";
        } catch (error) {
          lastError = classifyBackfillError(
            error,
            remainingBackfillTimeoutMs(postStartedAt, timeoutMs),
          );
          // A failed navigation can leave the page in a broken state. Close
          // only on error so the next retry gets a clean tab; normal
          // no-candidate results keep using the group tab.
          await closeBackfillPage();
        }
      }
      if (!backfilledRoot) {
        stats.failed += 1;
        stats.failed_urls.push({ post_url: postUrl, navigation_url: navigationUrl, reason: lastError });
        continue;
      }
      candidates.push(backfilledRoot);
      existingPostUrls.add(postUrl);
      stats.succeeded += 1;
    }
  } finally {
    // The group owns exactly one reusable tab and releases it before the next
    // group starts, preventing tab/RAM growth during a batch.
    await closeBackfillPage();
  }
  if (stats.failed > 0) stats.quality_flags.push("post_root_backfill_failed");
  const uniqueCandidates = deduplicateBackfilledPostRoots(candidates);
  return { rows: [...(rows || []), ...uniqueCandidates], stats };
}

function updateManifestWithPostRootBackfill(manifestPath, manifest, stats, rowCount) {
  const next = {
    ...manifest,
    row_count: rowCount,
    post_root_backfill: {
      attempted: stats.attempted,
      succeeded: stats.succeeded,
      failed: stats.failed,
      deduplicated: stats.deduplicated,
      failed_urls: stats.failed_urls,
      quality_flags: stats.quality_flags,
    },
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function makeIngestCommand({ sourceDir, resultsDir }) {
  return { executable: process.execPath, args: [path.join(__dirname, "ingest-downloads.js"), sourceDir, resultsDir] };
}

function makeMergeCommand({ rawDir, days }) {
  return { executable: process.execPath, args: [path.join(__dirname, "merge-results.js"), rawDir, String(days)] };
}

function isScanFilename(name) {
  return SCAN_FILENAME_PATTERN.test(String(name || "")) && !TEMPORARY_DOWNLOAD_PATTERN.test(String(name || ""));
}

function manifestFilenameFor(scanFilename) {
  return String(scanFilename).replace(/\.csv$/i, ".manifest.json");
}

function findDownloadPair(names) {
  const files = [...new Set(names)].filter((name) => !TEMPORARY_DOWNLOAD_PATTERN.test(name));
  const csv = files.find(isScanFilename);
  if (!csv) return null;
  const manifest = manifestFilenameFor(csv);
  if (!files.includes(manifest)) return null;
  return { csv, manifest };
}

function safeDownloadName(name) {
  const base = path.basename(String(name || ""));
  if (!base || base !== name || TEMPORARY_DOWNLOAD_PATTERN.test(base)) throw new Error(`Unsafe download filename: ${name}`);
  return base;
}

function parseJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    const lines = text.split(/\r?\n/).reverse();
    for (const line of lines) {
      try { return JSON.parse(line); } catch (_ignored) { /* keep scanning */ }
    }
  }
  return null;
}

function normalizeCheckpoint(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`checkpoint_timestamp_invalid:${value}`);
  return date.toISOString();
}

function readCheckpointDocument(filePath) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`checkpoints_file_not_found:${filePath}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`checkpoints_file_invalid:${String(error.message || error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !parsed.groups || typeof parsed.groups !== "object" || Array.isArray(parsed.groups)) {
    throw new Error("checkpoints_file_groups_invalid");
  }
  return { ...parsed, groups: { ...parsed.groups } };
}

function normalizeCheckpointMap(checkpointMap, groupUrl) {
  const map = {};
  for (const [key, value] of Object.entries(checkpointMap || {})) {
    const canonicalKey = validateGroupUrl(key);
    if (canonicalKey !== key) throw new Error(`checkpoint_map_key_not_canonical:${key}`);
    map[canonicalKey] = normalizeCheckpoint(value);
  }
  const canonicalGroupUrl = validateGroupUrl(groupUrl);
  if (!Object.prototype.hasOwnProperty.call(map, canonicalGroupUrl)) map[canonicalGroupUrl] = null;
  return map;
}

function loadCheckpointMap(filePath, groupUrl) {
  const document = readCheckpointDocument(filePath);
  const map = {};
  for (const [key, record] of Object.entries(document.groups)) {
    const canonicalKey = validateGroupUrl(key);
    if (canonicalKey !== key) throw new Error(`checkpoints_file_group_key_not_canonical:${key}`);
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`checkpoints_file_group_record_invalid:${key}`);
    }
    const recordUrl = validateGroupUrl(record.group_url);
    if (recordUrl !== canonicalKey) throw new Error(`checkpoints_file_group_url_mismatch:${key}`);
    if (!String(record.group_name || "").trim()) throw new Error(`checkpoints_file_group_name_missing:${key}`);
    map[canonicalKey] = normalizeCheckpoint(record.checkpoint);
  }
  return normalizeCheckpointMap(map, groupUrl);
}

function writeCheckpointDocument(filePath, document) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const next = { ...document, version: document.version || 1, updated_at: new Date().toISOString() };
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
  return next;
}

function updateCheckpointManifest({ filePath, groupUrl, groupName, lastRun }) {
  const naturalStatuses = new Set(["completed_with_rows", "zero_result_after_checkpoint"]);
  const recordsSeen = Number(lastRun?.records_seen);
  if (!lastRun || !naturalStatuses.has(lastRun.run_status) || lastRun.checkpoint_saved !== true
    || !lastRun.checkpoint || !Number.isFinite(recordsSeen) || recordsSeen <= 0) {
    return { updated: false, reason: lastRun?.run_status === "stopped" ? "stopped" : "checkpoint_not_saved" };
  }
  const canonicalGroupUrl = validateGroupUrl(groupUrl);
  const checkpoint = normalizeCheckpoint(lastRun.checkpoint);
  const document = readCheckpointDocument(filePath);
  const current = document.groups[canonicalGroupUrl] || {};
  const currentCheckpoint = current.checkpoint ? normalizeCheckpoint(current.checkpoint) : null;
  if (currentCheckpoint && new Date(checkpoint).getTime() <= new Date(currentCheckpoint).getTime()) {
    return { updated: false, reason: "checkpoint_not_new", checkpoint: currentCheckpoint };
  }
  const previousLastRun = current.last_run && typeof current.last_run === "object"
    ? current.last_run
    : {};
  const startedAt = normalizeCheckpoint(
    lastRun.scan_started_at
      || lastRun.started_at
      || previousLastRun.scan_started_at
      || previousLastRun.started_at
      || new Date().toISOString(),
  );
  const completedAt = normalizeCheckpoint(lastRun.completed_at || new Date().toISOString());
  const nextRecord = {
    ...current,
    group_url: canonicalGroupUrl,
    group_name: String(lastRun.group_name || groupName || current.group_name || "").trim(),
    checkpoint,
    last_run: {
      ...previousLastRun,
      status: lastRun.run_status || lastRun.status || previousLastRun.status || null,
      scan_started_at: startedAt,
      started_at: startedAt,
      completed_at: completedAt,
      checkpoint_saved: true,
      checkpoint,
      run_id: lastRun.run_id || null,
      records_seen: recordsSeen,
      classified_count: Number.isSafeInteger(lastRun.classified_count) ? lastRun.classified_count : null,
      leads_count: Number.isSafeInteger(lastRun.leads_count) ? lastRun.leads_count : null,
      audit_count: Number.isSafeInteger(lastRun.audit_count) ? lastRun.audit_count : null,
      recorded_at: new Date().toISOString(),
    },
  };
  if (!nextRecord.group_name) throw new Error(`checkpoint_group_name_missing:${canonicalGroupUrl}`);
  const next = writeCheckpointDocument(filePath, {
    ...document,
    groups: { ...document.groups, [canonicalGroupUrl]: nextRecord },
  });
  return { updated: true, checkpoint, manifest: next };
}

function runCommand(command, timeoutMs = DEFAULT_CHILD_TIMEOUT_MS) {
  const result = spawnSync(command.executable, command.args, {
    cwd: __dirname,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  if (timedOut) terminateProcessTree(result.pid);
  return {
    ...command,
    exitCode: timedOut ? 124 : (result.status === null ? 1 : result.status),
    stdout: result.stdout || "",
    stderr: timedOut ? `command_timeout_after_${timeoutMs}ms` : (result.stderr || ""),
    timedOut,
    processError: result.error ? String(result.error.message || result.error) : null,
    json: parseJsonOutput(result.stdout),
  };
}

function loadPlaywright() {
  for (const packageName of ["playwright", "playwright-core"]) {
    try {
      return require(packageName);
    } catch (_error) {
      // Try the next supported package without installing anything.
    }
  }
  const error = new Error("Playwright dependency missing. Install playwright or playwright-core in the project environment; browser-runner will not install it automatically.");
  error.code = "PLAYWRIGHT_MISSING";
  throw error;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    await wait(intervalMs);
  }
  return false;
}

async function detectUserAction(page) {
  const url = page.url();
  if (/\/(?:login|checkpoint|challenge|recover|two_factor)\b/i.test(url)) return "Facebook authentication or checkpoint page detected";
  try {
    const state = await page.evaluate(() => ({
      body: (document.body?.innerText || "").slice(0, 20_000),
      password: Boolean(document.querySelector('input[type="password"]')),
    }));
    if (state.password || /log in to facebook|create new account|security check|confirm your identity|captcha|unusual activity|suspicious login/i.test(state.body)) {
      return "Facebook login, CAPTCHA, or security checkpoint detected";
    }
  } catch (_error) {
    return "Unable to inspect Facebook authentication state";
  }
  return null;
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function terminateProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch (_error) { /* already exited */ }
}

async function disconnectConnectedBrowser(browser) {
  if (!browser || typeof browser.close !== "function") return;
  // connectOverCDP() closes the Playwright transport without closing the
  // user's Edge process. Without this cleanup the CDP websocket remains
  // referenced by Node after the manifest is written, so a zero-result child
  // can hang forever in batch mode.
  await browser.close().catch(() => {});
}

async function runBrowser(config, dependencies = {}) {
  if (!fs.existsSync(config.collectorPath)) throw new Error(`Collector file not found: ${config.collectorPath}`);
  const collectorSource = fs.readFileSync(config.collectorPath, "utf8");
  const checkpointMap = normalizeCheckpointMap(
    dependencies.checkpointMap || config.checkpointMap || loadCheckpointMap(config.checkpointsFile || DEFAULT_CHECKPOINTS_FILE, config.groupUrl),
    config.groupUrl,
  );
  fs.mkdirSync(config.resultsDir, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(config.resultsDir, ".runner-staging-"));
  const files = { stagingDir, downloads: [] };
  let browser;
  let page;
  let downloadHandler;
  let keepPageOpen = false;
  try {
    const playwright = dependencies.playwright || loadPlaywright();
    browser = await playwright.chromium.connectOverCDP(config.cdpEndpoint);
    const contexts = browser.contexts();
    if (!contexts.length) throw new Error("No browser context available over CDP");
    const context = contexts[0];
    page = await context.newPage();
    await page.goto(buildGroupNavigationUrl(config.groupUrl), { waitUntil: "domcontentloaded", timeout: 30_000 });
    const userAction = await (dependencies.detectUserAction || detectUserAction)(page);
    if (userAction) {
      keepPageOpen = true;
      return { status: "needs_user_action", needs_user_action: userAction, files };
    }

    const downloadTasks = [];
    downloadHandler = (download) => {
      let filename;
      try {
        filename = safeDownloadName(download.suggestedFilename());
        const destination = path.join(stagingDir, filename);
        const task = download.saveAs(destination).then(() => {
          files.downloads.push(destination);
          return destination;
        });
        downloadTasks.push(task);
      } catch (error) {
        downloadTasks.push(Promise.reject(error));
      }
    };
    page.on("download", downloadHandler);

    await page.evaluate(({ source, options, checkpoints }) => {
      globalThis.__FB_GROUP_CHECKPOINTS__ = checkpoints;
      globalThis.__FB_GROUP_LEAD_PILOT_OPTIONS__ = options;
      globalThis.__FB_GROUP_LEAD_PILOT_ERROR__ = null;
      globalThis.__FB_GROUP_LEAD_PILOT_LAST_RUN__ = null;
      (0, eval)(source);
    }, { source: collectorSource, options: buildCollectorOptions(config), checkpoints: checkpointMap });

    const completion = page.evaluate(async () => {
      const run = globalThis.__FB_GROUP_LEAD_PILOT_RUN__;
      if (!run || typeof run.then !== "function") throw new Error("Collector run promise was not created");
      try {
        await run;
      } catch (error) {
        return { error: String(error?.stack || error), lastRun: globalThis.__FB_GROUP_LEAD_PILOT_LAST_RUN__ };
      }
      return { error: globalThis.__FB_GROUP_LEAD_PILOT_ERROR__ || null, lastRun: globalThis.__FB_GROUP_LEAD_PILOT_LAST_RUN__ };
    });
    const completionResult = await withTimeout(
      completion,
      Math.max(config.maxRuntimeMs + 60_000, 120_000),
      "Collector timed out before completion",
    );
    if (completionResult.error) throw new Error(completionResult.error);
    const waitForPair = dependencies.waitForPair || (async ({ stagingDir, timeoutMs }) => waitFor(
      async () => Boolean(findDownloadPair(fs.readdirSync(stagingDir))),
      timeoutMs,
    ));
    const pairReady = await waitForPair({ stagingDir, timeoutMs: config.downloadTimeoutMs });
    await Promise.all(downloadTasks);
    const pair = findDownloadPair(fs.readdirSync(stagingDir));
    if (!pairReady || !pair) throw new Error("Expected scan CSV and manifest downloads were not both found");
    files.csv = path.join(stagingDir, pair.csv);
    files.manifest = path.join(stagingDir, pair.manifest);
    let manifest = JSON.parse(fs.readFileSync(files.manifest, "utf8").replace(/^\uFEFF/, ""));
    files.run_id = manifest.run_id;
    files.status = manifest.status;
    files.row_count = manifest.row_count;

    // A stopped/partial collector still produced a valid read-only artifact.
    // Backfill parent posts before deciding whether ingestion/merge/checkpoint
    // are safe; previously this early return made stopped runs lose the
    // post_root_backfill phase entirely.
    const scanRows = mergeResults.parseCsv(fs.readFileSync(files.csv, "utf8"));
    const backfill = await backfillPostRoots({
      context,
      rows: scanRows,
      groupName: config.groupName,
      groupUrl: config.groupUrl,
      timeoutMs: config.postRootBackfillTimeoutMs || DEFAULT_POST_ROOT_BACKFILL_TIMEOUT_MS,
    });
    if (backfill.rows.length !== scanRows.length) {
      fs.writeFileSync(files.csv, pilot.buildCsv(backfill.rows), "utf8");
    }
    manifest = updateManifestWithPostRootBackfill(
      files.manifest,
      manifest,
      backfill.stats,
      backfill.rows.length,
    );
    files.post_root_backfill = backfill.stats;
    files.row_count = manifest.row_count;

    if (["stopped", "partial"].includes(String(manifest.status || "").toLowerCase())) {
      files.collector_status = manifest.status;
      files.backfill_only = true;
      return {
        status: "stopped",
        run_id: manifest.run_id,
        files,
        needs_user_action: null,
        row_count: manifest.row_count,
        error: "Collector stopped/partial; post-root backfill ran read-only, ingestion/merge/checkpoint were skipped.",
      };
    }

    const executeCommand = dependencies.runCommand || runCommand;
    const ingestion = executeCommand(makeIngestCommand({ sourceDir: stagingDir, resultsDir: config.resultsDir }), config.childTimeoutMs);
    files.ingestion = ingestion.json || { exitCode: ingestion.exitCode, stderr: ingestion.stderr };
    if (ingestion.exitCode !== 0) throw new Error(`Ingestion failed${ingestion.timedOut ? " (timeout)" : ""}: ${ingestion.stderr || ingestion.stdout}`);
    const ingestionEntry = ingestion.json?.entries?.find((entry) => entry.csv_file === pair.csv);
    if (!ingestionEntry || !["ingested", "already_ingested"].includes(ingestionEntry.action)) {
      throw new Error(`Ingestion did not accept ${pair.csv}`);
    }
    const rawDir = path.join(config.resultsDir, manifest.run_id, "raw");
    const merge = executeCommand(makeMergeCommand({ rawDir, days: config.days }), config.childTimeoutMs);
    files.merge = merge.json || { exitCode: merge.exitCode, stderr: merge.stderr };
    if (merge.exitCode !== 0) throw new Error(`Merge failed${merge.timedOut ? " (timeout)" : ""}: ${merge.stderr || merge.stdout}`);
    files.last_run = completionResult.lastRun || null;
    files.checkpoint_update = updateCheckpointManifest({
      filePath: config.checkpointsFile || DEFAULT_CHECKPOINTS_FILE,
      groupUrl: config.groupUrl,
      groupName: config.groupName,
      lastRun: completionResult.lastRun,
    });
    return {
      status: manifest.status === "zero_result" ? "zero_result" : "completed",
      run_id: manifest.run_id,
      files,
      row_count: manifest.row_count,
      merge_report: merge.json,
      needs_user_action: null,
      error: null,
    };
  } catch (error) {
    if (/login|captcha|checkpoint|security|authentication/i.test(String(error.message || error))) {
      keepPageOpen = true;
    }
    throw error;
  } finally {
    if (page && downloadHandler) page.off("download", downloadHandler);
    if (!keepPageOpen && page?.close) await page.close().catch(() => {});
    await (dependencies.disconnectBrowser || disconnectConnectedBrowser)(browser);
  }
}

async function main(argv = process.argv.slice(2)) {
  try {
    const config = parseArgs(argv);
    if (config.help) {
      console.log(usage());
      return 0;
    }
    if (config.prepareProfile) {
      console.log(JSON.stringify({
        status: "prepare_profile",
        instructions: [
          "Start Edge with the dedicated profile command below.",
          "Complete Facebook login manually in that profile; browser-runner never enters credentials.",
          "After login, rerun browser-runner without --prepare-profile.",
        ],
        command: buildEdgeLaunchCommand({ cdpEndpoint: config.cdpEndpoint, profileDir: config.profileDir }),
      }, null, 2));
      return 0;
    }
    const summary = await runBrowser(config);
    console.log(JSON.stringify(summary, null, 2));
    return summary.status === "completed" || summary.status === "zero_result" ? 0 : 2;
  } catch (error) {
    const needsUserAction = /login|captcha|checkpoint|security|authentication|profile/i.test(String(error.message || error));
    console.log(JSON.stringify({
      status: needsUserAction ? "needs_user_action" : "error",
      run_id: null,
      files: {},
      needs_user_action: needsUserAction ? String(error.message || error) : null,
      error: needsUserAction ? null : String(error.stack || error),
    }, null, 2));
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = {
  buildCollectorOptions,
  backfillPostRoots,
  buildEdgeLaunchCommand,
  buildGroupNavigationUrl,
  DEFAULT_POST_ROOT_BACKFILL_TIMEOUT_MS,
  deduplicateBackfilledPostRoots,
  disconnectConnectedBrowser,
  findDownloadPair,
  isScanFilename,
  loadCheckpointMap,
  makeIngestCommand,
  makeMergeCommand,
  manifestFilenameFor,
  normalizePublishedTimeText,
  normalizePublishedAt,
  parseArgs,
  classifyBackfillError,
  remainingBackfillTimeoutMs,
  normalizeBackfilledPostRoot,
  postRootNavigationUrlFromRow,
  postRootUrlFromRow,
  readPostRootCandidates,
  runBrowser,
  safeDownloadName,
  extractPublishedTimeText,
  isPublishedTimeText,
  updateCheckpointManifest,
  validateCdpEndpoint,
  validateGroupName,
  validateGroupUrl,
};
