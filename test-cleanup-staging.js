"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cleanup = require("./cleanup-staging.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "group-scrapper-cleanup-test-"));
try {
  const oldDir = path.join(tempDir, ".runner-staging-old");
  const referencedDir = path.join(tempDir, ".runner-staging-referenced");
  const currentDir = path.join(tempDir, ".runner-staging-current");
  for (const directory of [oldDir, referencedDir, currentDir]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(referencedDir, "marker.txt"), "marker", "utf8");
  fs.writeFileSync(path.join(tempDir, "batch_manifest.json"), `references ${referencedDir}`, "utf8");
  const oldTime = new Date(Date.now() - 10_000);
  fs.utimesSync(oldDir, oldTime, oldTime);
  fs.utimesSync(referencedDir, oldTime, oldTime);

  const dryRun = cleanup.cleanupStaging({ resultsDir: tempDir, olderThanMs: 1_000, apply: false });
  assert.equal(dryRun.dry_run, true);
  assert.equal(dryRun.removed.length, 0);
  assert.equal(dryRun.entries.find((entry) => entry.path === oldDir).eligible, true);
  assert.equal(dryRun.entries.find((entry) => entry.path === referencedDir).reason, "referenced");
  assert.equal(fs.existsSync(oldDir), true);

  const applied = cleanup.cleanupStaging({ resultsDir: tempDir, olderThanMs: 1_000, apply: true });
  assert.deepEqual(applied.removed, [oldDir]);
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(referencedDir), true);
  assert.equal(fs.existsSync(currentDir), true);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("Cleanup staging tests passed.");
