"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_RESULTS_DIR = path.join(__dirname, "results");
const DEFAULT_OLDER_THAN_MS = 60 * 60 * 1000;
const STAGING_PATTERN = /^\.runner-staging-[A-Za-z0-9._-]+$/;

function parsePositiveInteger(value, flag) {
  if (!/^\d+$/.test(String(value || ""))) throw new Error(`${flag} must be a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${flag} is out of range`);
  return number;
}

function parseArgs(argv = process.argv.slice(2)) {
  const config = {
    resultsDir: DEFAULT_RESULTS_DIR,
    olderThanMs: DEFAULT_OLDER_THAN_MS,
    apply: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      config.help = true;
      continue;
    }
    if (flag === "--apply") {
      config.apply = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    index += 1;
    if (flag === "--results-dir") config.resultsDir = path.resolve(value);
    else if (flag === "--older-than-ms") config.olderThanMs = parsePositiveInteger(value, flag);
    else throw new Error(`Unknown option: ${flag}`);
  }
  return config;
}

function listFiles(rootDir, currentDir = rootDir) {
  if (!fs.existsSync(currentDir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(rootDir, fullPath));
    else files.push(fullPath);
  }
  return files;
}

function findReferences(resultsDir, candidatePath) {
  const absoluteCandidate = path.resolve(candidatePath);
  const relativeCandidate = path.relative(resultsDir, absoluteCandidate).replaceAll(path.sep, "/");
  const basename = path.basename(absoluteCandidate);
  return listFiles(resultsDir)
    .filter((filePath) => !filePath.startsWith(`${absoluteCandidate}${path.sep}`))
    .some((filePath) => {
      try {
        const text = fs.readFileSync(filePath, "utf8");
        return text.includes(absoluteCandidate) || text.includes(relativeCandidate) || text.includes(basename);
      } catch (_error) {
        return false;
      }
    });
}

function inspectStaging(config) {
  const resultsDir = path.resolve(config.resultsDir);
  if (!fs.existsSync(resultsDir)) return [];
  const now = Date.now();
  return fs.readdirSync(resultsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && STAGING_PATTERN.test(entry.name))
    .map((entry) => {
      const directory = path.join(resultsDir, entry.name);
      const stat = fs.statSync(directory);
      const ageMs = Math.max(0, now - stat.mtimeMs);
      const referenced = findReferences(resultsDir, directory);
      const current = ageMs < config.olderThanMs;
      return {
        path: directory,
        age_ms: Math.round(ageMs),
        referenced,
        current,
        eligible: !referenced && !current,
        reason: referenced ? "referenced" : current ? "too_recent" : null,
      };
    });
}

function cleanupStaging(config) {
  const entries = inspectStaging(config);
  const removed = [];
  if (config.apply) {
    for (const entry of entries.filter((candidate) => candidate.eligible)) {
      let stat;
      try {
        stat = fs.statSync(entry.path);
      } catch (_error) {
        continue;
      }
      if (Date.now() - stat.mtimeMs < config.olderThanMs || findReferences(config.resultsDir, entry.path)) continue;
      fs.rmSync(entry.path, { recursive: true, force: false });
      removed.push(entry.path);
    }
  }
  return {
    results_dir: path.resolve(config.resultsDir),
    dry_run: !config.apply,
    older_than_ms: config.olderThanMs,
    entries,
    removed,
  };
}

function usage() {
  return [
    "Usage:",
    "  node cleanup-staging.js --results-dir <dir> [--older-than-ms <n>] [--apply]",
    "",
    "Default mode is dry-run. --apply removes only old, unreferenced .runner-staging-* directories.",
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  try {
    const config = parseArgs(argv);
    if (config.help) {
      console.log(usage());
      return 0;
    }
    console.log(JSON.stringify(cleanupStaging(config), null, 2));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ status: "failed", error: String(error.stack || error) }, null, 2));
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { cleanupStaging, findReferences, inspectStaging, parseArgs };
