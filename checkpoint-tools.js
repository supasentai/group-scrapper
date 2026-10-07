/*
 * Persistent checkpoint manifest for the Facebook group scanner.
 *
 * Usage:
 *   node checkpoint-tools.js init
 *   node checkpoint-tools.js list
 *   node checkpoint-tools.js get <group-url>
 *   node checkpoint-tools.js register <group-url> [group-name]
 *   node checkpoint-tools.js set <group-url> <iso-timestamp> [group-name]
 *   node checkpoint-tools.js record-run <group-url> <status> <scan-started-at> <records-seen> <classified-count> <leads-count> <audit-count> [group-name]
 *   node checkpoint-tools.js export-map
 */
const fs = require("fs");
const path = require("path");

const MANIFEST_PATH = path.join(__dirname, "checkpoints.json");
const VERSION = 1;

function canonicalGroupUrl(rawUrl) {
  const url = new URL(rawUrl);
  const match = url.pathname.match(/^\/groups\/([^/]+)/i);
  if (!match) throw new Error(`Không phải URL Facebook Group: ${rawUrl}`);
  return `${url.origin}/groups/${match[1]}/`;
}

function emptyManifest() {
  return { version: VERSION, updated_at: null, groups: {} };
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return emptyManifest();
  const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  if (!parsed || typeof parsed !== "object" || !parsed.groups || typeof parsed.groups !== "object") {
    throw new Error(`Manifest không hợp lệ: ${MANIFEST_PATH}`);
  }
  return { version: VERSION, updated_at: parsed.updated_at || null, groups: parsed.groups };
}

function writeManifest(manifest) {
  const next = { ...manifest, version: VERSION, updated_at: new Date().toISOString() };
  const tempPath = `${MANIFEST_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, MANIFEST_PATH);
  return next;
}

function assertIso(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Timestamp không hợp lệ: ${value}`);
  return date.toISOString();
}

function assertNonNegativeInteger(value, label) {
  if (!/^\d+$/.test(String(value || ""))) throw new Error(`${label} phải là số nguyên không âm: ${value}`);
  return Number(value);
}

function usage() {
  console.error("Usage: node checkpoint-tools.js init|list|get|set|record-run|export-map ...");
  process.exitCode = 2;
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "init") {
    if (!fs.existsSync(MANIFEST_PATH)) writeManifest(emptyManifest());
    console.log(MANIFEST_PATH);
  } else if (command === "list") {
    console.log(JSON.stringify(readManifest(), null, 2));
  } else if (command === "get") {
    if (!args[0]) throw new Error("Thiếu group URL");
    const url = canonicalGroupUrl(args[0]);
    const record = readManifest().groups[url] || null;
    console.log(JSON.stringify({ group_url: url, record }, null, 2));
  } else if (command === "register") {
    if (!args[0]) throw new Error("Thiếu group URL");
    const url = canonicalGroupUrl(args[0]);
    const manifest = readManifest();
    manifest.groups[url] = {
      ...(manifest.groups[url] || {}),
      group_url: url,
      group_name: args.slice(1).join(" ") || manifest.groups[url]?.group_name || "",
      checkpoint: manifest.groups[url]?.checkpoint || null,
    };
    writeManifest(manifest);
    console.log(JSON.stringify(manifest.groups[url], null, 2));
  } else if (command === "set") {
    if (!args[0] || !args[1]) throw new Error("Thiếu group URL hoặc timestamp");
    const url = canonicalGroupUrl(args[0]);
    const timestamp = assertIso(args[1]);
    const manifest = readManifest();
    manifest.groups[url] = {
      ...(manifest.groups[url] || {}),
      group_url: url,
      group_name: args.slice(2).join(" ") || manifest.groups[url]?.group_name || "",
      checkpoint: timestamp,
    };
    writeManifest(manifest);
    console.log(JSON.stringify(manifest.groups[url], null, 2));
  } else if (command === "record-run") {
    if (args.length < 7) throw new Error("Thiếu group URL, trạng thái hoặc thống kê lượt chạy");
    const url = canonicalGroupUrl(args[0]);
    const allowedStatuses = new Set(["completed_with_rows", "zero_result_after_checkpoint", "no_records_seen", "stopped"]);
    if (!allowedStatuses.has(args[1])) throw new Error(`Trạng thái lượt chạy không hợp lệ: ${args[1]}`);
    const scanStartedAt = assertIso(args[2]);
    const manifest = readManifest();
    const current = manifest.groups[url] || {};
    manifest.groups[url] = {
      ...current,
      group_url: url,
      group_name: args.slice(7).join(" ") || current.group_name || "",
      checkpoint: current.checkpoint || null,
      last_run: {
        status: args[1],
        scan_started_at: scanStartedAt,
        records_seen: assertNonNegativeInteger(args[3], "records_seen"),
        classified_count: assertNonNegativeInteger(args[4], "classified_count"),
        leads_count: assertNonNegativeInteger(args[5], "leads_count"),
        audit_count: assertNonNegativeInteger(args[6], "audit_count"),
        recorded_at: new Date().toISOString(),
      },
    };
    writeManifest(manifest);
    console.log(JSON.stringify(manifest.groups[url], null, 2));
  } else if (command === "export-map") {
    const manifest = readManifest();
    const map = {};
    for (const [url, record] of Object.entries(manifest.groups)) map[url] = record?.checkpoint || null;
    console.log(JSON.stringify(map));
  } else {
    usage();
  }
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
