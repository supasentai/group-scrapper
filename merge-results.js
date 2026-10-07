"use strict";

const fs = require("node:fs");
const path = require("node:path");
const pilot = require("./fb-group-lead-pilot.js");

const HEADERS = [
  "group_name", "group_url", "content_url", "content_assessment", "published_at",
  "procedure", "doctor_name", "name", "profile_url", "segment", "source_type",
  "post_url", "comment_url", "published_at_text", "doctor_or_clinic", "intent_score",
  "authenticity_score", "seeding_risk", "classification_reasons", "text_excerpt",
  "review_status", "is_anonymous", "data_quality_flags",
];

const UI_CONTAMINATION_PATTERN = /(?:^[·•⋅]\s*(?:Theo dõi|theo dõi|Đang theo dõi|đang theo dõi|Follow(?:ing)?|follow(?:ing)?)(?:\s|[A-ZÀ-Ỹ])|^(?:Theo dõi|theo dõi|Đang theo dõi|đang theo dõi|Follow(?:ing)?|follow(?:ing)?)(?=[A-ZÀ-Ỹ])|Chỉ báo trạng thái online|Online status)/u;

function parseCsv(input) {
  const text = String(input || "").replace(/^\uFEFF/, "");
  const matrix = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
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
      if (row.some((value) => value !== "")) matrix.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    if (row.some((value) => value !== "")) matrix.push(row);
  }
  if (!matrix.length) return [];
  const headers = matrix.shift();
  return matrix.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function writeCsv(filePath, rows) {
  const body = [
    HEADERS.map(csvEscape).join(","),
    ...rows.map((row) => HEADERS.map((header) => csvEscape(row[header])).join(",")),
  ].join("\r\n");
  fs.writeFileSync(filePath, `\uFEFF${body}\r\n`, "utf8");
}

function chooseSourceFiles(dir) {
  const names = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".csv"));
  const isSource = (name) => /^fb_group_(?:scan|leads|audit)_\d+d_.+\.csv$/i.test(name)
    && !/_merged_/i.test(name)
    && !/_repaired_/i.test(name);
  // Có thể tồn tại đồng thời file merged và file từng group. Lấy tất cả
  // nguồn rồi dedupe ở bước sau để không bỏ sót file mới.
  return names.filter(isSource);
}

function parseDate(row, now) {
  if (row.published_at) {
    const parsed = new Date(row.published_at);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const explicit = String(row.published_at_text || "").trim();
  const fromField = pilot.parseFacebookTime(explicit, now);
  if (fromField) return fromField;
  const matches = String(row.text_excerpt || "").match(/(?:just now|now|vừa xong|\d+\s*(?:m|min|mins|h|hr|hrs|d|w|wk|wks|mo|mos|month|months|y|yr|yrs|year|years|phút|giờ|ngày|tuần|tháng|năm))/gi);
  return pilot.parseFacebookTime(matches?.at(-1) || "", now);
}

function isAnonymousName(name) {
  return pilot.isLikelyAnonymousAlias(name)
    || /^(?:Anonymous participant|Anonymous member|Người tham gia ẩn danh|Thành viên ẩn danh)(?:\s+\d+)?$/i.test(String(name || "").trim());
}

function normalizeRows(rows, now) {
  const normalized = rows.map((row, index) => {
    const inferred = pilot.inferAuthorFromText(row.text_excerpt || "");
    const rawName = pilot.cleanAuthorLabel(String(row.name || "").trim());
    const timeField = String(row.published_at_text || "").trim();
    const name = rawName && rawName !== timeField ? rawName : String(inferred.name || "").trim();
    const anonymous = row.is_anonymous === "yes" || isAnonymousName(name);
    const date = parseDate(row, now);
    const timeText = timeField || (String(row.text_excerpt || "").match(/(?:just now|now|vừa xong|\d+\s*(?:m|min|mins|h|hr|hrs|d|w|wk|wks|mo|mos|month|months|y|yr|yrs|year|years|phút|giờ|ngày|tuần|tháng|năm))/gi)?.at(-1) || "");
    const rawText = String(row.text_excerpt || "");
    const text = pilot.cleanSourceText(rawText, name, timeText);
    const groupUrl = row.group_url || "";
    const groupName = pilot.isLikelyUiGroupHeading(row.group_name) ? "" : (row.group_name || "");
    const rawContentUrl = String(row.content_url || "").trim();
    const rawPostUrl = String(row.post_url || "").trim();
    const postUrl = pilot.canonicalPostUrl(rawPostUrl || rawContentUrl) || rawPostUrl || rawContentUrl;
    const contentUrl = pilot.canonicalContentUrl(rawContentUrl)
      || pilot.canonicalContentUrl(row.comment_url || "")
      || rawContentUrl
      || postUrl;
    const commentUrl = pilot.canonicalContentUrl(row.comment_url || "")
      || (contentUrl && contentUrl !== postUrl ? contentUrl : "");
    return {
      ...row,
      _index: index,
      _date: date,
      _rawSourceType: row.source_type || "",
      group_name: groupName,
      group_url: groupUrl,
      post_url: postUrl,
      comment_url: commentUrl,
      content_url: contentUrl,
      published_at: date ? date.toISOString() : "",
      published_at_text: date ? date.toISOString() : timeText,
      name,
      profile_url: anonymous ? "" : (row.profile_url || ""),
      is_anonymous: anonymous ? "yes" : "no",
      _raw_text: rawText,
      text_excerpt: text,
    };
  });

  const byPost = new Map();
  for (const row of normalized) {
    const key = `${row.group_url}|${row.post_url}`;
    if (!byPost.has(key)) byPost.set(key, { rootSeen: false, identities: new Set() });
    const state = byPost.get(key);
    const identity = `${row.profile_url || `name:${row.name || "unknown"}`}|${pilot.textFingerprint(row.text_excerpt)}`;
    const explicitType = /^(?:comment|reply)$/i.test(row._rawSourceType);
    const explicitPermalink = /(?:comment_id|reply_comment_id)=/i.test(`${row.comment_url || ""} ${row.content_url || ""}`)
      || row.content_url !== row.post_url;
    row._sourceTypeInferred = false;
    if (explicitType) row.source_type = row._rawSourceType.toLowerCase();
    else if (/reply_comment_id=/i.test(row.content_url)) row.source_type = "reply";
    else if (/comment_id=/i.test(row.content_url) || row.content_url !== row.post_url) row.source_type = "comment";
    else if (!state.rootSeen) {
      row.source_type = "post";
      state.rootSeen = true;
    } else if (!state.identities.has(identity)) {
      row.source_type = "comment";
      row._sourceTypeInferred = true;
    } else {
      row.source_type = "post";
    }
    if (explicitPermalink) row._sourceTypeInferred = false;
    state.identities.add(identity);
    if (row.source_type !== "post" && !row.comment_url) {
      row.comment_url = row.post_url;
      row.content_url = row.post_url;
    }
  }

  const byAuthor = new Map();
  const byText = new Map();
  for (const row of normalized) {
    const authorKey = row.profile_url || `name:${row.name || "unknown"}`;
    const textKey = pilot.textFingerprint(row.text_excerpt);
    byAuthor.set(authorKey, (byAuthor.get(authorKey) || 0) + 1);
    byText.set(textKey, (byText.get(textKey) || 0) + 1);
  }

  return normalized.map((row) => {
    const analysis = pilot.analyzeText(row.text_excerpt, {
      isAnonymous: row.is_anonymous === "yes",
      authorActivityCount: byAuthor.get(row.profile_url || `name:${row.name || "unknown"}`) || 1,
      duplicateCount: byText.get(pilot.textFingerprint(row.text_excerpt)) || 1,
    });
    const contentAssessment = analysis.segment === "experienced_customer"
      ? "review"
      : analysis.segment === "potential_customer"
        ? "service_question"
        : analysis.segment;
    const flags = String(row.data_quality_flags || "")
      .split(/[;|]/)
      .map((flag) => flag.trim())
      .filter(Boolean);
    const addFlag = (flag) => {
      if (!flags.includes(flag)) flags.push(flag);
    };
    if (UI_CONTAMINATION_PATTERN.test(row._raw_text)) addFlag("ui_chrome_contamination");
    if (!row.name) addFlag("missing_author_name");
    if (!row.profile_url && row.is_anonymous !== "yes") addFlag("missing_profile_url");
    if (row.source_type !== "post" && row.comment_url === row.post_url) addFlag("comment_permalink_missing");
    if (row._sourceTypeInferred && row.source_type !== "post") addFlag("source_type_inferred");
    if (!row._date) addFlag("missing_or_unparsed_time");
    if (/(?:Thích|Trả lời|Chia sẻ|Like|React|Reply|Share)(?=\s*(?:\d+|Thích|Trả lời|Chia sẻ|Like|React|Reply|Share|$))/.test(row._raw_text)) addFlag("ui_chrome_removed");
    if (/…\s*(?:Xem thêm|See more)/i.test(row._raw_text)) addFlag("text_truncated");
    return {
      group_name: row.group_name,
      group_url: row.group_url,
      content_url: row.content_url || row.post_url,
      content_assessment: contentAssessment,
      published_at: row.published_at,
      procedure: analysis.procedures,
      doctor_name: analysis.doctorOrClinic,
      name: row.name,
      profile_url: row.profile_url,
      segment: analysis.segment,
      source_type: row.source_type,
      post_url: row.post_url,
      comment_url: row.comment_url,
      published_at_text: row.published_at_text,
      doctor_or_clinic: analysis.doctorOrClinic,
      intent_score: analysis.intentScore,
      authenticity_score: analysis.authenticityScore,
      seeding_risk: analysis.seedingRisk,
      classification_reasons: analysis.reasons,
      text_excerpt: row.text_excerpt,
      review_status: analysis.segment === "seed_suspect"
        ? "excluded_seed_suspect"
        : analysis.segment === "noise"
          ? "excluded_noise"
          : "pending_human_review",
      is_anonymous: row.is_anonymous,
      data_quality_flags: flags.join(";"),
      _date: row._date,
      _index: row._index,
    };
  });
}

function dedupe(rows) {
  const result = new Map();
  for (const row of rows) {
    const identity = row.profile_url || `anon:${row.name || "unknown"}`;
    const key = [row.group_url, identity, row.post_url, row.source_type, pilot.textFingerprint(row.text_excerpt)].join("|");
    const previous = result.get(key);
    if (!previous || row.text_excerpt.length > previous.text_excerpt.length) result.set(key, row);
  }
  return [...result.values()].sort((a, b) => (a._date || 0) - (b._date || 0) || a._index - b._index);
}

function qualityFlagsForReport(sourceTypeCounts, qualityFlagCounts, rowCount) {
  const qualityFlags = [];
  if (rowCount && !sourceTypeCounts.post) qualityFlags.push("no_post_rows_detected");
  if (qualityFlagCounts.ui_chrome_removed) qualityFlags.push("source_ui_chrome_detected");
  if (qualityFlagCounts.ui_chrome_contamination) qualityFlags.push("ui_chrome_contamination_detected");
  if (qualityFlagCounts.text_truncated) qualityFlags.push("source_text_truncated_detected");
  if (qualityFlagCounts.source_type_inferred) qualityFlags.push("source_type_inferred");
  if (qualityFlagCounts.comment_permalink_missing) qualityFlags.push("comment_permalink_missing");
  return qualityFlags;
}

function main() {
  const dir = path.resolve(process.argv[2] || path.join(__dirname, "results"));
  const days = Number(process.argv[3] || 30);
  const now = new Date();
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const sourceFiles = chooseSourceFiles(dir);
  if (!sourceFiles.length) throw new Error(`Không tìm thấy file scan/lead/audit trong ${dir}`);

  const raw = sourceFiles.flatMap((name) => parseCsv(fs.readFileSync(path.join(dir, name), "utf8")));
  const normalized = dedupe(normalizeRows(raw, now));
  const inWindow = normalized.filter((row) => row._date && row._date >= cutoff);
  const unresolved = normalized.filter((row) => !row._date);
  const old = normalized.filter((row) => row._date && row._date < cutoff);
  const all = inWindow.map(({ _date, _index, ...row }) => row);
  const leads = all.filter((row) =>
    ["potential_customer", "experienced_customer"].includes(row.segment)
      && Number(row.intent_score) >= 45
      && Number(row.seeding_risk) <= 59
  );
  const audit = all.filter((row) => !leads.includes(row));
  const stamp = now.toISOString().slice(0, 10).replaceAll("-", "");
  const outputs = {
    all: path.join(dir, `fb_group_${days}d_repaired_all_${stamp}_utf8.csv`),
    leads: path.join(dir, `fb_group_${days}d_repaired_leads_${stamp}_utf8.csv`),
    audit: path.join(dir, `fb_group_${days}d_repaired_audit_${stamp}_utf8.csv`),
  };
  writeCsv(outputs.all, all);
  writeCsv(outputs.leads, leads);
  writeCsv(outputs.audit, audit);
  const sourceTypeCounts = {};
  for (const row of all) sourceTypeCounts[row.source_type] = (sourceTypeCounts[row.source_type] || 0) + 1;
  const qualityFlagCounts = {};
  for (const row of all) {
    for (const flag of String(row.data_quality_flags || "").split(";").map((value) => value.trim()).filter(Boolean)) {
      qualityFlagCounts[flag] = (qualityFlagCounts[flag] || 0) + 1;
    }
  }
  const qualityFlags = qualityFlagsForReport(sourceTypeCounts, qualityFlagCounts, all.length);
  const report = {
    source_files: sourceFiles,
    raw_rows: raw.length,
    deduped_rows: normalized.length,
    in_window_rows: all.length,
    lead_rows: leads.length,
    audit_rows: audit.length,
    dropped_old_rows: old.length,
    unresolved_time_rows: unresolved.length,
    source_type_counts: sourceTypeCounts,
    quality_flags: qualityFlags,
    quality_flag_counts: qualityFlagCounts,
    anonymous_rows: all.filter((row) => row.is_anonymous === "yes").length,
    missing_profile_rows: all.filter((row) => !row.profile_url && row.is_anonymous !== "yes").length,
    outputs,
  };
  fs.writeFileSync(path.join(dir, `quality_report_${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main();

module.exports = { parseCsv, normalizeRows, dedupe, chooseSourceFiles, qualityFlagsForReport };
