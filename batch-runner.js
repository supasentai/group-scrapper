"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const browserRunner = require("./browser-runner.js");
const mergeResults = require("./merge-results.js");

const DEFAULT_DAYS = 30;
const DEFAULT_MAX_RUNTIME_MS = 15 * 60 * 1000;
const DEFAULT_CHILD_TIMEOUT_MS = DEFAULT_MAX_RUNTIME_MS + 120 * 1000;
const DEFAULT_RESULTS_DIR = path.join(__dirname, "results");
const DEFAULT_RUNNER_PATH = path.join(__dirname, "browser-runner.js");
const DEFAULT_COLLECTOR_PATH = path.join(__dirname, "fb-group-lead-pilot.js");

function usage() {
  return [
    "Usage:",
    "  node batch-runner.js --groups-file <csv> --results-dir <dir> --days <n> [options]",
    "Options:",
    "  --groups-file <path>       Vietnamese group list CSV with TÊN HỘI NHÓM and LINK",
    "  --results-dir <path>       Results directory (default .\\results)",
    "  --days <n>                 Collector lookback days (default 30)",
    "  --max-rounds <n>           Bounded collector rounds (default 0)",
    "  --max-runtime-ms <n>       Per-group collector runtime (default 900000)",
    "  --child-timeout-ms <n>     Per-group browser-runner process timeout",
    "  --runner-path <path>       Browser runner script",
    "  --collector-path <path>   Local collector source",
    "  --cdp-endpoint <url>       Edge CDP endpoint",
    "  --profile-dir <path>       Dedicated Edge profile directory",
    "  --download-timeout-ms <n>  Download wait timeout",
  ].join("\n");
}

function parsePositiveInteger(value, flag, { allowZero = false } = {}) {
  if (!/^\d+$/.test(String(value || ""))) throw new Error(`${flag} must be a non-negative integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (!allowZero && number <= 0)) throw new Error(`${flag} is out of range`);
  return number;
}

function parseCsvRows(input) {
  const text = String(input || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("groups_file_unclosed_quote");
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function normalizeHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isBlankRow(values) {
  return values.every((value) => !String(value || "").trim());
}

function parseGroupsCsv(input) {
  const rows = parseCsvRows(input);
  const headerIndex = rows.findIndex((values) => {
    const headers = values.map(normalizeHeader);
    return headers.some((header) => header === "ten hoi nhom")
      && headers.some((header) => header === "link" || header === "url");
  });
  if (headerIndex < 0) throw new Error("groups_file_missing_ten_hoi_nhom_or_link_headers");

  const headers = rows[headerIndex].map(normalizeHeader);
  const nameIndex = headers.indexOf("ten hoi nhom");
  const linkIndex = headers.findIndex((header) => header === "link" || header === "url");
  const entries = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const values = rows[index];
    const inputRow = index + 1;
    if (isBlankRow(values)) {
      entries.push({ input_row: inputRow, group_name: "", group_url: "", status: "skipped_blank", error: null });
      continue;
    }
    entries.push({
      input_row: inputRow,
      group_name: String(values[nameIndex] || "").trim(),
      group_url: String(values[linkIndex] || "").trim(),
      status: "pending",
      error: null,
    });
  }
  return { header_row: headerIndex + 1, entries };
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function parseJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    for (const line of text.split(/\r?\n/).reverse()) {
      try { return JSON.parse(line); } catch (_ignored) { /* keep scanning */ }
    }
  }
  return null;
}

function parseArgs(argv = process.argv.slice(2)) {
  const config = {
    groupsFile: "",
    resultsDir: DEFAULT_RESULTS_DIR,
    days: DEFAULT_DAYS,
    maxRounds: 0,
    maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS,
    childTimeoutMs: DEFAULT_CHILD_TIMEOUT_MS,
    runnerPath: DEFAULT_RUNNER_PATH,
    collectorPath: DEFAULT_COLLECTOR_PATH,
    cdpEndpoint: "http://127.0.0.1:9222",
    profileDir: path.join(os.homedir(), "AppData", "Local", "Microsoft", "Edge", "User Data", "CodexGroupScraper"),
    downloadTimeoutMs: 60 * 1000,
    help: false,
  };
  const valueFlags = new Set([
    "--groups-file", "--results-dir", "--days", "--max-rounds", "--max-runtime-ms",
    "--child-timeout-ms", "--runner-path", "--collector-path", "--cdp-endpoint",
    "--profile-dir", "--download-timeout-ms",
  ]);
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
    if (flag === "--groups-file") config.groupsFile = path.resolve(value);
    else if (flag === "--results-dir") config.resultsDir = path.resolve(value);
    else if (flag === "--days") config.days = parsePositiveInteger(value, flag);
    else if (flag === "--max-rounds") config.maxRounds = parsePositiveInteger(value, flag, { allowZero: true });
    else if (flag === "--max-runtime-ms") config.maxRuntimeMs = parsePositiveInteger(value, flag);
    else if (flag === "--child-timeout-ms") config.childTimeoutMs = parsePositiveInteger(value, flag);
    else if (flag === "--runner-path") config.runnerPath = path.resolve(value);
    else if (flag === "--collector-path") config.collectorPath = path.resolve(value);
    else if (flag === "--cdp-endpoint") config.cdpEndpoint = browserRunner.validateCdpEndpoint(value);
    else if (flag === "--profile-dir") config.profileDir = path.resolve(value);
    else if (flag === "--download-timeout-ms") config.downloadTimeoutMs = parsePositiveInteger(value, flag);
  }
  if (!config.help && !config.groupsFile) throw new Error("--groups-file is required");
  return config;
}

function prepareEntries(parsed) {
  const seen = new Map();
  return parsed.entries.map((entry) => {
    if (entry.status !== "pending") return { ...entry, run_id: null, row_count: null, needs_user_action: null };
    if (!entry.group_name) return { ...entry, status: "skipped_invalid", error: "missing_group_name", run_id: null, row_count: null, needs_user_action: null };
    let groupUrl;
    try {
      groupUrl = browserRunner.validateGroupUrl(entry.group_url);
    } catch (error) {
      return { ...entry, status: "skipped_invalid", error: String(error.message || error), run_id: null, row_count: null, needs_user_action: null };
    }
    if (seen.has(groupUrl)) {
      return {
        ...entry,
        group_url: groupUrl,
        status: "skipped_duplicate",
        error: `duplicate_of_input_row_${seen.get(groupUrl)}`,
        run_id: null,
        row_count: null,
        needs_user_action: null,
      };
    }
    seen.set(groupUrl, entry.input_row);
    return { ...entry, group_url: groupUrl, status: "pending", error: null, run_id: null, row_count: null, needs_user_action: null };
  });
}

function makeRunnerArgs(group, config) {
  return [
    config.runnerPath,
    "--group-url", group.group_url,
    "--group-name", group.group_name,
    "--collector-path", config.collectorPath,
    "--cdp-endpoint", config.cdpEndpoint,
    "--days", String(config.days),
    "--max-rounds", String(config.maxRounds),
    "--max-runtime-ms", String(config.maxRuntimeMs),
    "--results-dir", config.resultsDir,
    "--profile-dir", config.profileDir,
    "--download-timeout-ms", String(config.downloadTimeoutMs),
    "--child-timeout-ms", String(config.childTimeoutMs),
  ];
}

function invokeBrowserRunner(group, config) {
  const command = { executable: process.execPath, args: makeRunnerArgs(group, config) };
  const result = spawnSync(command.executable, command.args, {
    cwd: __dirname,
    encoding: "utf8",
    windowsHide: true,
    timeout: config.childTimeoutMs,
    killSignal: "SIGTERM",
  });
  if (result.error?.code === "ETIMEDOUT") {
    return { status: "error", error: `browser_runner_timeout_after_${config.childTimeoutMs}ms`, child_timed_out: true };
  }
  const summary = parseJsonOutput(result.stdout);
  if (!summary) {
    return {
      status: "error",
      error: `browser_runner_invalid_json${result.stderr ? `:${String(result.stderr).trim()}` : ""}`,
      child_exit_code: result.status,
    };
  }
  return { ...summary, child_exit_code: result.status, child_stderr: result.stderr || "" };
}

function readValidManifest(outcome, expectedGroupUrl = "") {
  const manifestPath = outcome?.files?.manifest || outcome?.manifest_path;
  if (!manifestPath || !fs.existsSync(manifestPath)) throw new Error("browser_runner_manifest_missing");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`browser_runner_manifest_invalid:${String(error.message || error)}`);
  }
  if (!manifest || !["completed", "zero_result", "stopped"].includes(manifest.status)) {
    throw new Error("browser_runner_manifest_status_invalid");
  }
  if (!Number.isSafeInteger(manifest.row_count) || manifest.row_count < 0) {
    throw new Error("browser_runner_manifest_row_count_invalid");
  }
  if (!manifest.run_id) throw new Error("browser_runner_manifest_run_id_missing");
  if (expectedGroupUrl) {
    let actualGroupUrl;
    try {
      actualGroupUrl = browserRunner.validateGroupUrl(manifest.group_url);
    } catch (_error) {
      throw new Error("browser_runner_manifest_group_url_invalid");
    }
    if (actualGroupUrl !== expectedGroupUrl) throw new Error("browser_runner_manifest_group_url_mismatch");
  }

  const outputFile = String(manifest.output_file || "").trim();
  if (outputFile && (path.basename(outputFile) !== outputFile || /[\\/]/.test(outputFile))) {
    throw new Error("browser_runner_manifest_output_file_invalid");
  }
  const csvPath = outcome?.files?.csv
    || (outcome?.files?.stagingDir && outputFile ? path.join(outcome.files.stagingDir, outputFile) : "");
  if (csvPath) {
    if (!fs.existsSync(csvPath)) throw new Error("browser_runner_csv_missing");
    if (outputFile && path.basename(csvPath) !== outputFile) {
      throw new Error("browser_runner_manifest_output_file_mismatch");
    }
    let csvRows;
    try {
      csvRows = mergeResults.parseCsv(fs.readFileSync(csvPath, "utf8")).length;
    } catch (error) {
      throw new Error(`browser_runner_csv_invalid:${String(error.message || error)}`);
    }
    if (csvRows !== manifest.row_count) {
      throw new Error(`browser_runner_csv_row_count_mismatch:${csvRows}:${manifest.row_count}`);
    }
  }
  return { manifest, manifestPath, csvPath };
}

function normalizeOutcome(outcome, expectedGroupUrl = "") {
  if (!outcome || typeof outcome !== "object") return { status: "failed", error: "browser_runner_no_result" };
  if (outcome.status === "needs_user_action") {
    return { status: "needs_user_action", run_id: outcome.run_id || null, row_count: null, needs_user_action: outcome.needs_user_action || "user_action_required", error: null };
  }
  if (outcome.status === "error") return { status: "failed", run_id: outcome.run_id || null, row_count: null, needs_user_action: null, error: outcome.error || "browser_runner_error" };
  try {
    const { manifest, manifestPath } = readValidManifest(outcome, expectedGroupUrl);
    if (outcome.status !== manifest.status) throw new Error("browser_runner_summary_manifest_status_mismatch");
    if (manifest.status === "zero_result") {
      if (manifest.row_count !== 0) throw new Error("zero_result_manifest_has_rows");
      return { status: "zero_result", run_id: manifest.run_id, row_count: 0, needs_user_action: null, error: null, manifest_path: manifestPath };
    }
    if (manifest.status === "completed") {
      if (manifest.row_count <= 0) throw new Error("completed_manifest_has_no_rows");
      return { status: "completed_with_rows", run_id: manifest.run_id, row_count: manifest.row_count, needs_user_action: null, error: null, manifest_path: manifestPath };
    }
    return { status: "stopped", run_id: manifest.run_id, row_count: manifest.row_count, needs_user_action: null, error: outcome.error || "browser_runner_stopped", manifest_path: manifestPath };
  } catch (error) {
    return { status: "failed", run_id: outcome.run_id || null, row_count: null, needs_user_action: null, error: String(error.message || error) };
  }
}

function countStatuses(groups) {
  const counts = {};
  for (const group of groups) counts[group.status] = (counts[group.status] || 0) + 1;
  return counts;
}

function batchManifestFilename(batchRunId) {
  return `batch_manifest_${batchRunId}.json`;
}

function runBatch(config, dependencies = {}) {
  const inputPath = path.resolve(config.groupsFile);
  const inputBuffer = fs.readFileSync(inputPath);
  const parsed = parseGroupsCsv(inputBuffer.toString("utf8"));
  const groups = prepareEntries(parsed);
  const requestedGroupCount = groups.filter((group) => group.status === "pending").length;
  const runner = dependencies.runGroup || ((group) => invokeBrowserRunner(group, config));
  const startedAt = new Date();
  let blocked = false;
  for (const group of groups) {
    if (group.status !== "pending") continue;
    if (blocked) {
      group.status = "not_run";
      group.error = "batch_stopped_after_needs_user_action";
      continue;
    }
    let outcome;
    try {
      outcome = runner(group, config);
    } catch (error) {
      outcome = { status: "error", error: String(error.stack || error) };
    }
    const normalized = normalizeOutcome(outcome, group.group_url);
    Object.assign(group, normalized);
    if (group.status === "needs_user_action") blocked = true;
  }
  const finishedAt = new Date();
  const counts = countStatuses(groups);
  const batchRunId = `batch_${startedAt.toISOString().replace(/[-:.]/g, "")}`;
  const manifest = {
    batch_run_id: batchRunId,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    status: counts.needs_user_action
      ? "needs_user_action"
      : counts.failed
        ? "completed_with_errors"
        : counts.stopped
          ? "completed_with_stopped"
          : "completed",
    input_path: inputPath,
    input_hash: sha256(inputBuffer),
    header_row: parsed.header_row,
    input_row_count: groups.length,
    requested_group_count: requestedGroupCount,
    groups,
    counts,
  };
  fs.mkdirSync(config.resultsDir, { recursive: true });
  const manifestPath = path.join(config.resultsDir, batchManifestFilename(batchRunId));
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { ...manifest, manifest_path: manifestPath };
}

function main(argv = process.argv.slice(2)) {
  try {
    const config = parseArgs(argv);
    if (config.help) {
      console.log(usage());
      return 0;
    }
    const manifest = runBatch(config);
    console.log(JSON.stringify(manifest, null, 2));
    return manifest.status === "completed" ? 0 : 2;
  } catch (error) {
    console.log(JSON.stringify({ status: "failed", error: String(error.stack || error) }, null, 2));
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  batchManifestFilename,
  countStatuses,
  invokeBrowserRunner,
  makeRunnerArgs,
  normalizeOutcome,
  parseArgs,
  parseCsvRows,
  parseGroupsCsv,
  prepareEntries,
  runBatch,
  sha256,
};
