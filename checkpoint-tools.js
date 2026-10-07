/*
 * Persistent checkpoint manifest for the Facebook group scanner.
 *
 * Usage:
 *   node checkpoint-tools.js init
 *   node checkpoint-tools.js list
 *   node checkpoint-tools.js get <group-url>
 *   node checkpoint-tools.js register <group-url> [group-name]
 *   node checkpoint-tools.js set <group-url> <iso-timestamp> [group-name]
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

function usage() {
  console.error("Usage: node checkpoint-tools.js init|list|get|set|export-map ...");
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
