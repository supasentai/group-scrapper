"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const batch = require("./batch-runner.js");
const monitor = require("./monitor-report.js");

const DEFAULT_RESULTS_DIR = path.join(__dirname, "results");
const DEFAULT_BATCH_RUNNER = path.join(__dirname, "batch-runner.js");
const DEFAULT_AGGREGATE_RUNNER = path.join(__dirname, "aggregate-results.js");
const DEFAULT_MAX_RUNTIME_MS = 15 * 60 * 1000;
const DEFAULT_CHILD_TIMEOUT_MS = DEFAULT_MAX_RUNTIME_MS + 120 * 1000;
const DEFAULT_CHECKPOINTS_FILE = path.join(__dirname, "checkpoints.json");

function parsePositiveInteger(value, flag) {
  if (!/^\d+$/.test(String(value || ""))) throw new Error(`${flag} must be a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${flag} is out of range`);
  return number;
}

function parseArgs(argv = process.argv.slice(2)) {
  const config = {
    groupsFile: "",
    checkpointsFile: DEFAULT_CHECKPOINTS_FILE,
    captureMode: "all",
    resultsDir: DEFAULT_RESULTS_DIR,
    days: 30,
    maxRounds: 0,
    maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS,
    childTimeoutMs: DEFAULT_CHILD_TIMEOUT_MS,
    resumeManifest: "",
    retryStatuses: [],
    extraRunIds: [],
    batchRunnerPath: DEFAULT_BATCH_RUNNER,
    aggregateRunnerPath: DEFAULT_AGGREGATE_RUNNER,
    collectorPath: "",
    cdpEndpoint: "",
    profileDir: "",
    downloadTimeoutMs: null,
    previousReport: "",
    dryRun: false,
    help: false,
  };
  const valueFlags = new Set([
    "--groups-file", "--checkpoints-file", "--results-dir", "--days", "--capture-mode", "--max-rounds", "--max-runtime-ms", "--child-timeout-ms",
    "--resume-manifest", "--retry-status", "--extra-run-id", "--batch-runner-path", "--aggregate-runner-path",
    "--collector-path", "--cdp-endpoint", "--profile-dir", "--download-timeout-ms", "--previous-report",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      config.help = true;
      continue;
    }
    if (flag === "--dry-run") {
      config.dryRun = true;
      continue;
    }
    if (!valueFlags.has(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    index += 1;
    if (flag === "--groups-file") config.groupsFile = path.resolve(value);
    else if (flag === "--checkpoints-file") config.checkpointsFile = path.resolve(value);
    else if (flag === "--results-dir") config.resultsDir = path.resolve(value);
    else if (flag === "--days") config.days = parsePositiveInteger(value, flag);
    else if (flag === "--capture-mode") {
      if (!["all", "classified"].includes(String(value).toLowerCase())) throw new Error("--capture-mode must be all or classified");
      config.captureMode = String(value).toLowerCase();
    }
    else if (flag === "--max-rounds") {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${flag} is out of range`);
      config.maxRounds = Number(value);
    }
    else if (flag === "--max-runtime-ms") config.maxRuntimeMs = parsePositiveInteger(value, flag);
    else if (flag === "--child-timeout-ms") config.childTimeoutMs = parsePositiveInteger(value, flag);
    else if (flag === "--resume-manifest") config.resumeManifest = path.resolve(value);
    else if (flag === "--retry-status") config.retryStatuses = [...new Set([...config.retryStatuses, ...batch.parseRetryStatuses(value)])];
    else if (flag === "--extra-run-id") config.extraRunIds.push(value);
    else if (flag === "--batch-runner-path") config.batchRunnerPath = path.resolve(value);
    else if (flag === "--aggregate-runner-path") config.aggregateRunnerPath = path.resolve(value);
    else if (flag === "--collector-path") config.collectorPath = path.resolve(value);
    else if (flag === "--cdp-endpoint") config.cdpEndpoint = value;
    else if (flag === "--profile-dir") config.profileDir = path.resolve(value);
    else if (flag === "--download-timeout-ms") config.downloadTimeoutMs = parsePositiveInteger(value, flag);
    else if (flag === "--previous-report") config.previousReport = path.resolve(value);
  }
  if (!config.help && !config.groupsFile && !config.checkpointsFile) throw new Error("--checkpoints-file or --groups-file is required");
  return config;
}

function makeBatchCommand(config) {
  const args = [
    config.batchRunnerPath,
    config.groupsFile ? "--groups-file" : "--checkpoints-file",
    config.groupsFile || config.checkpointsFile,
    "--checkpoints-file", config.checkpointsFile,
    "--results-dir", config.resultsDir,
    "--days", String(config.days),
    "--capture-mode", config.captureMode || "all",
    "--max-rounds", String(config.maxRounds),
    "--max-runtime-ms", String(config.maxRuntimeMs),
    "--child-timeout-ms", String(config.childTimeoutMs),
  ];
  if (config.resumeManifest) args.push("--resume-manifest", config.resumeManifest);
  if (config.retryStatuses.length) args.push("--retry-status", config.retryStatuses.join(","));
  if (config.collectorPath) args.push("--collector-path", config.collectorPath);
  if (config.cdpEndpoint) args.push("--cdp-endpoint", config.cdpEndpoint);
  if (config.profileDir) args.push("--profile-dir", config.profileDir);
  if (config.downloadTimeoutMs) args.push("--download-timeout-ms", String(config.downloadTimeoutMs));
  return { executable: process.execPath, args };
}

function makeAggregateCommand(config, batchManifestPath) {
  const args = [
    config.aggregateRunnerPath,
    "--batch-manifest", batchManifestPath,
    "--results-dir", config.resultsDir,
    "--days", String(config.days),
  ];
  for (const runId of config.extraRunIds) args.push("--extra-run-id", runId);
  return { executable: process.execPath, args };
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

function runChild(command, timeoutMs = DEFAULT_CHILD_TIMEOUT_MS) {
  const result = spawnSync(command.executable, command.args, {
    cwd: __dirname,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  return {
    command,
    exit_code: timedOut ? 124 : (result.status === null ? 1 : result.status),
    timed_out: timedOut,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    json: parseJsonOutput(result.stdout),
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function cycleManifestFilename(cycleRunId) {
  return `cycle_manifest_${cycleRunId}.json`;
}

function runCycle(config, dependencies = {}) {
  const startedAt = dependencies.now ? new Date(dependencies.now) : new Date();
  if (Number.isNaN(startedAt.getTime())) throw new Error("invalid_cycle_time");
  const cycleRunId = `cycle_${startedAt.toISOString().replace(/[-:.]/g, "")}`;
  const batchCommand = makeBatchCommand(config);
  const plannedBatchPath = path.join(config.resultsDir, `batch_manifest_planned_${cycleRunId}.json`);
  const notificationReasons = [];
  const childRunner = dependencies.runChild || runChild;
  let batchResult = null;
  let aggregateResult = null;
  let batchManifestPath = plannedBatchPath;
  let aggregateReportPath = null;

  if (!config.dryRun) {
    batchResult = childRunner(batchCommand, config.childTimeoutMs);
    batchManifestPath = batchResult.json?.manifest_path || null;
    if (batchResult.json?.status === "needs_user_action") notificationReasons.push("batch_needs_user_action");
    if (["completed_with_errors", "failed"].includes(batchResult.json?.status) || batchResult.exit_code !== 0) notificationReasons.push("batch_failed");
    if (["completed_with_stopped", "stopped"].includes(batchResult.json?.status)) notificationReasons.push("batch_stopped");
    if (!batchManifestPath || !fs.existsSync(batchManifestPath)) {
      notificationReasons.push("batch_manifest_missing");
    } else {
      const aggregateCommand = makeAggregateCommand(config, batchManifestPath);
      aggregateResult = childRunner(aggregateCommand, config.childTimeoutMs);
      aggregateReportPath = aggregateResult.json?.outputs?.report_json || aggregateResult.json?.report_path || null;
      if (aggregateResult.exit_code !== 0) notificationReasons.push("aggregate_failed");
      const aggregateStatus = aggregateResult.json?.status;
      if (aggregateStatus !== "completed") notificationReasons.push(`aggregate_status_${aggregateStatus || "missing"}`);
      if (aggregateResult.json?.status === "completed_with_pending") notificationReasons.push("aggregate_pending_groups");
    }
  } else {
    notificationReasons.push("dry_run_plan");
  }

  let comparison = null;
  if (config.previousReport && aggregateReportPath && fs.existsSync(aggregateReportPath)) {
    comparison = monitor.compareReports(aggregateReportPath, config.previousReport);
    for (const reason of comparison.reasons) if (reason !== "no_previous_report") notificationReasons.push(`monitor_${reason}`);
  }
  const uniqueReasons = [...new Set(notificationReasons)];
  const needsAction = uniqueReasons.some((reason) => /needs_user_action|stopped|pending/.test(reason));
  const hasFailure = uniqueReasons.some((reason) => /failed|missing/.test(reason));
  const status = config.dryRun
    ? "dry_run"
    : needsAction
      ? "action_required"
      : hasFailure
        ? "failed"
      : "completed";
  const finishedAt = dependencies.finishedAt ? new Date(dependencies.finishedAt) : new Date();
  const manifest = {
    cycle_run_id: cycleRunId,
    parent_batch_run_id: batchResult?.json?.parent_batch_run_id || null,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    status,
    dry_run: config.dryRun,
    config,
    commands: {
      batch: batchCommand,
      aggregate: batchManifestPath ? makeAggregateCommand(config, batchManifestPath) : null,
    },
    batch_manifest_path: batchManifestPath,
    aggregate_report_path: aggregateReportPath,
    batch: batchResult ? {
      status: batchResult.json?.status || "failed",
      exit_code: batchResult.exit_code,
      timed_out: batchResult.timed_out,
      counts: batchResult.json?.counts || null,
      execution_counts: batchResult.json?.execution_counts || null,
    } : { status: "not_run", exit_code: null, timed_out: false, counts: null, execution_counts: null },
    aggregate: aggregateResult ? {
      status: aggregateResult.json?.status || "failed",
      exit_code: aggregateResult.exit_code,
      timed_out: aggregateResult.timed_out,
      counts: aggregateResult.json?.group_counts_by_status || null,
      raw_rows: aggregateResult.json?.raw_rows ?? null,
      deduped_rows: aggregateResult.json?.deduped_rows ?? null,
      in_window_rows: aggregateResult.json?.in_window_rows ?? null,
    } : { status: "not_run", exit_code: null, timed_out: false, counts: null },
    counts: {
      batch: batchResult?.json?.counts || null,
      aggregate: aggregateResult?.json?.group_counts_by_status || null,
    },
    notification: {
      notify: !config.dryRun && uniqueReasons.length > 0,
      reasons: uniqueReasons,
      summary: uniqueReasons.length ? uniqueReasons.join(", ") : "no_action",
      comparison,
    },
  };
  fs.mkdirSync(config.resultsDir, { recursive: true });
  const manifestPath = path.join(config.resultsDir, cycleManifestFilename(cycleRunId));
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { ...manifest, manifest_path: manifestPath };
}

function usage() {
  return [
    "Usage:",
    "  node cycle-runner.js --checkpoints-file <path> --results-dir <dir> [options]",
    "Options:",
    "  --groups-file <path>       Legacy CSV group source",
    "  --checkpoints-file <path> Primary JSON group/checkpoint source",
    "  --capture-mode <mode>      Collector mode: all (default) or classified",
    "  --resume-manifest <path>   Resume prior batch",
    "  --retry-status <list>      Retry statuses passed to batch",
    "  --extra-run-id <run_id>    Include explicit aggregate rerun (repeatable)",
    "  --previous-report <path>   Compare aggregate report for notification summary",
    "  --dry-run                  Plan commands without browser/child work",
    "  --child-timeout-ms <n>     Bound each child process",
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  try {
    const config = parseArgs(argv);
    if (config.help) {
      console.log(usage());
      return 0;
    }
    const cycle = runCycle(config);
    console.log(JSON.stringify(cycle, null, 2));
    return cycle.status === "completed" || cycle.status === "dry_run" ? 0 : 2;
  } catch (error) {
    console.log(JSON.stringify({ status: "failed", notification: { notify: true, reasons: ["cycle_error"] }, error: String(error.stack || error) }, null, 2));
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { cycleManifestFilename, makeAggregateCommand, makeBatchCommand, parseArgs, runChild, runCycle };
