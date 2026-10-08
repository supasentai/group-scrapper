"use strict";

const fs = require("node:fs");
const path = require("node:path");
const browserRunner = require("./browser-runner.js");
const ingest = require("./ingest-downloads.js");
const mergeResults = require("./merge-results.js");

const DEFAULT_RESULTS_DIR = path.join(__dirname, "results");
const DEFAULT_DAYS = 30;
const TEMPORAL_FALLBACK_DAYS = 30;
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const SCAN_FILENAME_PATTERN = /^fb_group_scan_\d+d_.+\.csv$/i;
const CLEANUP_INTERMEDIATE_PATTERNS = [
  /^fb_group_aggregate_(?:all|posts|comments_context|unresolved_context|classified|leads|audit)_.*\.csv$/i,
  /^aggregate_report_.*\.(?:json|md)$/i,
  /^quality_report_.*\.json$/i,
  /^ingestion_report\.json$/i,
];

function isRawScanFilename(name) {
  return SCAN_FILENAME_PATTERN.test(String(name || ""))
    && !/(?:_repaired_|_merged_|_leads_|_audit_)/i.test(String(name || ""));
}

function usage() {
  return [
    "Usage:",
    "  node aggregate-results.js --batch-manifest <path> --results-dir <dir> [options]",
    "Options:",
    "  --extra-run-id <run_id>  Include an explicitly rerun run (repeatable)",
    "  --days <n>               In-window lookback for the aggregate report (default 30)",
    "  --classify               Explicitly create classified/leads/audit outputs",
    "  --no-cleanup             Keep per-run and intermediate outputs for inspection",
  ].join("\n");
}

function parsePositiveInteger(value, flag) {
  if (!/^\d+$/.test(String(value || ""))) throw new Error(`${flag} must be a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${flag} is out of range`);
  return number;
}

function validateRunId(value) {
  const runId = String(value || "").trim();
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid run ID: ${value}`);
  return runId;
}

function parseTemporalTimestamp(value, label = "temporal_timestamp") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label}_invalid:${value}`);
  return date;
}

function temporalBoundaryForGroup(entry, now, fallbackDays = TEMPORAL_FALLBACK_DAYS) {
  const checkpoint = entry?.checkpoint
    ? parseTemporalTimestamp(entry.checkpoint, "checkpoint_timestamp")
    : null;
  const boundary = checkpoint || new Date(now.getTime() - fallbackDays * 86_400_000);
  return {
    boundary,
    boundary_iso: boundary.toISOString(),
    boundary_type: checkpoint ? "checkpoint" : "fallback_30d",
    checkpoint: checkpoint ? checkpoint.toISOString() : null,
  };
}

function applyTemporalGate(rows, groupEntries, now, fallbackDays = TEMPORAL_FALLBACK_DAYS) {
  const entriesByUrl = new Map();
  for (const entry of groupEntries || []) {
    if (entry?.group_url) entriesByUrl.set(entry.group_url, entry);
  }
  const boundaries = new Map();
  const boundaryFor = (groupUrl) => {
    if (!boundaries.has(groupUrl)) {
      boundaries.set(groupUrl, temporalBoundaryForGroup(entriesByUrl.get(groupUrl), now, fallbackDays));
    }
    return boundaries.get(groupUrl);
  };
  const eligible = [];
  const old = [];
  const unknown = [];
  for (const row of rows) {
    if (!row._date) {
      unknown.push(row);
      continue;
    }
    const boundary = boundaryFor(row.group_url).boundary;
    if (row._date >= boundary) eligible.push(row);
    else old.push(row);
  }
  return {
    eligible,
    old,
    unknown,
    boundaries: Object.fromEntries([...boundaries.entries()].map(([groupUrl, value]) => [groupUrl, {
      boundary: value.boundary_iso,
      boundary_type: value.boundary_type,
      checkpoint: value.checkpoint,
    }])),
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const config = {
    batchManifest: "",
    resultsDir: DEFAULT_RESULTS_DIR,
    extraRunIds: [],
    days: DEFAULT_DAYS,
    classify: false,
    cleanup: true,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      config.help = true;
      continue;
    }
    if (flag === "--classify") {
      config.classify = true;
      continue;
    }
    if (flag === "--no-cleanup") {
      config.cleanup = false;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    index += 1;
    if (flag === "--batch-manifest") config.batchManifest = path.resolve(value);
    else if (flag === "--results-dir") config.resultsDir = path.resolve(value);
    else if (flag === "--extra-run-id") config.extraRunIds.push(validateRunId(value));
    else if (flag === "--days") config.days = parsePositiveInteger(value, flag);
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!config.help && !config.batchManifest) throw new Error("--batch-manifest is required");
  return config;
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label}_missing:${filePath}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`${label}_invalid:${String(error.message || error)}`);
  }
}

function readBatchManifest(filePath) {
  const manifest = readJson(filePath, "batch_manifest");
  if (!manifest || !Array.isArray(manifest.groups)) throw new Error("batch_manifest_groups_missing");
  return manifest;
}

function manifestFilenameFor(csvFilename) {
  return String(csvFilename).replace(/\.csv$/i, ".manifest.json");
}

function expectedArtifactStatus(batchStatus) {
  return {
    completed_with_rows: "completed",
    zero_result: "zero_result",
    stopped: "stopped",
  }[batchStatus] || "";
}

function findArtifactPair(resultsDir, runId) {
  const rawDir = path.join(resultsDir, runId, "raw");
  if (!fs.existsSync(rawDir) || !fs.statSync(rawDir).isDirectory()) {
    throw new Error(`raw_directory_missing:${runId}`);
  }
  const names = fs.readdirSync(rawDir);
  const candidates = [];
  for (const csvFilename of names.filter(isRawScanFilename)) {
    const manifestFilename = manifestFilenameFor(csvFilename);
    const manifestPath = path.join(rawDir, manifestFilename);
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = readJson(manifestPath, "child_manifest");
    } catch (error) {
      candidates.push({ csvFilename, manifestFilename, manifestPath, error: error.message });
      continue;
    }
    if (manifest.run_id === runId) {
      candidates.push({
        csvFilename,
        manifestFilename,
        manifestPath,
        csvPath: path.join(rawDir, csvFilename),
        manifest,
      });
    }
  }
  if (candidates.length === 0) throw new Error(`raw_artifact_pair_missing:${runId}`);
  if (candidates.length > 1) throw new Error(`raw_artifact_pair_ambiguous:${runId}`);
  return candidates[0];
}

function validateArtifact(pair, expected = {}) {
  if (pair.error) throw new Error(pair.error);
  const { manifest } = pair;
  if (!manifest || manifest.run_id !== expected.runId) throw new Error("child_manifest_run_id_mismatch");
  if (!["completed", "zero_result", "stopped"].includes(manifest.status)) throw new Error("child_manifest_status_invalid");
  if (path.basename(String(manifest.output_file || "")) !== pair.csvFilename
    || /[\\/]/.test(String(manifest.output_file || ""))) {
    throw new Error("child_manifest_output_file_mismatch");
  }
  if (!Number.isInteger(manifest.row_count) || manifest.row_count < 0) throw new Error("child_manifest_row_count_invalid");
  const rows = ingest.parseScanCsv(fs.readFileSync(pair.csvPath), pair.csvFilename);
  if (rows.length !== manifest.row_count) throw new Error(`child_row_count_mismatch:${rows.length}:${manifest.row_count}`);
  if (manifest.status === "zero_result" && rows.length !== 0) throw new Error("child_zero_result_with_rows");
  if (expected.group_url && manifest.group_url !== expected.group_url) throw new Error("child_manifest_group_url_mismatch");
  if (expected.group_name && manifest.group_name !== expected.group_name) throw new Error("child_manifest_group_name_mismatch");
  if (manifest.group_url) {
    const badUrl = rows.find((row) => row.group_url && row.group_url !== manifest.group_url);
    if (badUrl) throw new Error("child_csv_group_url_mismatch");
  }
  if (manifest.group_name) {
    const badName = rows.find((row) => row.group_name && row.group_name !== manifest.group_name);
    if (badName) throw new Error("child_csv_group_name_mismatch");
  }
  return rows;
}

function statusForArtifact(manifestStatus) {
  return manifestStatus === "completed"
    ? "completed_with_rows"
    : manifestStatus;
}

function createGroupState(entry, status, error = null) {
  return {
    input_row: entry?.input_row ?? null,
    group_name: entry?.group_name || "",
    group_url: entry?.group_url || "",
    run_id: entry?.run_id || null,
    status,
    row_count: entry?.row_count ?? null,
    error,
  };
}

function isPathWithin(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertPathWithinResults(resultsDir, targetPath) {
  if (!isPathWithin(resultsDir, targetPath) || path.resolve(resultsDir) === path.resolve(targetPath)) {
    throw new Error(`cleanup_path_outside_results:${targetPath}`);
  }
}

function copyRawTree(sourcePath, targetPath, resultsDir) {
  assertPathWithinResults(resultsDir, sourcePath);
  assertPathWithinResults(resultsDir, targetPath);
  const sourceStat = fs.lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink()) throw new Error(`cleanup_symlink_rejected:${sourcePath}`);
  if (sourceStat.isDirectory()) {
    fs.mkdirSync(targetPath, { recursive: true });
    for (const name of fs.readdirSync(sourcePath)) {
      copyRawTree(path.join(sourcePath, name), path.join(targetPath, name), resultsDir);
    }
    return;
  }
  if (!sourceStat.isFile()) throw new Error(`cleanup_unsupported_raw_entry:${sourcePath}`);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function archiveRawRun(resultsDir, sourceDirectory, archiveRunId) {
  validateRunId(archiveRunId);
  const sourceRaw = path.join(sourceDirectory, "raw");
  if (!fs.existsSync(sourceRaw)) return { run_id: archiveRunId, archived: false, files: 0 };
  const archiveRoot = path.join(resultsDir, "raw", archiveRunId);
  assertPathWithinResults(resultsDir, archiveRoot);
  copyRawTree(sourceRaw, archiveRoot, resultsDir);
  let files = 0;
  const countFiles = (directory) => {
    for (const name of fs.readdirSync(directory)) {
      const entry = path.join(directory, name);
      if (fs.lstatSync(entry).isDirectory()) countFiles(entry);
      else files += 1;
    }
  };
  countFiles(archiveRoot);
  return { run_id: archiveRunId, archived: true, files };
}

function shouldRemoveIntermediate(name, finalOutputPath, resultsDir, protectedPaths = []) {
  const target = path.join(resultsDir, name);
  if (finalOutputPath && path.resolve(target) === path.resolve(finalOutputPath)) return false;
  if (protectedPaths.some((protectedPath) => path.resolve(target) === path.resolve(protectedPath))) return false;
  return CLEANUP_INTERMEDIATE_PATTERNS.some((pattern) => pattern.test(name));
}

const CLEANUP_REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
};

function tryRemoveCleanupPath(target, removeSync = fs.rmSync) {
  try {
    removeSync(target, CLEANUP_REMOVE_OPTIONS);
    return null;
  } catch (error) {
    return {
      path: target,
      code: error.code || "cleanup_remove_failed",
      error: String(error.message || error),
    };
  }
}

/**
 * Preserve raw scan CSV/manifests, then remove per-run/staging directories and
 * aggregate intermediates. Every mutation is confined to resultsDir. Running
 * this function again is safe because the archive is copied idempotently and
 * already-removed entries are simply absent.
 */
function cleanupResults(resultsDir, options = {}) {
  const root = path.resolve(resultsDir);
  fs.mkdirSync(root, { recursive: true });
  const sourceRunIds = [...new Set((options.sourceRunIds || []).map((value) => validateRunId(value)))];
  const finalOutputPath = options.finalOutputPath ? path.resolve(options.finalOutputPath) : "";
  const protectedPaths = (options.protectedPaths || []).map((value) => path.resolve(value));
  const removeSync = options.removeSync || fs.rmSync;
  if (finalOutputPath) assertPathWithinResults(root, finalOutputPath);
  for (const protectedPath of protectedPaths) {
    // A manifest outside resultsDir is already safe from this cleanup. Only
    // paths inside resultsDir need protection checks.
    if (isPathWithin(root, protectedPath) && path.resolve(root) === protectedPath) {
      throw new Error(`cleanup_protected_path_invalid:${protectedPath}`);
    }
  }

  const entries = fs.readdirSync(root, { withFileTypes: true });
  const sourceDirectories = entries.filter((entry) => entry.isDirectory()
    && entry.name !== "raw"
    && (sourceRunIds.includes(entry.name) || /^scan_/i.test(entry.name)));
  const archivedRuns = [];
  const warnings = [];
  const removableSourceDirectories = [];
  for (const entry of sourceDirectories) {
    const sourceDirectory = path.join(root, entry.name);
    const archiveRunId = sourceRunIds.includes(entry.name) ? entry.name : entry.name;
    if (RUN_ID_PATTERN.test(archiveRunId)) {
      try {
        const archived = archiveRawRun(root, sourceDirectory, archiveRunId);
        archivedRuns.push(archived);
        if (archived.archived || !fs.existsSync(path.join(sourceDirectory, "raw"))) {
          removableSourceDirectories.push(entry);
        }
      } catch (error) {
        warnings.push({
          path: sourceDirectory,
          code: error.code || "cleanup_archive_failed",
          error: String(error.message || error),
          action: "kept_source_directory",
        });
      }
    }
  }

  const removedPaths = [];
  for (const entry of removableSourceDirectories) {
    const target = path.join(root, entry.name);
    if (protectedPaths.some((protectedPath) => isPathWithin(target, protectedPath))) continue;
    assertPathWithinResults(root, target);
    const warning = tryRemoveCleanupPath(target, removeSync);
    if (warning) warnings.push({ ...warning, action: "kept_source_directory" });
    else removedPaths.push(target);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && shouldRemoveIntermediate(entry.name, finalOutputPath, root, protectedPaths)) {
      const target = path.join(root, entry.name);
      assertPathWithinResults(root, target);
      const warning = tryRemoveCleanupPath(target, removeSync);
      if (warning) warnings.push({ ...warning, action: "kept_intermediate" });
      else removedPaths.push(target);
    }
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".runner-staging-")) {
      const target = path.join(root, entry.name);
      if (protectedPaths.some((protectedPath) => isPathWithin(target, protectedPath))) continue;
      assertPathWithinResults(root, target);
      const warning = tryRemoveCleanupPath(target, removeSync);
      if (warning) warnings.push({ ...warning, action: "kept_runner_staging" });
      else removedPaths.push(target);
    }
  }
  return {
    status: warnings.length ? "completed_with_warnings" : "completed",
    raw_archive_dir: path.join(root, "raw"),
    archived_runs: archivedRuns,
    removed_paths: removedPaths,
    warnings,
    final_output: finalOutputPath || null,
  };
}

function countStatuses(states) {
  const counts = {};
  for (const state of states) counts[state.status] = (counts[state.status] || 0) + 1;
  return counts;
}

function markdownReport(report) {
  const lines = [
    "# Cross-group aggregate report",
    "",
    `- Batch manifest: \`${report.batch_manifest_path}\``,
    `- Generated: ${report.generated_at}`,
    `- Status: **${report.status}**`,
    `- Classification mode: **${report.classification_mode}**`,
    `- Input rows: ${report.input_row_count}`,
    `- Source run IDs: ${report.source_run_ids.join(", ") || "none"}`,
    "",
    "## Group counts",
    "",
    ...Object.entries(report.group_counts_by_status).map(([status, count]) => `- ${status}: ${count}`),
    "",
    `Released groups: ${report.released_groups.length}`,
    `Pending groups: ${report.pending_groups.length}`,
    "",
    "## Rows",
    "",
    `- Raw completed rows: ${report.raw_rows}`,
    `- Deduped rows: ${report.deduped_rows}`,
    `- In-window rows: ${report.in_window_rows}`,
    `- Date-qualified rows: ${report.date_qualified_rows}`,
    `- Quarantined unknown-time rows: ${report.quarantined_time_rows}`,
    `- Source types: ${Object.entries(report.source_type_counts).map(([type, count]) => `${type}=${count}`).join(", ") || "none"}`,
    `- Anonymous rows: ${report.anonymous_rows}`,
    `- Missing profile rows: ${report.missing_profile_rows}`,
    "",
    "## Artifact issues",
    "",
    ...(report.artifact_issues.length ? report.artifact_issues.map((issue) => `- ${issue.run_id}: ${issue.error}`) : ["- none"]),
    "",
  ];
  return lines.join("\n");
}

function runAggregate(config, dependencies = {}) {
  const batchManifestPath = path.resolve(config.batchManifest);
  const resultsDir = path.resolve(config.resultsDir);
  const batchManifest = readBatchManifest(batchManifestPath);
  const now = dependencies.now ? new Date(dependencies.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("invalid_aggregate_time");
  const groupStates = batchManifest.groups.map((entry) => createGroupState(entry, entry.status, entry.error || null));
  const artifactIssues = [];
  const sourceRunIds = [];
  const rawRows = [];
  const postRootFailures = [];
  const seenRunIds = new Set();
  const supersededRunIds = new Set();

  const resolveRun = (runId, entry, isExtra = false) => {
    if (seenRunIds.has(runId)) {
      artifactIssues.push({ run_id: runId, error: "duplicate_source_run_id" });
      return;
    }
    seenRunIds.add(runId);
    let pair;
    let rows;
    let replacementCandidate = null;
    try {
      pair = findArtifactPair(resultsDir, runId);
      if (isExtra && !entry) {
        replacementCandidate = groupStates.find((candidate) => candidate.group_url
          && candidate.group_url === pair.manifest?.group_url
          && !["skipped_blank", "skipped_invalid", "skipped_duplicate"].includes(candidate.status));
      }
      const effectiveEntry = entry || replacementCandidate;
      rows = validateArtifact(pair, {
        runId,
        group_url: effectiveEntry?.group_url || "",
        group_name: effectiveEntry?.group_name || "",
      });
      const expectedStatus = expectedArtifactStatus(entry?.status);
      if (expectedStatus && pair.manifest.status !== expectedStatus) throw new Error("child_manifest_status_mismatch");
      const artifactStatus = statusForArtifact(pair.manifest.status);
      sourceRunIds.push(runId);
      if (replacementCandidate) {
        if (replacementCandidate.run_id && replacementCandidate.run_id !== runId) {
          supersededRunIds.add(replacementCandidate.run_id);
        }
        replacementCandidate.run_id = runId;
        replacementCandidate.status = artifactStatus;
        replacementCandidate.row_count = pair.manifest.row_count;
        replacementCandidate.error = null;
      } else if (entry) {
        const state = groupStates.find((candidate) => candidate.run_id === runId && candidate.input_row === entry.input_row);
        if (state) {
          state.status = artifactStatus;
          state.row_count = pair.manifest.row_count;
          state.error = null;
        }
      } else {
        groupStates.push(createGroupState({
          group_name: pair.manifest.group_name,
          group_url: pair.manifest.group_url,
          run_id: runId,
          row_count: pair.manifest.row_count,
        }, artifactStatus));
      }
      if (pair.manifest.status === "completed") {
        postRootFailures.push(...mergeResults.postRootFailuresFromManifest(pair.manifest).map((failure) => ({
          ...failure,
          group_url: failure.group_url || effectiveEntry?.group_url || pair.manifest.group_url || "",
        })));
        rawRows.push(...rows.map((row) => ({
          ...row,
          group_name: effectiveEntry?.group_name || pair.manifest.group_name || row.group_name,
          group_url: effectiveEntry?.group_url || pair.manifest.group_url || row.group_url,
        })));
      }
    } catch (error) {
      const message = String(error.message || error);
      artifactIssues.push({ run_id: runId, error: message });
      if (entry) {
        const state = groupStates.find((candidate) => candidate.run_id === runId && candidate.input_row === entry.input_row);
        if (state) {
          state.status = "failed";
          state.error = message;
          state.row_count = null;
        }
      } else if (!replacementCandidate) {
        groupStates.push(createGroupState({ run_id: runId }, "failed", message));
      }
    }
  };

  for (const runId of config.extraRunIds || []) {
    if (!seenRunIds.has(runId)) resolveRun(runId, null, true);
  }
  for (const entry of batchManifest.groups) {
    if (entry.run_id && supersededRunIds.has(String(entry.run_id))) continue;
    if (entry.run_id && RUN_ID_PATTERN.test(String(entry.run_id)) && !seenRunIds.has(String(entry.run_id))) {
      resolveRun(String(entry.run_id), entry);
    }
  }

  const normalized = mergeResults.normalizeRows(rawRows, now);
  // The temporal boundary is per group: a checkpoint is authoritative for
  // that group; otherwise use the fixed 30-day fallback. Unknown timestamps
  // are retained only as quarantine/raw evidence and never enter final rows.
  const temporal = applyTemporalGate(normalized, batchManifest.groups, now);
  const deduped = mergeResults.dedupe(temporal.eligible);
  const policyRows = mergeResults.applyPostOnlyPolicy(deduped, { postRootFailures });
  const dateQualified = policyRows;
  const unresolved = temporal.unknown;
  const old = temporal.old;
  const all = policyRows.map(({ _date, _index, ...row }) => row);
  const quarantine = unresolved.map(({ _date, _index, ...row }) => row);
  const classified = config.classify
    ? mergeResults.classificationOutputs(dateQualified.map(({ _date, _index, ...row }) => row))
    : null;
  const sourceTypeCounts = {};
  for (const row of all) sourceTypeCounts[row.source_type] = (sourceTypeCounts[row.source_type] || 0) + 1;
  const qualityFlagCounts = {};
  for (const row of all) {
    for (const flag of String(row.data_quality_flags || "").split(";").map((value) => value.trim()).filter(Boolean)) {
      qualityFlagCounts[flag] = (qualityFlagCounts[flag] || 0) + 1;
    }
  }
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  const outputs = {
    all: path.join(resultsDir, `fb_group_aggregate_all_${stamp}_utf8.csv`),
    posts: path.join(resultsDir, `fb_group_aggregate_posts_${stamp}_utf8.csv`),
    comments: path.join(resultsDir, `fb_group_aggregate_comments_context_${stamp}_utf8.csv`),
    unresolved: path.join(resultsDir, `fb_group_aggregate_unresolved_context_${stamp}_utf8.csv`),
    report_json: path.join(resultsDir, `aggregate_report_${stamp}.json`),
    report_md: path.join(resultsDir, `aggregate_report_${stamp}.md`),
  };
  fs.mkdirSync(resultsDir, { recursive: true });
  if (classified) {
    outputs.classified = path.join(resultsDir, `fb_group_aggregate_classified_${stamp}_utf8.csv`);
    outputs.leads = path.join(resultsDir, `fb_group_aggregate_leads_${stamp}_utf8.csv`);
    outputs.audit = path.join(resultsDir, `fb_group_aggregate_audit_${stamp}_utf8.csv`);
    mergeResults.writeCsv(outputs.classified, classified.classified);
    mergeResults.writeCsv(outputs.leads, classified.leads);
    mergeResults.writeCsv(outputs.audit, classified.audit);
  }
  const releasedStatuses = new Set(["completed_with_rows", "zero_result"]);
  const pendingStatuses = new Set(["needs_user_action", "stopped", "not_run", "failed"]);
  const releasedGroups = groupStates.filter((state) => releasedStatuses.has(state.status));
  const pendingGroups = groupStates.filter((state) => pendingStatuses.has(state.status));
  const groupCounts = countStatuses(groupStates);
  const status = artifactIssues.length
    ? "completed_with_errors"
    : pendingGroups.length
      ? "completed_with_pending"
      : "completed";
  const report = {
    status,
    generated_at: now.toISOString(),
    batch_manifest_path: batchManifestPath,
    extra_run_ids: config.extraRunIds || [],
    input_row_count: batchManifest.input_row_count ?? batchManifest.groups.length,
    requested_group_count: batchManifest.requested_group_count ?? null,
    group_counts_by_status: groupCounts,
    released_groups: releasedGroups,
    pending_groups: pendingGroups,
    raw_rows: rawRows.length,
    deduped_rows: deduped.length,
    in_window_rows: all.length,
    date_qualified_rows: dateQualified.length,
    classification_mode: config.classify ? "explicit" : "raw",
    lead_rows: classified ? classified.leads.length : null,
    audit_rows: classified ? classified.audit.length : null,
    dropped_old_rows: old.length,
    unresolved_time_rows: unresolved.length,
    quarantined_time_rows: quarantine.length,
    temporal_boundaries: temporal.boundaries,
    source_type_counts: sourceTypeCounts,
    quality_flags: mergeResults.qualityFlagsForReport(sourceTypeCounts, qualityFlagCounts, all.length),
    quality_flag_counts: qualityFlagCounts,
    anonymous_rows: all.filter((row) => row.is_anonymous === "yes").length,
    missing_profile_rows: all.filter((row) => !row.profile_url && row.is_anonymous !== "yes").length,
    source_run_ids: sourceRunIds,
    artifact_issues: artifactIssues,
    outputs,
  };
  mergeResults.writeCsv(outputs.all, all);
  mergeResults.writeCsv(outputs.posts, all.filter((row) => row.source_type === "post"));
  mergeResults.writeCsv(outputs.comments, all.filter((row) => ["comment", "reply"].includes(row.source_type)));
  // This output is the retained quarantine for rows whose timestamp could
  // not be proven. It is deliberately separate from the final handoff.
  mergeResults.writeCsv(outputs.unresolved, quarantine);
  fs.writeFileSync(outputs.report_json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(outputs.report_md, `${markdownReport(report)}\n`, "utf8");
  report.cleanup = {
    enabled: config.cleanup,
    status: config.cleanup ? "pending" : "disabled",
  };
  if (config.cleanup && report.status === "completed") {
    try {
      report.cleanup = cleanupResults(resultsDir, {
        sourceRunIds,
        finalOutputPath: outputs.all,
        protectedPaths: [batchManifestPath],
      });
    } catch (error) {
      report.status = "completed_with_cleanup_error";
      report.cleanup = {
        enabled: true,
        status: "failed",
        error: String(error.message || error),
      };
    }
    // On cleanup failure the report remains available for diagnosis. On
    // success it is intentionally removed with the other intermediates.
    if (report.cleanup.status === "failed") {
      fs.writeFileSync(outputs.report_json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      fs.writeFileSync(outputs.report_md, `${markdownReport(report)}\n`, "utf8");
    }
  } else {
    if (config.cleanup) {
      report.cleanup = {
        enabled: true,
        status: "skipped",
        reason: `aggregate_status_${report.status}`,
      };
    }
    fs.writeFileSync(outputs.report_json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

function main(argv = process.argv.slice(2)) {
  try {
    const config = parseArgs(argv);
    if (config.help) {
      console.log(usage());
      return 0;
    }
    const report = runAggregate(config);
    console.log(JSON.stringify(report, null, 2));
    return report.status === "completed" ? 0 : 2;
  } catch (error) {
    console.log(JSON.stringify({ status: "failed", error: String(error.stack || error) }, null, 2));
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  countStatuses,
  cleanupResults,
  findArtifactPair,
  manifestFilenameFor,
  normalizeOutcomeStatus: statusForArtifact,
  parseArgs,
  parseTemporalTimestamp,
  readBatchManifest,
  runAggregate,
  applyTemporalGate,
  temporalBoundaryForGroup,
  isPathWithin,
  validateArtifact,
  validateRunId,
};
