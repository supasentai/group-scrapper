"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pilot = require("./fb-group-lead-pilot.js");
const runner = require("./browser-runner.js");

function makePage(lastRun = null) {
  let closeCount = 0;
  let offCount = 0;
  let injectedCheckpoints = null;
  return {
    url: () => "https://www.facebook.com/groups/example/",
    goto: async () => {},
    on: () => {},
    off: () => { offCount += 1; },
    evaluate: async (...args) => {
      if (args.length === 1) return { error: null, lastRun };
      injectedCheckpoints = args[1]?.checkpoints || null;
      return undefined;
    },
    close: async () => { closeCount += 1; },
    get closeCount() { return closeCount; },
    get offCount() { return offCount; },
    get injectedCheckpoints() { return injectedCheckpoints; },
  };
}

function makeBrowser(page) {
  let closeCount = 0;
  return {
    contexts: () => [{ newPage: async () => page }],
    close: async () => { closeCount += 1; },
    get closeCount() { return closeCount; },
  };
}

function makeConfig(resultsDir, checkpointsFile) {
  return {
    groupUrl: "https://www.facebook.com/groups/example/",
    groupName: "Example Group",
    collectorPath: path.join(__dirname, "fb-group-lead-pilot.js"),
    cdpEndpoint: "http://127.0.0.1:9222",
    days: 3,
    maxRounds: 1,
    maxRuntimeMs: 1,
    resultsDir,
    checkpointsFile,
    downloadTimeoutMs: 100,
    childTimeoutMs: 100,
  };
}

function writePair(stagingDir, status) {
  const csv = "fb_group_scan_3d_lifecycle.csv";
  const manifest = "fb_group_scan_3d_lifecycle.manifest.json";
  fs.writeFileSync(path.join(stagingDir, csv), pilot.buildCsv([]), "utf8");
  fs.writeFileSync(path.join(stagingDir, manifest), JSON.stringify({
    run_id: "lifecycle",
    status,
    row_count: 0,
  }), "utf8");
}

async function runCase({ manifestStatus = "zero_result", action = null, ingestionExitCode = 0, lastRun = null } = {}) {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-runner-lifecycle-"));
  const checkpointsFile = path.join(resultsDir, "checkpoints.json");
  fs.writeFileSync(checkpointsFile, JSON.stringify({
    version: 1,
    groups: {
      "https://www.facebook.com/groups/example/": {
        group_url: "https://www.facebook.com/groups/example/",
        group_name: "Example Group",
        checkpoint: "2026-10-06T00:00:00.000Z",
      },
    },
  }), "utf8");
  const page = makePage(lastRun);
  const browser = makeBrowser(page);
  const commands = [];
  try {
    const result = await runner.runBrowser(makeConfig(resultsDir, checkpointsFile), {
      playwright: { chromium: { connectOverCDP: async () => browser } },
      detectUserAction: async () => action,
      waitForPair: async ({ stagingDir }) => {
        writePair(stagingDir, manifestStatus);
        return true;
      },
      runCommand: (command) => {
        commands.push(command);
        if (command.args.some((arg) => arg.endsWith("ingest-downloads.js"))) {
          return {
            exitCode: ingestionExitCode,
            timedOut: false,
            stdout: "",
            stderr: ingestionExitCode ? "synthetic ingestion failure" : "",
            json: ingestionExitCode ? null : { entries: [{ csv_file: "fb_group_scan_3d_lifecycle.csv", action: "ingested" }] },
          };
        }
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "", json: {} };
      },
    });
    return { result, page, browser, commands, checkpointDocument: JSON.parse(fs.readFileSync(checkpointsFile, "utf8")) };
  } catch (error) {
    return { error, page, browser, commands, checkpointDocument: JSON.parse(fs.readFileSync(checkpointsFile, "utf8")) };
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
}

(async () => {
  const completed = await runCase({
    lastRun: {
      group_name: "Example Group",
      run_status: "completed_with_rows",
      scan_started_at: "2026-10-07T00:00:00.000Z",
      checkpoint: "2026-10-07T00:00:00.000Z",
      checkpoint_saved: true,
      run_id: "lifecycle",
      records_seen: 1,
      classified_count: 1,
      leads_count: 1,
      audit_count: 0,
    },
  });
  assert.equal(completed.result.status, "zero_result");
  assert.equal(completed.page.closeCount, 1);
  assert.equal(completed.browser.closeCount, 0);
  assert.equal(completed.page.offCount, 1);
  assert.equal(completed.page.injectedCheckpoints["https://www.facebook.com/groups/example/"], "2026-10-06T00:00:00.000Z");
  assert.equal(completed.result.files.checkpoint_update.updated, true);
  assert.equal(completed.checkpointDocument.groups["https://www.facebook.com/groups/example/"].checkpoint, "2026-10-07T00:00:00.000Z");

  const stopped = await runCase({ manifestStatus: "stopped" });
  assert.equal(stopped.result.status, "stopped");
  assert.equal(stopped.page.closeCount, 1);
  assert.equal(stopped.browser.closeCount, 0);
  assert.equal(stopped.commands.length, 0);
  assert.equal(stopped.checkpointDocument.groups["https://www.facebook.com/groups/example/"].checkpoint, "2026-10-06T00:00:00.000Z");

  const noRecords = await runCase({
    lastRun: {
      group_name: "Example Group",
      run_status: "no_records_seen",
      checkpoint: "2026-10-07T00:00:00.000Z",
      checkpoint_saved: false,
    },
  });
  assert.equal(noRecords.result.files.checkpoint_update.updated, false);
  assert.equal(noRecords.checkpointDocument.groups["https://www.facebook.com/groups/example/"].checkpoint, "2026-10-06T00:00:00.000Z");

  const updateDir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-update-gate-"));
  const updateFile = path.join(updateDir, "checkpoints.json");
  fs.writeFileSync(updateFile, JSON.stringify({ groups: {
    "https://www.facebook.com/groups/example/": {
      group_url: "https://www.facebook.com/groups/example/",
      group_name: "Example Group",
      checkpoint: "2026-10-06T00:00:00.000Z",
    },
  } }), "utf8");
  const unsafeUpdate = runner.updateCheckpointManifest({
    filePath: updateFile,
    groupUrl: "https://www.facebook.com/groups/example/",
    groupName: "Example Group",
    lastRun: {
      run_status: "stopped",
      checkpoint_saved: true,
      checkpoint: "2026-10-07T00:00:00.000Z",
      records_seen: 1,
    },
  });
  assert.equal(unsafeUpdate.updated, false);
  assert.equal(JSON.parse(fs.readFileSync(updateFile, "utf8")).groups["https://www.facebook.com/groups/example/"].checkpoint, "2026-10-06T00:00:00.000Z");
  for (const runStatus of ["failed", "needs_user_action", "no_records_seen"]) {
    const gated = runner.updateCheckpointManifest({
      filePath: updateFile,
      groupUrl: "https://www.facebook.com/groups/example/",
      groupName: "Example Group",
      lastRun: {
        run_status: runStatus,
        checkpoint_saved: true,
        checkpoint: "2026-10-08T00:00:00.000Z",
        records_seen: 2,
      },
    });
    assert.equal(gated.updated, false);
  }
  fs.rmSync(updateDir, { recursive: true, force: true });

  const failed = await runCase({ ingestionExitCode: 1 });
  assert.match(failed.error.message, /Ingestion failed/);
  assert.equal(failed.page.closeCount, 1);
  assert.equal(failed.browser.closeCount, 0);

  const needsAction = await runCase({ action: "Facebook login required" });
  assert.equal(needsAction.result.status, "needs_user_action");
  assert.equal(needsAction.page.closeCount, 0);
  assert.equal(needsAction.browser.closeCount, 0);

  console.log("Browser runner lifecycle tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
