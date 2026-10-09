"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const browserRunner = require("./browser-runner.js");
const mergeResults = require("./merge-results.js");

const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
const DEFAULT_TIMEOUT_MS = browserRunner.DEFAULT_POST_ROOT_BACKFILL_TIMEOUT_MS || 120_000;
const COMMENT_ID_PATTERN = /[?&](?:comment_id|reply_comment_id)=/i;
const BACKFILL_FLAG_PATTERN = /(?:post[_ -]?root|comment[_ -]?fallback|fallback)/i;
const FAILURE_METADATA_HEADERS = ["backfill_status", "backfill_error", "backfill_post_url"];

function usage() {
  return [
    "Usage:",
    "  node backfill-results.js --input <csv> [options]",
    "Options:",
    "  --input <path>             Filtered aggregate CSV to retry (required)",
    "  --results-dir <path>       Output parent (default: input CSV directory)",
    "  --cdp-endpoint <url>       Logged-in Edge CDP endpoint (default http://127.0.0.1:9222)",
    "  --post-root-timeout-ms <n> Timeout budget per post root (default 120000)",
    "  --help                     Show this help",
  ].join("\n");
}

function parsePositiveInteger(value, flag) {
  if (!/^\d+$/.test(String(value || ""))) throw new Error(`${flag} must be a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${flag} is out of range`);
  return number;
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
    inputPath: "",
    resultsDir: "",
    cdpEndpoint: DEFAULT_CDP_ENDPOINT,
    postRootTimeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };
  const valueFlags = new Set(["--input", "--results-dir", "--cdp-endpoint", "--post-root-timeout-ms"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      config.help = true;
      continue;
    }
    if (!valueFlags.has(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    index += 1;
    if (flag === "--input") {
      config.inputPath = path.resolve(value);
      if (path.extname(config.inputPath).toLowerCase() !== ".csv") {
        throw new Error("--input must point to a .csv file");
      }
    } else if (flag === "--results-dir") {
      config.resultsDir = path.resolve(value);
    } else if (flag === "--cdp-endpoint") {
      config.cdpEndpoint = validateCdpEndpoint(value);
    } else if (flag === "--post-root-timeout-ms") {
      config.postRootTimeoutMs = parsePositiveInteger(value, flag);
    }
  }
  if (!config.help && !config.inputPath) throw new Error("--input is required");
  if (!config.resultsDir && config.inputPath) config.resultsDir = path.dirname(config.inputPath);
  return config;
}

function pathSegments(filePath) {
  return path.resolve(filePath).split(/[\\/]+/).filter(Boolean);
}

function assertSafeOutputParent(resultsDir) {
  if (pathSegments(resultsDir).some((segment) => segment.toLowerCase() === "raw")) {
    throw new Error("--results-dir must not be inside a raw archive");
  }
}

function timestampFor(value = new Date()) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function snapshotInputFile(inputPath, outputDir, stamp = timestampFor(), fileSystem = fs) {
  const absoluteInput = path.resolve(inputPath);
  if (!fileSystem.existsSync(absoluteInput) || !fileSystem.statSync(absoluteInput).isFile()) return null;
  const inputBuffer = fileSystem.readFileSync(absoluteInput);
  const snapshotPath = path.join(outputDir, `backfill_input_${stamp}.csv`);
  fileSystem.copyFileSync(absoluteInput, snapshotPath);
  return {
    path: snapshotPath,
    sha256: crypto.createHash("sha256").update(inputBuffer).digest("hex"),
    bytes: inputBuffer.length,
  };
}

function createRetryOutputDir(resultsDir, inputPath, now = new Date(), fileSystem = fs) {
  const parent = path.resolve(resultsDir || path.dirname(inputPath));
  assertSafeOutputParent(parent);
  const baseName = `backfill_retry_${timestampFor(now)}`;
  let outputDir = path.join(parent, baseName);
  let suffix = 1;
  while (fileSystem.existsSync(outputDir)) {
    outputDir = path.join(parent, `${baseName}_${suffix}`);
    suffix += 1;
  }
  if (path.resolve(outputDir) === path.resolve(inputPath)) {
    throw new Error("Retry output directory must not be the input CSV");
  }
  return outputDir;
}

function hasBackfillQualityFlag(row) {
  return BACKFILL_FLAG_PATTERN.test(String(row?.data_quality_flags || ""));
}

function hasCommentIdentity(row) {
  return COMMENT_ID_PATTERN.test([
    row?.content_url,
    row?.comment_url,
    row?.post_url,
  ].filter(Boolean).join(" "));
}

function shouldRetryRow(row) {
  const sourceType = String(row?.source_type || "").trim().toLowerCase();
  const commentish = new Set(["comment", "reply", "fallback", "unresolved"]).has(sourceType);
  return commentish || hasCommentIdentity(row) || hasBackfillQualityFlag(row);
}

function rootUrlForRow(row) {
  return browserRunner.postRootUrlFromRow(row);
}

function groupKeyForRow(row) {
  return `${String(row?.group_url || "").trim()}\u0000${rootUrlForRow(row)}`;
}

function selectRetryRows(rows) {
  const healthyRootKeys = new Set(
    rows
      .filter((row) => String(row?.source_type || "").trim().toLowerCase() === "post"
        && !hasBackfillQualityFlag(row)
        && rootUrlForRow(row))
      .map(groupKeyForRow),
  );
  const selected = [];
  let skippedExistingRoots = 0;
  for (const row of rows) {
    if (!shouldRetryRow(row)) continue;
    const rootUrl = rootUrlForRow(row);
    if (!rootUrl) continue;
    if (healthyRootKeys.has(groupKeyForRow(row))) {
      skippedExistingRoots += 1;
      continue;
    }
    selected.push(row);
  }
  return { selected, skippedExistingRoots };
}

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const groupUrl = String(row.group_url || "").trim();
    const key = groupUrl || "__missing_group_url__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function emptyStats() {
  return {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    deduplicated: 0,
    failed_urls: [],
    quality_flags: [],
  };
}

function addStats(target, source, groupUrl) {
  for (const key of ["attempted", "succeeded", "failed", "deduplicated"]) target[key] += Number(source?.[key] || 0);
  for (const entry of source?.failed_urls || []) {
    target.failed_urls.push({ ...entry, group_url: groupUrl || undefined });
  }
  for (const flag of source?.quality_flags || []) {
    if (!target.quality_flags.includes(flag)) target.quality_flags.push(flag);
  }
}

function buildFailureRows(rows, failedUrls) {
  const failuresByRoot = new Map((failedUrls || [])
    .map((entry) => [rootUrlForRow({ content_url: entry.post_url }), entry])
    .filter(([rootUrl]) => rootUrl));
  return (rows || [])
    .map((row) => {
      const rootUrl = rootUrlForRow(row);
      const failure = failuresByRoot.get(rootUrl);
      if (!failure) return null;
      const flags = String(row.data_quality_flags || "")
        .split(/[;|]/)
        .map((flag) => flag.trim())
        .filter(Boolean);
      if (!flags.includes("post_root_backfill_failed")) flags.push("post_root_backfill_failed");
      return {
        ...row,
        data_quality_flags: flags.join(";"),
        backfill_status: "failed",
        backfill_error: String(failure.reason || "post_root_backfill_failed"),
        backfill_post_url: rootUrl,
      };
    })
    .filter(Boolean);
}

function writeFailureCsv(filePath, sourceRows, failureRows) {
  const sourceHeaders = Object.keys(sourceRows?.[0] || {});
  const headers = [...new Set([...sourceHeaders, ...FAILURE_METADATA_HEADERS])];
  const csvEscape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const body = [
    headers.map(csvEscape).join(","),
    ...(failureRows || []).map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\r\n");
  fs.writeFileSync(filePath, `\uFEFF${body}\r\n`, "utf8");
}

function loadInputRows(inputPath) {
  const absolute = path.resolve(inputPath);
  if (!fs.existsSync(absolute)) throw new Error(`Input CSV not found: ${absolute}`);
  if (!fs.statSync(absolute).isFile()) throw new Error(`Input path is not a file: ${absolute}`);
  const rows = mergeResults.parseCsv(fs.readFileSync(absolute, "utf8"));
  if (!rows.length) throw new Error(`Input CSV has no data rows: ${absolute}`);
  return rows;
}

function loadPlaywright() {
  try {
    return require("playwright-core");
  } catch (error) {
    throw new Error(`Playwright dependency missing: ${String(error.message || error)}`);
  }
}

async function runBackfill(config, dependencies = {}) {
  const inputPath = path.resolve(config.inputPath);
  assertSafeOutputParent(config.resultsDir);
  const rows = dependencies.rows || loadInputRows(inputPath);
  const selection = selectRetryRows(rows);
  const outputDir = dependencies.outputDir || createRetryOutputDir(config.resultsDir, inputPath);
  if (path.resolve(outputDir) === inputPath) throw new Error("Retry output must not overwrite input CSV");
  fs.mkdirSync(outputDir, { recursive: true });
  const runStamp = timestampFor();
  const inputSnapshot = snapshotInputFile(inputPath, outputDir, runStamp);

  const retryRows = [];
  const failureRows = [];
  const stats = emptyStats();
  const groupReports = [];
  const backfill = dependencies.backfillPostRoots || browserRunner.backfillPostRoots;
  let browser = null;
  try {
    if (selection.selected.length) {
      const playwright = dependencies.playwright || loadPlaywright();
      browser = await playwright.chromium.connectOverCDP(config.cdpEndpoint);
      const contexts = browser.contexts();
      if (!contexts.length) throw new Error("No browser context available over CDP");
      const context = contexts[0];
      for (const [groupUrl, groupRowsForRetry] of groupRows(selection.selected)) {
        const first = groupRowsForRetry[0] || {};
        const result = await backfill({
          context,
          rows: groupRowsForRetry,
          groupName: String(first.group_name || "").trim(),
          groupUrl: groupUrl === "__missing_group_url__" ? "" : groupUrl,
          timeoutMs: config.postRootTimeoutMs,
        });
        const recovered = result.rows.slice(groupRowsForRetry.length);
        retryRows.push(...recovered);
        failureRows.push(...buildFailureRows(groupRowsForRetry, result.stats.failed_urls));
        addStats(stats, result.stats, groupUrl === "__missing_group_url__" ? "" : groupUrl);
        groupReports.push({
          group_url: groupUrl === "__missing_group_url__" ? "" : groupUrl,
          input_rows: groupRowsForRetry.length,
          recovered_rows: recovered.length,
          stats: result.stats,
        });
      }
    }
  } finally {
    await (dependencies.disconnectBrowser || browserRunner.disconnectConnectedBrowser)(browser);
  }

  const stamp = runStamp;
  const outputCsv = path.join(outputDir, `post_root_backfill_retry_${stamp}.csv`);
  const failureCsv = path.join(outputDir, `post_root_backfill_failures_${stamp}.csv`);
  const outputManifest = path.join(outputDir, `post_root_backfill_retry_${stamp}.manifest.json`);
  mergeResults.writeCsv(outputCsv, retryRows);
  writeFailureCsv(failureCsv, rows, failureRows);
  const manifest = {
    version: 1,
    type: "post_root_backfill_retry",
    created_at: new Date().toISOString(),
    input_csv: inputPath,
    input_snapshot_csv: inputSnapshot?.path || null,
    input_sha256: inputSnapshot?.sha256 || null,
    input_bytes: inputSnapshot?.bytes ?? null,
    input_row_count: rows.length,
    output_csv: outputCsv,
    failure_csv: failureCsv,
    selected_rows: selection.selected.length,
    unique_post_roots: new Set(selection.selected.map(rootUrlForRow).filter(Boolean)).size,
    skipped_rows_with_existing_post_root: selection.skippedExistingRoots,
    recovered_rows: retryRows.length,
    failed_rows_preserved: failureRows.length,
    stats,
    groups: groupReports,
    collector_ran: false,
    checkpoints_updated: false,
    source_csv_overwritten: false,
    raw_archive_touched: false,
    config: {
      cdp_endpoint: config.cdpEndpoint,
      post_root_timeout_ms: config.postRootTimeoutMs,
    },
  };
  fs.writeFileSync(outputManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    status: stats.failed ? "completed_with_failures" : "completed",
    files: { csv: outputCsv, failureCsv, manifest: outputManifest },
    manifest,
  };
}

async function main(argv = process.argv.slice(2)) {
  try {
    const config = parseArgs(argv);
    if (config.help) {
      console.log(usage());
      return 0;
    }
    const summary = await runBackfill(config);
    console.log(JSON.stringify(summary, null, 2));
    return summary.status === "completed" ? 0 : 2;
  } catch (error) {
    console.log(JSON.stringify({ status: "error", error: String(error.stack || error) }, null, 2));
    return 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = {
  addStats,
  assertSafeOutputParent,
  buildFailureRows,
  createRetryOutputDir,
  hasBackfillQualityFlag,
  hasCommentIdentity,
  parseArgs,
  selectRetryRows,
  shouldRetryRow,
  snapshotInputFile,
  timestampFor,
  writeFailureCsv,
  runBackfill,
};
