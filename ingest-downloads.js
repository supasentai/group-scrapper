"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pilot = require("./fb-group-lead-pilot.js");

const SCAN_FILENAME_PATTERN = /^fb_group_scan_(\d+)d_(.+)\.csv$/i;
const INGESTIBLE_STATUSES = new Set(["completed", "zero_result"]);
const TEMPORARY_SUFFIX_PATTERN = /\.(?:crdownload|part|tmp)$/i;

function makeManifestFilename(scanFilename) {
  return String(scanFilename || "").replace(/\.csv$/i, ".manifest.json");
}

function defaultDownloadsDir() {
  return path.join(os.homedir(), "Downloads");
}

function isSafeRunId(value) {
  return /^[A-Za-z0-9._-]+$/.test(String(value || ""));
}

function isTemporaryDownload(name) {
  return TEMPORARY_SUFFIX_PATTERN.test(String(name || ""));
}

function readStableFile(filePath) {
  const before = fs.statSync(filePath);
  const data = fs.readFileSync(filePath);
  const after = fs.statSync(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("file_changed_during_read");
  }
  return data;
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function isIsoUtc(value) {
  if (typeof value !== "string" || !value.endsWith("Z")) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function parseCsvMatrix(input) {
  const text = String(input || "").replace(/^\uFEFF/, "");
  const matrix = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      matrix.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("csv_unclosed_quote");
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    matrix.push(row);
  }
  return matrix;
}

function parseScanCsv(buffer, filename) {
  const matrix = parseCsvMatrix(buffer.toString("utf8"));
  if (!matrix.length || matrix[0].length !== pilot.CSV_HEADERS.length
    || matrix[0].some((header, index) => header !== pilot.CSV_HEADERS[index])) {
    throw new Error(`schema_mismatch:${filename}`);
  }
  const rows = matrix.slice(1).filter((row) => !(row.length === 1 && row[0] === ""));
  return rows.map((values, index) => {
    if (values.length !== pilot.CSV_HEADERS.length) {
      throw new Error(`row_width_mismatch:${filename}:${index + 2}:${values.length}`);
    }
    return Object.fromEntries(pilot.CSV_HEADERS.map((header, fieldIndex) => [header, values[fieldIndex] || ""]));
  });
}

function validateManifest(manifest, csvFilename, rows) {
  if (!manifest || typeof manifest !== "object") throw new Error("manifest_not_object");
  for (const field of ["group_url", "group_name", "run_id", "started_at", "completed_at", "output_file", "status"]) {
    if (typeof manifest[field] !== "string") throw new Error(`manifest_missing_${field}`);
  }
  if (!isSafeRunId(manifest.run_id)) throw new Error("manifest_invalid_run_id");
  if (!isIsoUtc(manifest.started_at) || !isIsoUtc(manifest.completed_at)) throw new Error("manifest_timestamp_not_iso_utc");
  if (path.basename(manifest.output_file) !== csvFilename) throw new Error("manifest_output_file_mismatch");
  if (!INGESTIBLE_STATUSES.has(manifest.status)) throw new Error(`manifest_status_not_ingestible:${manifest.status}`);
  if (!Number.isInteger(manifest.row_count) || manifest.row_count < 0) throw new Error("manifest_row_count_invalid");
  if (manifest.row_count !== rows.length) throw new Error(`row_count_mismatch:${manifest.row_count}:${rows.length}`);
  if (manifest.status === "zero_result" && manifest.row_count !== 0) throw new Error("zero_result_with_rows");
  if (manifest.group_url) {
    const mismatch = rows.find((row) => String(row.group_url || "").trim() !== manifest.group_url);
    if (mismatch) throw new Error("manifest_csv_group_url_mismatch");
  }
  if (manifest.group_name) {
    const mismatch = rows.find((row) => row.group_name && String(row.group_name).trim() !== manifest.group_name);
    if (mismatch) throw new Error("manifest_csv_group_name_mismatch");
  }
}

function readReport(reportPath) {
  if (!fs.existsSync(reportPath)) return { version: 1, entries: [] };
  const parsed = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  return parsed && Array.isArray(parsed.entries)
    ? { ...parsed, version: 1 }
    : { version: 1, entries: [] };
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function upsertEntry(report, entry) {
  const key = `${entry.run_id || ""}|${entry.csv_file || ""}`;
  const entries = report.entries.filter((current) => `${current.run_id || ""}|${current.csv_file || ""}` !== key);
  entries.push(entry);
  return { ...report, version: 1, entries };
}

function hasTemporaryMarker(dir, filename) {
  return [
    `${filename}.crdownload`,
    `${filename}.part`,
    `${filename}.tmp`,
  ].some((candidate) => fs.existsSync(path.join(dir, candidate)));
}

function ingestDirectory(inputDir, resultsDir) {
  const sourceDir = path.resolve(inputDir || defaultDownloadsDir());
  const destinationRoot = path.resolve(resultsDir || path.join(__dirname, "results"));
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`Source directory not found: ${sourceDir}`);
  }
  fs.mkdirSync(destinationRoot, { recursive: true });

  const reportPath = path.join(destinationRoot, "ingestion_report.json");
  let report = readReport(reportPath);
  const entries = [];
  const names = fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SCAN_FILENAME_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  for (const csvFilename of names) {
    const manifestFilename = makeManifestFilename(csvFilename);
    const baseEntry = {
      csv_file: csvFilename,
      manifest_file: manifestFilename,
      run_id: null,
      action: "skipped",
    };
    let manifest;
    let csvBuffer;
    let manifestBuffer;
    try {
      if (hasTemporaryMarker(sourceDir, csvFilename) || hasTemporaryMarker(sourceDir, manifestFilename)
        || isTemporaryDownload(csvFilename) || isTemporaryDownload(manifestFilename)) {
        throw new Error("temporary_download_detected");
      }
      const csvPath = path.join(sourceDir, csvFilename);
      const manifestPath = path.join(sourceDir, manifestFilename);
      if (!fs.existsSync(manifestPath)) throw new Error("manifest_missing");
      csvBuffer = readStableFile(csvPath);
      manifestBuffer = readStableFile(manifestPath);
      manifest = JSON.parse(manifestBuffer.toString("utf8").replace(/^\uFEFF/, ""));
      const rows = parseScanCsv(csvBuffer, csvFilename);
      validateManifest(manifest, csvFilename, rows);
      baseEntry.run_id = manifest.run_id;
      const csvHash = sha256(csvBuffer);
      const manifestHash = sha256(manifestBuffer);
      const runRoot = path.join(destinationRoot, manifest.run_id);
      const rawDir = path.join(runRoot, "raw");
      const destinationCsv = path.join(rawDir, csvFilename);
      const destinationManifest = path.join(rawDir, manifestFilename);
      const existingCsvHash = fs.existsSync(destinationCsv) ? sha256(fs.readFileSync(destinationCsv)) : null;
      const existingManifestHash = fs.existsSync(destinationManifest) ? sha256(fs.readFileSync(destinationManifest)) : null;
      const sameDestination = existingCsvHash === csvHash && existingManifestHash === manifestHash;

      if (sameDestination) {
        baseEntry.action = "already_ingested";
      } else if (existingCsvHash !== null || existingManifestHash !== null) {
        throw new Error("destination_conflict");
      } else {
        fs.mkdirSync(rawDir, { recursive: true });
        fs.copyFileSync(path.join(sourceDir, csvFilename), destinationCsv);
        fs.copyFileSync(path.join(sourceDir, manifestFilename), destinationManifest);
        baseEntry.action = "ingested";
      }
      Object.assign(baseEntry, {
        status: manifest.status,
        row_count: manifest.row_count,
        csv_sha256: csvHash,
        manifest_sha256: manifestHash,
        destination: path.relative(destinationRoot, rawDir),
      });
      const runReportPath = path.join(runRoot, "ingestion_report.json");
      let runReport = readReport(runReportPath);
      runReport = upsertEntry(runReport, baseEntry);
      runReport = {
        ...runReport,
        run_id: manifest.run_id,
        source_dir: sourceDir,
        ingested_at: new Date().toISOString(),
      };
      fs.mkdirSync(runRoot, { recursive: true });
      writeJsonAtomic(runReportPath, runReport);
    } catch (error) {
      baseEntry.reason = error.message || String(error);
    }
    report = upsertEntry(report, baseEntry);
    entries.push(baseEntry);
  }

  report = {
    ...report,
    source_dir: sourceDir,
    results_dir: destinationRoot,
    ingested_at: new Date().toISOString(),
    entries: report.entries,
  };
  writeJsonAtomic(reportPath, report);
  return { ...report, entries };
}

if (require.main === module) {
  const sourceDir = process.argv[2] || defaultDownloadsDir();
  const resultsDir = process.argv[3] || path.join(__dirname, "results");
  try {
    console.log(JSON.stringify(ingestDirectory(sourceDir, resultsDir), null, 2));
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  defaultDownloadsDir,
  ingestDirectory,
  makeManifestFilename,
  parseScanCsv,
  validateManifest,
};
