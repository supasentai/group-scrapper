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
  const gotoUrls = [];
  let injectedCheckpoints = null;
  return {
    url: () => "https://www.facebook.com/groups/example/",
    goto: async (url) => { gotoUrls.push(url); },
    on: () => {},
    off: () => { offCount += 1; },
    exposeFunction: async () => {},
    evaluate: async (...args) => {
      if (args.length === 1) return { error: null, lastRun };
      injectedCheckpoints = args[1]?.checkpoints || null;
      return undefined;
    },
    close: async () => { closeCount += 1; },
    get closeCount() { return closeCount; },
    get offCount() { return offCount; },
    get gotoUrls() { return gotoUrls; },
    get injectedCheckpoints() { return injectedCheckpoints; },
  };
}

function makeBrowser(page, backfillPage = page) {
  let closeCount = 0;
  let newPageCount = 0;
  return {
    contexts: () => [{
      newPage: async () => {
        newPageCount += 1;
        return newPageCount === 1 ? page : backfillPage;
      },
    }],
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

function writePair(stagingDir, status, rows = [], lastRun = null) {
  const csv = "fb_group_scan_3d_lifecycle.csv";
  const manifest = "fb_group_scan_3d_lifecycle.manifest.json";
  fs.writeFileSync(path.join(stagingDir, csv), pilot.buildCsv(rows), "utf8");
  fs.writeFileSync(path.join(stagingDir, manifest), JSON.stringify({
    run_id: "lifecycle",
    group_url: "https://www.facebook.com/groups/example/",
    started_at: lastRun?.scan_started_at || "2026-10-07T00:00:00.000Z",
    records_seen: lastRun?.records_seen || 0,
    boundary_verified: lastRun?.boundary_verified === true,
    status,
    row_count: rows.length,
  }), "utf8");
}

async function runCase({ manifestStatus = "zero_result", action = null, ingestionExitCode = 0, lastRun = null, scanRows = [], backfillCandidate = null, updateCheckpointManifest = undefined } = {}) {
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
  const backfillPage = backfillCandidate ? {
    goto: async () => {},
    evaluate: async () => [backfillCandidate],
    close: async () => {},
  } : page;
  const browser = makeBrowser(page, backfillPage);
  const commands = [];
  try {
    const result = await runner.runBrowser(makeConfig(resultsDir, checkpointsFile), {
      playwright: { chromium: { connectOverCDP: async () => browser } },
      detectUserAction: async () => action,
      waitForPair: async ({ stagingDir }) => {
        writePair(stagingDir, manifestStatus, scanRows, lastRun);
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
      updateCheckpointManifest,
    });
    return { result, page, browser, commands, checkpointDocument: JSON.parse(fs.readFileSync(checkpointsFile, "utf8")) };
  } catch (error) {
    return { error, page, browser, commands, checkpointDocument: JSON.parse(fs.readFileSync(checkpointsFile, "utf8")) };
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
}

(async () => {
  let extractorArgument = null;
  let extractorSource = "";
  await runner.readPostRootCandidates({
    evaluate: async (fn, argument) => {
      extractorSource = fn.toString();
      extractorArgument = argument;
      return [];
    },
  }, "https://www.facebook.com/groups/example/posts/456/");
  assert.equal(extractorArgument, "https://www.facebook.com/groups/example/posts/456/");
  assert.match(extractorSource, /data-ad-rendering-role/);
  assert.match(extractorSource, /data-virtualized/);
  assert.match(extractorSource, /\\p\{Cf\}/);

  const completed = await runCase({
    lastRun: {
      group_name: "Example Group",
      group_url: "https://www.facebook.com/groups/example/",
      run_status: "zero_result_after_checkpoint",
      scan_started_at: "2026-10-07T00:00:00.000Z",
      previous_checkpoint: "2026-10-06T00:00:00.000Z",
      checkpoint_candidate: "2026-10-07T00:00:00.000Z",
      checkpoint_enabled: true,
      boundary_verified: true,
      local_checkpoint_saved: false,
      local_checkpoint_error: "QuotaExceededError",
      run_id: "lifecycle",
      records_seen: 1,
      classified_count: 1,
      leads_count: 1,
      audit_count: 0,
    },
  });
  assert.ifError(completed.error);
  assert.equal(completed.result.status, "zero_result", JSON.stringify(completed.result.files.checkpoint_update));
  assert.equal(completed.page.closeCount, 1);
  assert.deepEqual(completed.page.gotoUrls, ["https://www.facebook.com/groups/example/?sorting_setting=CHRONOLOGICAL"]);
  assert.equal(completed.browser.closeCount, 1);
  assert.equal(completed.page.offCount, 1);
  assert.equal(completed.page.injectedCheckpoints["https://www.facebook.com/groups/example/"], "2026-10-06T00:00:00.000Z");
  assert.equal(completed.result.files.checkpoint_update.updated, true);
  assert.equal(completed.result.checkpoint_saved, true);
  assert.equal(completed.result.files.local_checkpoint_warning, "QuotaExceededError");
  assert.equal(completed.checkpointDocument.groups["https://www.facebook.com/groups/example/"].checkpoint, "2026-10-07T00:00:00.000Z");
  const completedLastRun = completed.checkpointDocument.groups["https://www.facebook.com/groups/example/"].last_run;
  assert.equal(completedLastRun.run_id, "lifecycle");
  assert.equal(completedLastRun.status, "zero_result_after_checkpoint");
  assert.equal(completedLastRun.local_checkpoint_error, "QuotaExceededError");
  assert.equal(completedLastRun.started_at, "2026-10-07T00:00:00.000Z");
  assert.match(completedLastRun.completed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const fileFailure = await runCase({
    lastRun: {
      group_url: "https://www.facebook.com/groups/example/", run_status: "zero_result_after_checkpoint",
      scan_started_at: "2026-10-07T00:00:00.000Z", previous_checkpoint: "2026-10-06T00:00:00.000Z",
      checkpoint_candidate: "2026-10-07T00:00:00.000Z", checkpoint_enabled: true,
      boundary_verified: true, records_seen: 1, run_id: "lifecycle", local_checkpoint_saved: false,
      local_checkpoint_error: "QuotaExceededError",
    },
    updateCheckpointManifest: () => { throw new Error("synthetic file write failure"); },
  });
  assert.equal(fileFailure.result.status, "checkpoint_not_saved");
  assert.equal(fileFailure.result.checkpoint_saved, false);
  assert.equal(fileFailure.result.files.checkpoint_update.reason, "checkpoint_file_write_failed");
  assert.equal(fileFailure.checkpointDocument.groups["https://www.facebook.com/groups/example/"].checkpoint, "2026-10-06T00:00:00.000Z");

  const boundaryMissing = await runCase({
    lastRun: {
      group_url: "https://www.facebook.com/groups/example/", run_status: "zero_result_after_checkpoint",
      scan_started_at: "2026-10-07T00:00:00.000Z", previous_checkpoint: "2026-10-06T00:00:00.000Z",
      checkpoint_candidate: "2026-10-07T00:00:00.000Z", checkpoint_enabled: true,
      boundary_verified: false, records_seen: 1, run_id: "lifecycle",
    },
  });
  assert.equal(boundaryMissing.result.status, "checkpoint_not_saved");
  assert.equal(boundaryMissing.checkpointDocument.groups["https://www.facebook.com/groups/example/"].checkpoint, "2026-10-06T00:00:00.000Z");

  const mismatchedRun = await runCase({
    lastRun: {
      group_url: "https://www.facebook.com/groups/example/", run_status: "zero_result_after_checkpoint",
      scan_started_at: "2026-10-07T00:00:00.000Z", previous_checkpoint: "2026-10-06T00:00:00.000Z",
      checkpoint_candidate: "2026-10-07T00:00:00.000Z", checkpoint_enabled: true,
      boundary_verified: true, records_seen: 1, run_id: "different-run",
    },
  });
  assert.equal(mismatchedRun.result.status, "checkpoint_not_saved");
  assert.equal(mismatchedRun.checkpointDocument.groups["https://www.facebook.com/groups/example/"].checkpoint, "2026-10-06T00:00:00.000Z");

  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      setItem: () => { const error = new Error("storage full"); error.name = "QuotaExceededError"; throw error; },
    } });
    assert.equal(pilot.writeCheckpoint("https://www.facebook.com/groups/example/", "2026-10-07T00:00:00.000Z"), false);
  } finally {
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage);
    else delete globalThis.localStorage;
  }

  const stopped = await runCase({ manifestStatus: "stopped" });
  assert.equal(stopped.result.status, "stopped");
  assert.equal(stopped.page.closeCount, 1);
  assert.equal(stopped.browser.closeCount, 1);
  assert.equal(stopped.commands.length, 0);
  assert.equal(stopped.checkpointDocument.groups["https://www.facebook.com/groups/example/"].checkpoint, "2026-10-06T00:00:00.000Z");

  const stoppedWithRows = await runCase({
    manifestStatus: "stopped",
    scanRows: [{
      group_name: "Example Group",
      group_url: "https://www.facebook.com/groups/example/",
      content_url: "https://www.facebook.com/groups/example/posts/456/?comment_id=789",
      post_url: "https://www.facebook.com/groups/example/posts/456/",
      comment_url: "https://www.facebook.com/groups/example/posts/456/?comment_id=789",
      name: "Comment Author",
      source_type: "comment",
      published_at_text: "7 giờ",
      text_excerpt: "Comment context",
    }],
    backfillCandidate: {
      post_url: "https://www.facebook.com/groups/example/posts/456/",
      name: "Root Author",
      published_at_text: "7 giờ",
      text_excerpt: "Root question",
    },
  });
  assert.equal(stoppedWithRows.result.status, "stopped");
  assert.equal(stoppedWithRows.result.files.backfill_only, true);
  assert.equal(stoppedWithRows.result.files.collector_status, "stopped");
  assert.equal(stoppedWithRows.result.files.post_root_backfill.succeeded, 1);
  assert.equal(stoppedWithRows.result.row_count, 2);
  assert.equal(stoppedWithRows.commands.length, 0);
  assert.equal(stoppedWithRows.browser.closeCount, 1);
  assert.equal(stoppedWithRows.checkpointDocument.groups["https://www.facebook.com/groups/example/"].checkpoint, "2026-10-06T00:00:00.000Z");

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
  const concurrentUpdate = runner.updateCheckpointManifest({
    filePath: updateFile, groupUrl: "https://www.facebook.com/groups/example/", groupName: "Example Group",
    lastRun: { group_url: "https://www.facebook.com/groups/example/", run_id: "other",
      run_status: "completed_with_rows", records_seen: 2, boundary_verified: true, checkpoint_enabled: true,
      previous_checkpoint: "2026-10-05T00:00:00.000Z", scan_started_at: "2026-10-08T00:00:00.000Z",
      checkpoint_candidate: "2026-10-08T00:00:00.000Z" },
  });
  assert.equal(concurrentUpdate.updated, false);
  assert.equal(concurrentUpdate.reason, "checkpoint_changed_during_scan");
  assert.equal(JSON.parse(fs.readFileSync(updateFile, "utf8")).groups["https://www.facebook.com/groups/example/"].checkpoint, "2026-10-06T00:00:00.000Z");
  fs.rmSync(updateDir, { recursive: true, force: true });

  const failed = await runCase({ ingestionExitCode: 1 });
  assert.match(failed.error.message, /Ingestion failed/);
  assert.equal(failed.page.closeCount, 1);
  assert.equal(failed.browser.closeCount, 1);

  const needsAction = await runCase({ action: "Facebook login required" });
  assert.equal(needsAction.result.status, "needs_user_action");
  assert.equal(needsAction.page.closeCount, 0);
  assert.equal(needsAction.browser.closeCount, 1);

  const visitedPostUrls = [];
  let backfillPageClosed = 0;
  const backfillPage = {
    goto: async (url) => { visitedPostUrls.push(url); },
    evaluate: async () => [{
      post_url: "https://www.facebook.com/groups/example/posts/456/?ref=share",
      name: "Root Author",
      published_at_text: "Hôm qua lúc 03:17",
      text_excerpt: "Has anyone had this procedure?",
    }],
    close: async () => { backfillPageClosed += 1; },
  };
  const backfill = await runner.backfillPostRoots({
    context: { newPage: async () => backfillPage },
    rows: [
      { content_url: "https://www.facebook.com/groups/example/posts/456/?comment_id=789", source_type: "comment" },
      { content_url: "https://www.facebook.com/groups/example/posts/456/?comment_id=790", source_type: "comment" },
    ],
    groupName: "Example Group",
    groupUrl: "https://www.facebook.com/groups/example/",
  });
  assert.equal(backfill.rows.length, 3);
  assert.equal(backfill.rows.at(-1).source_type, "post");
  assert.equal(backfill.rows.at(-1).content_url, "https://www.facebook.com/groups/example/posts/456/");
  assert.equal(backfill.rows.at(-1).post_url, "https://www.facebook.com/groups/example/posts/456/");
  assert.equal(backfill.rows.at(-1).comment_url, "");
  assert.equal(backfill.stats.attempted, 1);
  assert.equal(backfill.stats.succeeded, 1);
  assert.deepEqual(visitedPostUrls, ["https://www.facebook.com/groups/example/posts/456/?comment_id=789"]);
  assert.equal(backfillPageClosed, 1);

  let delayedEvaluateCalls = 0;
  let delayedPageClosed = 0;
  const delayedBackfill = await runner.backfillPostRoots({
    context: {
      newPage: async () => ({
        goto: async () => {},
        evaluate: async () => {
          delayedEvaluateCalls += 1;
          return delayedEvaluateCalls === 1 ? [] : [{
            post_url: "https://www.facebook.com/groups/example/posts/457/",
            name: "Delayed Author",
            published_at_text: "13 giờ",
            text_excerpt: "Delayed root question",
          }];
        },
        close: async () => { delayedPageClosed += 1; },
      }),
    },
    rows: [{
      content_url: "https://www.facebook.com/groups/example/posts/457/?comment_id=789",
      source_type: "comment",
    }],
    timeoutMs: 5_000,
  });
  assert.equal(delayedBackfill.stats.succeeded, 1);
  assert.equal(delayedBackfill.rows.at(-1).source_type, "post");
  assert.ok(delayedEvaluateCalls >= 2);
  assert.equal(delayedPageClosed, 1);

  let retryAttempts = 0;
  let retryPagesClosed = 0;
  const retriedBackfill = await runner.backfillPostRoots({
    context: {
      newPage: async () => {
        retryAttempts += 1;
        if (retryAttempts === 1) {
          return {
            goto: async () => { throw new Error("transient navigation failure"); },
            evaluate: async () => [],
            close: async () => { retryPagesClosed += 1; },
          };
        }
        return {
          goto: async () => {},
          evaluate: async () => [{
            post_url: "https://www.facebook.com/groups/example/posts/458/",
            name: "Retried Author",
            published_at_text: "19 phút",
            text_excerpt: "Recovered after retry",
          }],
          close: async () => { retryPagesClosed += 1; },
        };
      },
    },
    rows: [{
      content_url: "https://www.facebook.com/groups/example/posts/458/?comment_id=789",
      source_type: "comment",
    }],
    timeoutMs: 5_000,
  });
  assert.equal(retryAttempts, 2);
  assert.equal(retryPagesClosed, 2);
  assert.equal(retriedBackfill.stats.attempted, 1);
  assert.equal(retriedBackfill.stats.succeeded, 1);
  assert.equal(retriedBackfill.stats.failed, 0);
  assert.equal(retriedBackfill.rows.at(-1).source_type, "post");
  assert.equal(retriedBackfill.rows.at(-1).content_url, "https://www.facebook.com/groups/example/posts/458/");

  const failedBackfill = await runner.backfillPostRoots({
    context: {
      newPage: async () => ({
        goto: async () => {},
        evaluate: async () => [],
        close: async () => {},
      }),
    },
    rows: [{
      content_url: "https://www.facebook.com/groups/example/posts/999/?comment_id=789",
      source_type: "comment",
    }],
    timeoutMs: 1000,
  });
  assert.equal(failedBackfill.rows.length, 1);
  assert.equal(failedBackfill.stats.succeeded, 0);
  assert.equal(failedBackfill.stats.failed, 1);
  assert.deepEqual(failedBackfill.stats.quality_flags, ["post_root_backfill_failed"]);

  console.log("Browser runner lifecycle tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
