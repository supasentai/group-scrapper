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
const TEMPORARY_DOWNLOAD_PATTERN = /\.(?:crdownload|part|tmp)$/i;
const SCAN_FILENAME_PATTERN = /^fb_group_scan_(\d+)d_(.+)\.csv$/i;

function usage() {
  return [
    "Usage:",
    "  node browser-runner.js --group-url <url> [options]",
    "  node browser-runner.js --prepare-profile [--cdp-endpoint <url>] [--profile-dir <path>]",
    "Options:",
    "  --collector-path <path>    Local collector source",
    "  --cdp-endpoint <url>       Edge CDP endpoint (default http://127.0.0.1:9222)",
    "  --days <n>                 Collector lookback days (default 30)",
    "  --max-rounds <n>           Bounded collector rounds (default 0)",
    "  --max-runtime-ms <n>       Bounded collector runtime (default 900000)",
    "  --results-dir <path>       Results directory",
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
    collectorPath: DEFAULT_COLLECTOR_PATH,
    cdpEndpoint: DEFAULT_CDP_ENDPOINT,
    days: 30,
    maxRounds: 0,
    maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS,
    resultsDir: DEFAULT_RESULTS_DIR,
    profileDir: path.join(os.homedir(), "AppData", "Local", "Microsoft", "Edge", "User Data", "CodexGroupScraper"),
    downloadTimeoutMs: DEFAULT_DOWNLOAD_TIMEOUT_MS,
    childTimeoutMs: DEFAULT_CHILD_TIMEOUT_MS,
    prepareProfile: false,
    help: false,
  };
  const valueFlags = new Set([
    "--group-url", "--collector-path", "--cdp-endpoint", "--days", "--max-rounds",
    "--max-runtime-ms", "--results-dir", "--profile-dir", "--download-timeout-ms", "--child-timeout-ms",
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
    else if (flag === "--collector-path") config.collectorPath = path.resolve(value);
    else if (flag === "--cdp-endpoint") config.cdpEndpoint = validateCdpEndpoint(value);
    else if (flag === "--days") config.days = parsePositiveInteger(value, flag);
    else if (flag === "--max-rounds") config.maxRounds = parsePositiveInteger(value, flag, { allowZero: true });
    else if (flag === "--max-runtime-ms") config.maxRuntimeMs = parsePositiveInteger(value, flag);
    else if (flag === "--results-dir") config.resultsDir = path.resolve(value);
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
    maxRounds: config.maxRounds,
    maxRuntimeMs: config.maxRuntimeMs,
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

async function runBrowser(config) {
  if (!fs.existsSync(config.collectorPath)) throw new Error(`Collector file not found: ${config.collectorPath}`);
  const collectorSource = fs.readFileSync(config.collectorPath, "utf8");
  fs.mkdirSync(config.resultsDir, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(config.resultsDir, ".runner-staging-"));
  const files = { stagingDir, downloads: [] };
  let browser;
  let page;
  let downloadHandler;
  let keepBrowserOpen = false;
  try {
    const playwright = loadPlaywright();
    browser = await playwright.chromium.connectOverCDP(config.cdpEndpoint);
    const contexts = browser.contexts();
    if (!contexts.length) throw new Error("No browser context available over CDP");
    const context = contexts[0];
    page = await context.newPage();
    await page.goto(config.groupUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const userAction = await detectUserAction(page);
    if (userAction) {
      keepBrowserOpen = true;
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

    await page.evaluate(({ source, options }) => {
      globalThis.__FB_GROUP_LEAD_PILOT_OPTIONS__ = options;
      globalThis.__FB_GROUP_LEAD_PILOT_ERROR__ = null;
      globalThis.__FB_GROUP_LEAD_PILOT_LAST_RUN__ = null;
      (0, eval)(source);
    }, { source: collectorSource, options: buildCollectorOptions(config) });

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
    const pairReady = await waitFor(
      async () => Boolean(findDownloadPair(fs.readdirSync(stagingDir))),
      config.downloadTimeoutMs,
    );
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

    const ingestion = runCommand(makeIngestCommand({ sourceDir: stagingDir, resultsDir: config.resultsDir }), config.childTimeoutMs);
    files.ingestion = ingestion.json || { exitCode: ingestion.exitCode, stderr: ingestion.stderr };
    if (ingestion.exitCode !== 0) throw new Error(`Ingestion failed${ingestion.timedOut ? " (timeout)" : ""}: ${ingestion.stderr || ingestion.stdout}`);
    const ingestionEntry = ingestion.json?.entries?.find((entry) => entry.csv_file === pair.csv);
    if (!ingestionEntry || !["ingested", "already_ingested"].includes(ingestionEntry.action)) {
      throw new Error(`Ingestion did not accept ${pair.csv}`);
    }
    const rawDir = path.join(config.resultsDir, manifest.run_id, "raw");
    const merge = runCommand(makeMergeCommand({ rawDir, days: config.days }), config.childTimeoutMs);
    files.merge = merge.json || { exitCode: merge.exitCode, stderr: merge.stderr };
    if (merge.exitCode !== 0) throw new Error(`Merge failed${merge.timedOut ? " (timeout)" : ""}: ${merge.stderr || merge.stdout}`);
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
      keepBrowserOpen = true;
    }
    throw error;
  } finally {
    if (page && downloadHandler) page.off("download", downloadHandler);
    if (!keepBrowserOpen) await browser?.close().catch(() => {});
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
  makeIngestCommand,
  makeMergeCommand,
  manifestFilenameFor,
  parseArgs,
  safeDownloadName,
  validateCdpEndpoint,
  validateGroupUrl,
};
