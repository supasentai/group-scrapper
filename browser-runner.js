"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
const DEFAULT_MAX_RUNTIME_MS = 15 * 60 * 1000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const DEFAULT_CHILD_TIMEOUT_MS = 120 * 1000;
const DEFAULT_COLLECTOR_PATH = path.join(__dirname, "fb-group-lead-pilot.js");
const DEFAULT_RESULTS_DIR = path.join(__dirname, "results");
const DEFAULT_CHECKPOINTS_FILE = path.join(__dirname, "checkpoints.json");
const TEMPORARY_DOWNLOAD_PATTERN = /\.(?:crdownload|part|tmp)$/i;
const SCAN_FILENAME_PATTERN = /^fb_group_scan_(\d+)d_(.+)\.csv$/i;

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
    prepareProfile: false,
    help: false,
  };
  const valueFlags = new Set([
    "--group-url", "--group-name", "--collector-path", "--cdp-endpoint", "--days", "--capture-mode", "--max-rounds",
    "--max-runtime-ms", "--results-dir", "--checkpoints-file", "--profile-dir", "--download-timeout-ms", "--child-timeout-ms",
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
  const nextRecord = {
    ...current,
    group_url: canonicalGroupUrl,
    group_name: String(lastRun.group_name || groupName || current.group_name || "").trim(),
    checkpoint,
    last_run: {
      status: lastRun.run_status || null,
      scan_started_at: lastRun.scan_started_at || null,
      completed_at: lastRun.completed_at || null,
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
    await page.goto(config.groupUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
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
    const manifest = JSON.parse(fs.readFileSync(files.manifest, "utf8").replace(/^\uFEFF/, ""));
    files.run_id = manifest.run_id;
    files.status = manifest.status;
    files.row_count = manifest.row_count;

    if (manifest.status === "stopped") {
      return {
        status: "stopped",
        run_id: manifest.run_id,
        files,
        needs_user_action: null,
        error: "Collector stopped; artifact retained and ingestion/merge were skipped.",
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
  buildEdgeLaunchCommand,
  findDownloadPair,
  isScanFilename,
  loadCheckpointMap,
  makeIngestCommand,
  makeMergeCommand,
  manifestFilenameFor,
  parseArgs,
  runBrowser,
  safeDownloadName,
  updateCheckpointManifest,
  validateCdpEndpoint,
  validateGroupName,
  validateGroupUrl,
};
