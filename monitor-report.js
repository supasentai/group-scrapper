"use strict";

const fs = require("node:fs");
const path = require("node:path");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8").replace(/^\uFEFF/, ""));
}

function loadComparableReport(filePathOrReport) {
  const value = typeof filePathOrReport === "string" ? readJson(filePathOrReport) : filePathOrReport;
  if (value?.aggregate_report_path) return loadComparableReport(value.aggregate_report_path);
  if (value?.aggregate?.report_path) return loadComparableReport(value.aggregate.report_path);
  if (value?.aggregate_report) return loadComparableReport(value.aggregate_report);
  return value || {};
}

function groupKey(group) {
  return group?.group_url || group?.run_id || `${group?.input_row || ""}|${group?.group_name || ""}`;
}

function mapGroups(report, predicate = () => true) {
  return new Map((report?.released_groups || report?.groups || [])
    .filter(predicate)
    .map((group) => [groupKey(group), group]));
}

function qualityChanges(previous, current) {
  const before = previous?.quality_flag_counts || {};
  const after = current?.quality_flag_counts || {};
  const added = [];
  const removed = [];
  const increased = [];
  const decreased = [];
  for (const flag of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const oldCount = Number(before[flag] || 0);
    const newCount = Number(after[flag] || 0);
    if (!oldCount && newCount) added.push(flag);
    if (oldCount && !newCount) removed.push(flag);
    if (newCount > oldCount && oldCount) increased.push({ flag, from: oldCount, to: newCount });
    if (newCount < oldCount && newCount) decreased.push({ flag, from: oldCount, to: newCount });
  }
  return { added, removed, increased, decreased };
}

function compareReports(currentInput, previousInput = null) {
  const current = loadComparableReport(currentInput);
  const previous = previousInput ? loadComparableReport(previousInput) : null;
  const reasons = [];
  const newGroups = [];
  const newZeroResultGroups = [];
  const failures = [];
  const currentReleased = mapGroups(current);
  const previousReleased = previous ? mapGroups(previous) : new Map();
  for (const [key, group] of currentReleased) {
    if (!previousReleased.has(key)) {
      if (group.status === "zero_result") newZeroResultGroups.push(group);
      else newGroups.push(group);
    }
  }
  const currentPending = new Map((current?.pending_groups || []).map((group) => [groupKey(group), group]));
  const previousPending = new Map((previous?.pending_groups || []).map((group) => [groupKey(group), group]));
  for (const [key, group] of currentPending) {
    if (["failed", "stopped", "needs_user_action"].includes(group.status)
      && (!previousPending.has(key) || previousPending.get(key).status !== group.status)) failures.push(group);
  }
  if (newGroups.length) reasons.push("new_groups");
  if (newZeroResultGroups.length) reasons.push("new_zero_result_groups");
  if (failures.length) reasons.push("new_failures");
  const quality = previous ? qualityChanges(previous, current) : { added: [], removed: [], increased: [], decreased: [] };
  if (quality.added.length || quality.removed.length || quality.increased.length || quality.decreased.length) reasons.push("quality_flags_changed");
  if (!previous) reasons.push("no_previous_report");
  return {
    notify: reasons.some((reason) => reason !== "no_previous_report"),
    reasons,
    new_groups: newGroups,
    new_zero_result_groups: newZeroResultGroups,
    failures,
    quality_changes: quality,
    current_status: current.status || null,
    previous_status: previous?.status || null,
  };
}

function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      console.log("Usage: node monitor-report.js --report <current.json> [--previous-report <previous.json>]");
      return 0;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    index += 1;
    if (flag === "--report") args.report = path.resolve(value);
    else if (flag === "--previous-report") args.previousReport = path.resolve(value);
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!args.report) throw new Error("--report is required");
  console.log(JSON.stringify(compareReports(args.report, args.previousReport || null), null, 2));
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.log(JSON.stringify({ notify: true, reasons: ["monitor_error"], error: String(error.message || error) }, null, 2));
    process.exitCode = 1;
  }
}

module.exports = { compareReports, loadComparableReport, qualityChanges };
