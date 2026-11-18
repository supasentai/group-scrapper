"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const batch = require("./batch-runner.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-profile-assignment-"));
const only = "https://www.facebook.com/groups/only9222/";
const both = "https://www.facebook.com/groups/both/";
const disabled = "https://www.facebook.com/groups/disabled/";
const file = path.join(dir, "checkpoints.json");
fs.writeFileSync(file, JSON.stringify({ groups: {
  [only]: { group_url: only, group_name: "Only 9222", enabled: true, allowed_profile_ports: [9222], checkpoint: "2026-11-17T00:00:00Z" },
  [both]: { group_url: both, group_name: "Both", enabled: true, allowed_profile_ports: [9222, 9223] },
  [disabled]: { group_url: disabled, group_name: "Disabled", enabled: false, allowed_profile_ports: [] },
} }));

function exercise(extraArgs = []) {
  const calls = [];
  const config = batch.parseArgs(["--checkpoints-file", file, "--results-dir", dir, ...extraArgs]);
  const manifest = batch.runBatch(config, { runGroup: (group, options) => {
    calls.push([group.group_url, new URL(options.cdpEndpoint).port]);
    return { status: "not_member" };
  } });
  return { calls, manifest };
}

const first = exercise(["--cdp-endpoints", "http://127.0.0.1:9222,http://127.0.0.1:9223"]);
assert.deepEqual(first.calls, [[only, "9222"], [both, "9223"], [both, "9222"]]);
assert.equal(first.manifest.groups.find(g => g.group_url === disabled).status, "skipped_disabled");
const second = exercise(["--cdp-endpoints", "http://127.0.0.1:9223"]);
assert.deepEqual(second.calls, [[both, "9223"]]);
assert.equal(second.manifest.groups.find(g => g.group_url === only).status, "no_available_profile");

const csv = path.join(dir, "groups.csv");
fs.writeFileSync(csv, `TÊN HỘI NHÓM,LINK\nOnly 9222,${only}\nDisabled,${disabled}\n`);
const legacy = exercise(["--groups-file", csv, "--cdp-endpoints", "http://127.0.0.1:9223"]);
assert.deepEqual(legacy.calls, []);
assert.ok(legacy.manifest.groups.every(g => g.status === "no_available_profile"));
const transportCalls = [];
const transportConfig = batch.parseArgs(["--checkpoints-file", file, "--results-dir", dir, "--cdp-endpoints", "http://127.0.0.1:9222,http://127.0.0.1:9223"]);
batch.runBatch(transportConfig, { runGroup: (group, options) => {
  transportCalls.push([group.group_url, new URL(options.cdpEndpoint).port]);
  return options.cdpEndpoint.endsWith(":9222")
    ? {status: "error", error: "browserType.connectOverCDP: Timeout 30000ms exceeded"}
    : {status: "not_member"};
} });
assert.deepEqual(transportCalls, [[only, "9222"], [both, "9223"]]);
assert.throws(() => batch.parseCheckpointsJson(JSON.stringify({groups: { [only]: { group_url: only, group_name: "Only", allowed_profile_ports: ["9222"] } }})), /allowed_profile_ports_invalid/);
console.log("Profile assignment tests passed.");
