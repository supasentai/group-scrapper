"use strict";

const fs = require("node:fs");
const path = require("node:path");
const browserRunner = require("./browser-runner.js");
const ingest = require("./ingest-downloads.js");
const mergeResults = require("./merge-results.js");

const DEFAULT_RESULTS_DIR = path.join(__dirname, "results");
const DEFAULT_DAYS = 30;
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const SCAN_FILENAME_PATTERN = /^fb_group_scan_\d+d_.+\.csv$/i;

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

function parseArgs(argv = process.argv.slice(2)) {
  const config = {
    batchManifest: "",
    resultsDir: DEFAULT_RESULTS_DIR,
    extraRunIds: [],
    days: DEFAULT_DAYS,
    classify: false,
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
  const deduped = mergeResults.dedupe(normalized);
  const cutoff = new Date(now.getTime() - config.days * 86_400_000);
  const dateQualified = deduped.filter((row) => row._date && row._date >= cutoff);
  const unresolved = deduped.filter((row) => !row._date);
  const old = deduped.filter((row) => row._date && row._date < cutoff);
  // Raw/all retains unresolved-time rows for QA; explicit classification is
  // limited to rows that can be proven to be inside the date window.
  const all = deduped
    .filter((row) => !row._date || row._date >= cutoff)
    .map(({ _date, _index, ...row }) => row);
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
  mergeResults.writeCsv(outputs.unresolved, all.filter((row) => row.source_type === "unresolved"));
  fs.writeFileSync(outputs.report_json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(outputs.report_md, `${markdownReport(report)}\n`, "utf8");
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
  findArtifactPair,
  manifestFilenameFor,
  normalizeOutcomeStatus: statusForArtifact,
  parseArgs,
  readBatchManifest,
  runAggregate,
  validateArtifact,
  validateRunId,
};
