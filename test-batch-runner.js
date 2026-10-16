"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const batch = require("./batch-runner.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "group-scrapper-batch-test-"));
try {
  const groupsFile = path.join(tempDir, "groups.csv");
  const resultsDir = path.join(tempDir, "results");
  fs.writeFileSync(groupsFile, [
    "TÊN HỘI NHÓM,LINK",
    "Alpha Group,https://www.facebook.com/groups/alpha/",
    ",",
    "Invalid Group,https://example.com/groups/invalid/",
    "Duplicate Alpha,https://www.facebook.com/groups/alpha/?ref=bookmarks",
    "Zero Group,https://www.facebook.com/groups/zero/",
    "Blocked Group,https://www.facebook.com/groups/blocked/",
    "After Block,https://www.facebook.com/groups/after/",
  ].join("\n"), "utf8");

  const csvHeader = "group_name,group_url,content_url,name,profile_url,source_type,published_at_text,text_excerpt";
  const writeArtifacts = (name, groupUrl, runId, status, rowCount) => {
    const csvPath = path.join(resultsDir, `${name}.csv`);
    const manifestPath = path.join(resultsDir, `${name}.manifest.json`);
    fs.mkdirSync(resultsDir, { recursive: true });
    const rows = Array.from({ length: rowCount }, (_value, index) => `"Group","${groupUrl}","${groupUrl}posts/${index + 1}/","Author ${index + 1}","https://www.facebook.com/author-${index + 1}/","post","2026-10-07T00:00:00.000Z","A valid post text for fixture ${index + 1}."`);
    fs.writeFileSync(csvPath, `${csvHeader}\n${rows.join("\n")}\n`, "utf8");
    fs.writeFileSync(manifestPath, JSON.stringify({
      group_url: groupUrl,
      run_id: runId,
      status,
      row_count: rowCount,
      output_file: path.basename(csvPath),
    }), "utf8");
    return { manifestPath, csvPath };
  };

  const config = batch.parseArgs([
    "--groups-file", groupsFile,
    "--results-dir", resultsDir,
    "--days", "3",
    "--max-runtime-ms", "1000",
    "--child-timeout-ms", "2000",
  ]);
  assert.ok(batch.runnerTimeoutMs(config) > config.maxRuntimeMs);
  assert.deepEqual(config.cdpEndpoints, [
    "http://127.0.0.1:9222",
    "http://127.0.0.1:9223",
    "http://127.0.0.1:9224",
    "http://127.0.0.1:9225",
  ]);
  const explicitEndpoints = batch.parseArgs([
    "--groups-file", groupsFile,
    "--cdp-endpoints", "http://127.0.0.1:9224,http://127.0.0.1:9225",
  ]);
  assert.deepEqual(explicitEndpoints.cdpEndpoints, ["http://127.0.0.1:9224", "http://127.0.0.1:9225"]);
  const runnerArgs = batch.makeRunnerArgs({
    group_url: "https://www.facebook.com/groups/alpha/",
    group_name: "Alpha Group",
  }, config);
  assert.ok(runnerArgs.includes("--group-name"));
  assert.equal(runnerArgs[runnerArgs.indexOf("--group-name") + 1], "Alpha Group");
  const runCalls = [];
  const fakeRunner = (group) => {
    runCalls.push(group.group_url);
    if (group.group_url.endsWith("/alpha/")) {
      const artifacts = writeArtifacts("alpha", group.group_url, "scan_alpha", "completed", 2);
      return { status: "completed", run_id: "scan_alpha", files: { manifest: artifacts.manifestPath, csv: artifacts.csvPath } };
    }
    if (group.group_url.endsWith("/zero/")) {
      const artifacts = writeArtifacts("zero", group.group_url, "scan_zero", "zero_result", 0);
      return { status: "zero_result", run_id: "scan_zero", files: { manifest: artifacts.manifestPath, csv: artifacts.csvPath } };
    }
    return { status: "needs_user_action", needs_user_action: "Facebook login required" };
  };

  const manifest = batch.runBatch(config, { runGroup: fakeRunner });
  assert.equal(manifest.status, "needs_user_action");
  assert.equal(manifest.input_row_count, 7);
  assert.equal(manifest.requested_group_count, 4);
  assert.equal(manifest.input_hash, batch.sha256(fs.readFileSync(groupsFile)));
  assert.deepEqual(runCalls, [
    "https://www.facebook.com/groups/alpha/",
    "https://www.facebook.com/groups/zero/",
    "https://www.facebook.com/groups/blocked/",
  ]);
  assert.deepEqual(manifest.groups.map((group) => group.status), [
    "completed_with_rows",
    "skipped_blank",
    "skipped_invalid",
    "skipped_duplicate",
    "zero_result",
    "needs_user_action",
    "not_run",
  ]);
  assert.equal(manifest.groups[0].run_id, "scan_alpha");
  assert.equal(manifest.groups[0].row_count, 2);
  assert.equal(manifest.groups[4].row_count, 0);
  assert.equal(manifest.groups[5].needs_user_action, "Facebook login required");
  assert.equal(manifest.groups[6].error, "batch_stopped_after_needs_user_action");
  assert.deepEqual(manifest.counts, {
    completed_with_rows: 1,
    skipped_blank: 1,
    skipped_invalid: 1,
    skipped_duplicate: 1,
    zero_result: 1,
    needs_user_action: 1,
    not_run: 1,
  });
  assert.equal(fs.existsSync(manifest.manifest_path), true);
  assert.equal(batch.normalizeOutcome({ status: "zero_result" }).status, "failed");
  assert.equal(batch.normalizeOutcome({ status: "completed", files: {} }).status, "failed");
  const profileLimit = batch.normalizeOutcome({
    status: "profile_limited",
    profile_port: 9223,
    profile_limit: {
      status: "profile_limited_hard",
      confidence: "high",
      evidence: ["hard_text:/action blocked/i"],
    },
  });
  assert.equal(profileLimit.status, "profile_limited");
  assert.equal(profileLimit.profile_port, 9223);
  assert.equal(profileLimit.checkpoint_saved, false);

  const profileGroupsFile = path.join(tempDir, "profile-limited-groups.csv");
  fs.writeFileSync(profileGroupsFile, [
    "TÊN HỘI NHÓM,LINK",
    "Profile Limited,https://www.facebook.com/groups/profile-limited/",
    "After Profile Limit,https://www.facebook.com/groups/after-profile-limit/",
  ].join("\n"), "utf8");
  const profileConfig = batch.parseArgs([
    "--groups-file", profileGroupsFile,
    "--results-dir", resultsDir,
    "--days", "3",
  ]);
  let afterProfileLimitCalled = false;
  const profileManifest = batch.runBatch(profileConfig, {
    runGroup: (group) => {
      if (group.group_url.endsWith("/profile-limited/")) {
        return {
          status: "profile_limited",
          profile_port: 9222,
          profile_limit: { status: "profile_limited_soft", confidence: "medium", evidence: ["soft_text:/something went wrong/i", "feed_no_progress_after_retries"] },
          needs_user_action: "Switch to port 9223 and retry from the previous checkpoint.",
        };
      }
      afterProfileLimitCalled = true;
      return { status: "needs_user_action", needs_user_action: "must not run" };
    },
  });
  assert.equal(profileManifest.status, "completed_with_profile_gaps");
  assert.equal(afterProfileLimitCalled, false);
  assert.equal(profileManifest.groups[0].status, "no_available_profile");
  assert.equal(profileManifest.groups[0].profile_attempts.length, 4);
  assert.equal(profileManifest.groups[0].checkpoint_saved, false);
  assert.equal(profileManifest.groups[1].status, "not_run");
  assert.equal(profileManifest.groups[1].error, "batch_stopped_after_all_profiles_unavailable");

  const rotationGroupsFile = path.join(tempDir, "rotation-groups.csv");
  fs.writeFileSync(rotationGroupsFile, [
    "TÊN HỘI NHÓM,LINK",
    "Rotation A,https://www.facebook.com/groups/rotation-a/",
    "Rotation B,https://www.facebook.com/groups/rotation-b/",
    "Rotation C,https://www.facebook.com/groups/rotation-c/",
  ].join("\n"), "utf8");
  const rotationConfig = batch.parseArgs([
    "--groups-file", rotationGroupsFile,
    "--results-dir", resultsDir,
    "--cdp-endpoints", "http://127.0.0.1:9222,http://127.0.0.1:9223,http://127.0.0.1:9224,http://127.0.0.1:9225",
  ]);
  const rotationCalls = [];
  const rotationManifest = batch.runBatch(rotationConfig, {
    runGroup: (group, runConfig) => {
      const endpoint = runConfig.cdpEndpoint;
      rotationCalls.push(`${group.group_url}:${endpoint}`);
      if (group.group_url.endsWith("/rotation-a/") && endpoint.endsWith(":9222")) {
        return { status: "profile_limited", profile_port: 9222, profile_limit: { status: "profile_limited_hard" } };
      }
      if (group.group_url.endsWith("/rotation-b/") && endpoint.endsWith(":9223")) {
        return { status: "not_member", profile_port: 9223, group_access: { status: "not_member" } };
      }
      if (group.group_url.endsWith("/rotation-c/") && endpoint.endsWith(":9224")) {
        return { status: "profile_limited", profile_port: 9224, profile_limit: { status: "profile_limited_soft" } };
      }
      const suffix = group.group_url.split("/").at(-2);
      const status = group.group_url.endsWith("/rotation-b/") ? "zero_result" : "completed";
      const rowCount = status === "zero_result" ? 0 : 1;
      const artifacts = writeArtifacts(`rotation-${suffix}-${endpoint.slice(-4)}`, group.group_url, `scan-${suffix}-${endpoint.slice(-4)}`, status, rowCount);
      return { status, run_id: `scan-${suffix}-${endpoint.slice(-4)}`, files: { manifest: artifacts.manifestPath, csv: artifacts.csvPath } };
    },
  });
  assert.deepEqual(rotationCalls, [
    "https://www.facebook.com/groups/rotation-a/:http://127.0.0.1:9222",
    "https://www.facebook.com/groups/rotation-a/:http://127.0.0.1:9223",
    "https://www.facebook.com/groups/rotation-b/:http://127.0.0.1:9223",
    "https://www.facebook.com/groups/rotation-b/:http://127.0.0.1:9224",
    "https://www.facebook.com/groups/rotation-c/:http://127.0.0.1:9224",
    "https://www.facebook.com/groups/rotation-c/:http://127.0.0.1:9225",
  ]);
  assert.equal(rotationManifest.groups[0].status, "completed_with_rows");
  assert.deepEqual(rotationManifest.groups[0].profile_attempts.map((attempt) => attempt.status), ["profile_limited", "completed_with_rows"]);
  assert.equal(rotationManifest.groups[1].status, "zero_result");
  assert.deepEqual(rotationManifest.groups[1].profile_attempts.map((attempt) => attempt.status), ["not_member", "zero_result"]);
  assert.equal(rotationManifest.groups[2].status, "completed_with_rows");
  assert.deepEqual(rotationManifest.groups[2].profile_attempts.map((attempt) => attempt.status), ["profile_limited", "completed_with_rows"]);

  const stoppedGroupsFile = path.join(tempDir, "stopped-groups.csv");
  fs.writeFileSync(stoppedGroupsFile, "TÊN HỘI NHÓM,LINK\nStopped Group,https://www.facebook.com/groups/stopped/\n", "utf8");
  const stoppedConfig = batch.parseArgs([
    "--groups-file", stoppedGroupsFile,
    "--results-dir", resultsDir,
    "--days", "3",
  ]);
  const stoppedManifest = batch.runBatch(stoppedConfig, {
    runGroup: (group) => {
      const artifacts = writeArtifacts("stopped", group.group_url, "scan_stopped", "stopped", 1);
      return { status: "stopped", run_id: "scan_stopped", files: { manifest: artifacts.manifestPath, csv: artifacts.csvPath } };
    },
  });
  assert.equal(stoppedManifest.status, "completed_with_stopped");
  assert.equal(stoppedManifest.groups[0].status, "stopped");

  const mismatchedGroupsFile = path.join(tempDir, "mismatched-groups.csv");
  fs.writeFileSync(mismatchedGroupsFile, "TÊN HỘI NHÓM,LINK\nMismatch Group,https://www.facebook.com/groups/mismatch/\n", "utf8");
  const mismatchedConfig = batch.parseArgs([
    "--groups-file", mismatchedGroupsFile,
    "--results-dir", resultsDir,
    "--days", "3",
  ]);
  const mismatchedManifest = batch.runBatch(mismatchedConfig, {
    runGroup: () => {
      const artifacts = writeArtifacts("mismatch", "https://www.facebook.com/groups/other/", "scan_mismatch", "zero_result", 0);
      return { status: "zero_result", files: { manifest: artifacts.manifestPath, csv: artifacts.csvPath } };
    },
  });
  assert.equal(mismatchedManifest.status, "completed_with_errors");
  assert.equal(mismatchedManifest.groups[0].status, "failed");
  assert.match(mismatchedManifest.groups[0].error, /group_url_mismatch/);

  const badCountArtifacts = writeArtifacts("bad-count", "https://www.facebook.com/groups/bad-count/", "scan_bad_count", "zero_result", 1);
  const badCountManifest = JSON.parse(fs.readFileSync(badCountArtifacts.manifestPath, "utf8"));
  badCountManifest.row_count = 0;
  fs.writeFileSync(badCountArtifacts.manifestPath, JSON.stringify(badCountManifest), "utf8");
  const badCountOutcome = batch.normalizeOutcome(
    { status: "zero_result", files: { manifest: badCountArtifacts.manifestPath, csv: badCountArtifacts.csvPath } },
    "https://www.facebook.com/groups/bad-count/",
  );
  assert.equal(badCountOutcome.status, "failed");
  assert.match(badCountOutcome.error, /csv_row_count_mismatch/);

  const missingCsvManifestPath = path.join(resultsDir, "missing-csv.manifest.json");
  fs.writeFileSync(missingCsvManifestPath, JSON.stringify({
    group_url: "https://www.facebook.com/groups/missing-csv/",
    run_id: "scan_missing_csv",
    status: "zero_result",
    row_count: 0,
    output_file: "missing-csv.csv",
  }), "utf8");
  const missingCsvOutcome = batch.normalizeOutcome(
    { status: "zero_result", files: { manifest: missingCsvManifestPath, csv: path.join(resultsDir, "missing-csv.csv") } },
    "https://www.facebook.com/groups/missing-csv/",
  );
  assert.equal(missingCsvOutcome.status, "failed");
  assert.match(missingCsvOutcome.error, /csv_missing/);

  const resumeGroupsFile = path.join(tempDir, "resume-groups.csv");
  fs.writeFileSync(resumeGroupsFile, [
    "TÊN HỘI NHÓM,LINK",
    "Completed Group,https://www.facebook.com/groups/resume-completed/",
    "Zero Group,https://www.facebook.com/groups/resume-zero/",
    "Stopped Group,https://www.facebook.com/groups/resume-stopped/",
    "Failed Group,https://www.facebook.com/groups/resume-failed/",
    "Duplicate Completed,https://www.facebook.com/groups/resume-completed/",
    "New Group,https://www.facebook.com/groups/resume-new/",
  ].join("\n"), "utf8");
  const resumeManifestPath = path.join(tempDir, "resume-manifest.json");
  fs.writeFileSync(resumeManifestPath, JSON.stringify({
    batch_run_id: "batch_parent",
    input_hash: "old-hash",
    status: "completed_with_errors",
    groups: [
      { input_row: 2, group_name: "Completed Group", group_url: "https://www.facebook.com/groups/resume-completed/", run_id: "old-completed", status: "completed_with_rows", row_count: 1 },
      { input_row: 3, group_name: "Zero Group", group_url: "https://www.facebook.com/groups/resume-zero/", run_id: "old-zero", status: "zero_result", row_count: 0 },
      { input_row: 4, group_name: "Stopped Group", group_url: "https://www.facebook.com/groups/resume-stopped/", run_id: "old-stopped", status: "stopped", row_count: 0 },
      { input_row: 5, group_name: "Failed Group", group_url: "https://www.facebook.com/groups/resume-failed/", run_id: null, status: "failed", row_count: null, error: "prior_failure" },
      { input_row: 6, group_name: "Duplicate Completed", group_url: "https://www.facebook.com/groups/resume-completed/", run_id: null, status: "skipped_duplicate", row_count: null },
    ],
  }), "utf8");
  const resumeConfig = batch.parseArgs([
    "--groups-file", resumeGroupsFile,
    "--results-dir", resultsDir,
    "--resume-manifest", resumeManifestPath,
    "--retry-status", "stopped,failed",
  ]);
  const resumeCalls = [];
  const resumeRun = batch.runBatch(resumeConfig, {
    runGroup: (group) => {
      resumeCalls.push(group.group_url);
      const suffix = group.group_url.split("/").at(-2);
      const artifacts = writeArtifacts(`resume-${suffix}`, group.group_url, `new-${suffix}`, "completed", 1);
      return { status: "completed", run_id: `new-${suffix}`, files: { manifest: artifacts.manifestPath, csv: artifacts.csvPath } };
    },
  });
  assert.deepEqual(resumeCalls, [
    "https://www.facebook.com/groups/resume-stopped/",
    "https://www.facebook.com/groups/resume-failed/",
    "https://www.facebook.com/groups/resume-new/",
  ]);
  assert.equal(resumeRun.parent_batch_run_id, "batch_parent");
  assert.equal(resumeRun.resume_input_hash_match, false);
  assert.deepEqual(resumeRun.retry_statuses, ["stopped", "failed"]);
  assert.deepEqual(resumeRun.execution_counts, { reused: 3, retried: 2, new: 1 });
  assert.equal(resumeRun.groups[0].status, "completed_with_rows");
  assert.equal(resumeRun.groups[0].execution, "reused");
  assert.equal(resumeRun.groups[0].run_id, "old-completed");
  assert.equal(resumeRun.groups[1].status, "zero_result");
  assert.equal(resumeRun.groups[1].execution, "reused");
  assert.equal(resumeRun.groups[2].status, "completed_with_rows");
  assert.equal(resumeRun.groups[2].execution, "retried");
  assert.equal(resumeRun.groups[2].previous_run_id, "old-stopped");
  assert.equal(resumeRun.groups[4].status, "skipped_duplicate");
  assert.equal(resumeRun.groups[4].execution, "reused");
  assert.equal(resumeRun.groups[5].execution, "new");

  const noRetryConfig = batch.parseArgs([
    "--groups-file", resumeGroupsFile,
    "--results-dir", resultsDir,
    "--resume-manifest", resumeManifestPath,
  ]);
  const noRetryCalls = [];
  const noRetryRun = batch.runBatch(noRetryConfig, {
    runGroup: (group) => {
      noRetryCalls.push(group.group_url);
      return { status: "zero_result", run_id: "new-only", files: {} };
    },
  });
  assert.deepEqual(noRetryCalls, ["https://www.facebook.com/groups/resume-new/"]);
  assert.equal(noRetryRun.groups[2].status, "stopped");
  assert.equal(noRetryRun.groups[3].status, "failed");

  const changedGroupsFile = path.join(tempDir, "changed-resume-groups.csv");
  fs.writeFileSync(changedGroupsFile, "TÊN HỘI NHÓM,LINK\nCompleted Group,https://www.facebook.com/groups/changed-url/\n", "utf8");
  assert.throws(() => batch.runBatch(batch.parseArgs([
    "--groups-file", changedGroupsFile,
    "--results-dir", resultsDir,
    "--resume-manifest", resumeManifestPath,
  ]), { runGroup: () => { throw new Error("must not run"); } }), /resume_input_mapping_mismatch/);

  const needsManifestPath = path.join(tempDir, "needs-resume-manifest.json");
  fs.writeFileSync(needsManifestPath, JSON.stringify({
    batch_run_id: "batch_needs",
    status: "needs_user_action",
    groups: [{
      input_row: 2,
      group_name: "Completed Group",
      group_url: "https://www.facebook.com/groups/resume-completed/",
      run_id: null,
      status: "needs_user_action",
      row_count: null,
      needs_user_action: "login required",
    }],
  }), "utf8");
  const needsConfig = batch.parseArgs([
    "--groups-file", resumeGroupsFile,
    "--results-dir", resultsDir,
    "--resume-manifest", needsManifestPath,
  ]);
  assert.throws(() => batch.runBatch(needsConfig, { runGroup: () => { throw new Error("must not run"); } }), /requires_explicit_retry_status/);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("Batch runner tests passed.");
