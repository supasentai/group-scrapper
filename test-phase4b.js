"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const batch = require("./batch-runner.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "group-scrapper-phase4b-"));
try {
  const alpha = "https://www.facebook.com/groups/alpha/";
  const disabled = "https://www.facebook.com/groups/disabled/";
  const checkpointsFile = path.join(tempDir, "checkpoints.json");
  fs.writeFileSync(checkpointsFile, JSON.stringify({
    version: 1,
    groups: {
      [alpha]: { group_url: alpha, group_name: "Alpha", checkpoint: "2026-10-06T00:00:00.000Z" },
      [disabled]: { group_url: disabled, group_name: "Disabled", enabled: false, checkpoint: null },
    },
  }), "utf8");

  const parsed = batch.parseCheckpointsJson(fs.readFileSync(checkpointsFile, "utf8"));
  assert.equal(parsed.source_type, "checkpoints_json");
  assert.deepEqual(parsed.entries.map((entry) => entry.status), ["pending", "skipped_disabled"]);
  assert.equal(parsed.entries[0].input_key, alpha);
  assert.equal(parsed.entries[1].enabled, false);
  assert.throws(() => batch.parseCheckpointsJson(JSON.stringify({
    groups: { "https://www.facebook.com/groups/alpha/?ref=bad": { group_url: alpha, group_name: "Alpha" } },
  })), /group_key_not_canonical/);
  assert.throws(() => batch.parseCheckpointsJson(JSON.stringify({
    groups: { [alpha]: { group_url: alpha, group_name: "" } },
  })), /group_name_missing/);
  assert.throws(() => batch.parseCheckpointsJson(JSON.stringify({
    groups: { [alpha]: { group_url: alpha, group_name: "Alpha", status: "completed" } },
  })), /status_invalid/);

  const failedStatusFile = path.join(tempDir, "failed-status.json");
  fs.writeFileSync(failedStatusFile, JSON.stringify({
    groups: { [alpha]: { group_url: alpha, group_name: "Alpha", status: "failed" } },
  }), "utf8");
  assert.throws(() => batch.runBatch(batch.parseArgs([
    "--checkpoints-file", failedStatusFile,
    "--results-dir", path.join(tempDir, "failed-status-results"),
    "--days", "3",
  ]), { runGroup: () => { throw new Error("must not run"); } }), /status_requires_retry/);

  const resultsDir = path.join(tempDir, "results");
  const config = batch.parseArgs([
    "--checkpoints-file", checkpointsFile,
    "--results-dir", resultsDir,
    "--days", "3",
  ]);
  assert.equal(config.groupsFile, "");
  assert.equal(config.checkpointsFile, path.resolve(checkpointsFile));
  const calls = [];
  const manifest = batch.runBatch(config, {
    runGroup: (group, runnerConfig) => {
      calls.push({ group, runnerConfig });
      return { status: "needs_user_action", needs_user_action: "login required" };
    },
  });
  assert.deepEqual(calls.map(({ group }) => group.group_url), [alpha]);
  assert.equal(calls[0].runnerConfig.checkpointsFile, path.resolve(checkpointsFile));
  assert.equal(manifest.input_type, "checkpoints_json");
  assert.equal(manifest.requested_group_count, 1);
  assert.deepEqual(manifest.groups.map((group) => group.status), ["needs_user_action", "skipped_disabled"]);

  const legacyFile = path.join(tempDir, "legacy.csv");
  fs.writeFileSync(legacyFile, "TÊN HỘI NHÓM,LINK\nLegacy,https://www.facebook.com/groups/legacy/\n", "utf8");
  const legacyConfig = batch.parseArgs([
    "--groups-file", legacyFile,
    "--checkpoints-file", checkpointsFile,
    "--results-dir", path.join(tempDir, "legacy-results"),
    "--days", "3",
  ]);
  const legacyManifest = batch.runBatch(legacyConfig, {
    runGroup: () => ({ status: "needs_user_action", needs_user_action: "login required" }),
  });
  assert.equal(legacyManifest.input_type, "legacy_csv");
  assert.equal(legacyManifest.groups[0].source_type, "csv");

  const resumeManifestPath = path.join(tempDir, "resume.json");
  fs.writeFileSync(resumeManifestPath, JSON.stringify({
    batch_run_id: "prior",
    status: "completed",
    groups: [{
      input_row: 1,
      input_key: alpha,
      source_type: "checkpoints",
      group_url: alpha,
      group_name: "Alpha",
      status: "zero_result",
    }],
  }), "utf8");
  const changedFile = path.join(tempDir, "changed.json");
  const beta = "https://www.facebook.com/groups/beta/";
  fs.writeFileSync(changedFile, JSON.stringify({
    groups: { [beta]: { group_url: beta, group_name: "Beta" } },
  }), "utf8");
  assert.throws(() => batch.runBatch(batch.parseArgs([
    "--checkpoints-file", changedFile,
    "--results-dir", path.join(tempDir, "changed-results"),
    "--resume-manifest", resumeManifestPath,
  ]), { runGroup: () => { throw new Error("must not run"); } }), /resume_input_mapping_mismatch/);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("Phase 4B tests passed.");
