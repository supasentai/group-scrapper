/**
 * Facebook Group Lead Pilot
 *
 * Thu thập các bài viết/bình luận đang được Facebook hiển thị, chấm điểm
 * tín hiệu nhu cầu và rủi ro seeding, sau đó xuất CSV để kiểm duyệt.
 *
 * Phạm vi mặc định: 30 ngày. Không gọi API nội bộ, không lấy dữ liệu ẩn,
 * không tự mở profile và không thu thập email/số điện thoại.
 */
(function bootstrap(root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }

  root.FBGroupLeadPilot = api;
  try {
    const bootstrapOptions = root.__FB_GROUP_LEAD_PILOT_OPTIONS__ || {};
    const runPromise = api.run(bootstrapOptions);
    // Expose a small promise handle so the runner can read the final
    // checkpoint metadata without scraping the HUD text.
    root.__FB_GROUP_LEAD_PILOT_RUN__ = runPromise;
    runPromise?.catch((error) => {
      root.__FB_GROUP_LEAD_PILOT_ERROR__ = String(error?.stack || error);
    });
  } catch (error) {
    root.__FB_GROUP_LEAD_PILOT_ERROR__ = String(error?.stack || error);
    throw error;
  }
})(typeof globalThis !== "undefined" ? globalThis : window, function createPilot() {
  "use strict";

  const CONFIG = {
    days: 30,
    scrollIntervalMs: 2200,
    maxIdleRounds: 12,
    maxOldPostRounds: 6,
    maxRounds: 0,
    maxRuntimeMs: 0,
    maxExpandClicksPerRound: 12,
    minimumIntentScore: 45,
    maximumSeedingRisk: 59,
    useCheckpoint: true,
    checkpointStoragePrefix: "fb_group_lead_pilot_checkpoint_v1:",
  };

  const CSV_HEADERS = [
    "group_name",
    "group_url",
    "content_url",
    "name",
    "profile_url",
    "source_type",
    "published_at_text",
    "text_excerpt",
  ];

  const PROCEDURES = [
    ["bbl", /\b(?:bbl|brazilian butt lift)\b/i],
    ["liposuction", /\b(?:lipo(?:suction)?|vaser|hút mỡ|hut mo)\b/i],
    ["tummy_tuck", /\b(?:tummy tuck|abdominoplasty|căng da bụng|cang da bung)\b/i],
    ["breast", /\b(?:breast (?:augmentation|implant|lift|reduction)|implants?|boob job|nâng ngực|nang nguc|treo ngực|treo nguc|giảm ngực|giam nguc)\b/i],
    ["facelift", /\b(?:face ?lift|neck ?lift|căng da mặt|cang da mat)\b/i],
    ["brow_lift", /\b(?:brow ?lift|forehead reduction|nâng chân mày|nang chan may)\b/i],
    ["temple_lift", /\b(?:temple ?lift|endoscopic temple lift)\b/i],
    ["skin_tightening", /\b(?:skin tightening|tighten my skin|firmer skin|căng da|cang da)\b/i],
    ["rhinoplasty", /\b(?:rhinoplasty|nose job|nâng mũi|nang mui|sửa mũi|sua mui)\b/i],
    ["eyelid", /\b(?:bleph(?:aroplasty)?|eyelid surgery|double eyelid|lower bleph|upper bleph|cắt mí|cat mi|nhấn mí|nhan mi)\b/i],
    ["filler_botox", /\b(?:fillers?|botox|tiêm filler|tiem filler)\b/i],
    ["jaw_chin", /\b(?:jaw|chin implant|genioplasty|gọt hàm|got ham|độn cằm|don cam)\b/i],
    ["arm_lift", /\b(?:arm ?lift|brachioplasty|nâng cánh tay|nang canh tay)\b/i],
    ["body_lift", /\b(?:body ?lift|lower body lift|360 lift)\b/i],
    ["mommy_makeover", /\b(?:mommy makeover|mummy makeover)\b/i],
    ["hair", /\b(?:hair transplant|cấy tóc|cay toc)\b/i],
    ["dental", /\b(?:veneers?|dental implant|bọc răng|boc rang|niềng răng|nieng rang)\b/i],
    ["cosmetic_surgery", /\b(?:cosmetic surgery|plastic surgery|phẫu thuật thẩm mỹ|phau thuat tham my)\b/i],
  ];

  const PROSPECT_PATTERNS = [
    /\b(?:i(?:'m| am)? (?:considering|planning|thinking|looking)|i want|i need|i would like|interested in)\b/i,
    /\b(?:has anyone|any recommendations?|recommend(?:ation)?|who do you recommend|please advise|please enlighten)\b/i,
    /\b(?:booked|booking|consultation|quote|price|cost|how much|next (?:week|month|year)|this (?:week|month|year))\b/i,
    /\b(?:tôi|mình|em) (?:đang|muốn|cần|dự định|định|sắp|quan tâm)\b/i,
    /\b(?:xin review|ai đã làm|ai làm rồi|giới thiệu|tư vấn|chi phí|giá bao nhiêu|đặt lịch|book lịch)\b/i,
  ];

  const EXPERIENCE_PATTERNS = [
    /\b(?:i had|i've had|i have had|i did|my surgery|my procedure|my review|post[- ]?op|recovery|healing|results?|before and after)\b/i,
    /\b(?:days?|weeks?|months?) (?:post[- ]?op|after (?:surgery|my procedure))\b/i,
    /\b(?:tôi|mình|em) (?:đã|vừa) (?:làm|phẫu thuật|nâng|hút|cắt|tiêm)\b/i,
    /\b(?:trải nghiệm|review của tôi|hậu phẫu|hồi phục|kết quả sau|sau phẫu thuật)\b/i,
  ];

  const FIRST_PERSON_PATTERNS = [
    /\b(?:i|i'm|i've|my|me|mine)\b/i,
    /\b(?:tôi|mình|em|của tôi|của mình|của em)\b/i,
  ];

  const PERSONAL_DETAIL_PATTERNS = [
    /\b(?:pain|swelling|scar|nurse|aftercare|hospital|recovery|healing|night|flight|visa|hotel)\b/i,
    /\b(?:đau|sưng|sẹo|y tá|hậu phẫu|bệnh viện|hồi phục|chuyến bay|khách sạn)\b/i,
    /(?:\$|usd|aud|vnd|triệu|million)\s?\d|\d[\d,.]*\s?(?:usd|aud|vnd|triệu|million)/i,
  ];

  const SEEDING_PATTERNS = [
    /\b(?:inbox me|dm me|message me|contact me|whats ?app|call now|book now|limited offer|promotion|discount)\b/i,
    /\b(?:nhắn (?:tin|mình|em)|ib (?:mình|em)|inbox|liên hệ|hotline|ưu đãi|khuyến mãi|đặt lịch ngay)\b/i,
    /\b(?:our clinic|our hospital|our doctor|our team|consultant|coordinator|customer service)\b/i,
    /\b(?:phòng khám chúng tôi|bệnh viện chúng tôi|bác sĩ bên mình|đội ngũ chúng tôi|tư vấn viên|điều phối viên)\b/i,
    /\b(?:for our clients?|we use|we offer|we provide|our clients?|can recommend the best|best plastic surgeon|their assistant|jci[- ]?accredited|internationally accredited)\b/i,
    /\b(?:cho khách hàng|chúng tôi dùng|chúng tôi cung cấp|khách hàng của chúng tôi|có thể giới thiệu bác sĩ tốt nhất|trợ lý của họ|được jci công nhận)\b/i,
    /(?:https?:\/\/|www\.|wa\.me\/|t\.me\/)/i,
    /(?:\+?\d[\d .()-]{7,}\d)/,
  ];

  const STRONG_SEEDING_PATTERNS = [
    /\b(?:for our clients?|our clients?|we use|we offer|we provide|can recommend the best|best plastic surgeon|their assistant|jci[- ]?accredited|internationally accredited)\b/i,
    /\b(?:cho khách hàng|chúng tôi dùng|chúng tôi cung cấp|khách hàng của chúng tôi|có thể giới thiệu bác sĩ tốt nhất|trợ lý của họ|được jci công nhận)\b/i,
  ];

  const UI_LINE_PATTERNS = [
    /^(?:Like|React|Reply|Share|Send|Shared post)$/i,
    /^(?:Thích|Trả lời|Chia sẻ|Gửi)$/i,
    /^(?:Write an answer|Submit your first comment|View more comments|See more)(?:…|\.\.\.)?$/i,
    /^\d+\s+(?:reactions?|comments?|replies)$/i,
    /^(?:Like|React|Reply|Share|Follow|Edited|See translation|View translation)$/i,
    /^(?:Thích|Trả lời|Chia sẻ|Theo dõi|Đã chỉnh sửa|Xem bản dịch)$/i,
    /^(?:Xem thêm|See more|nhiều nhất|phổ biến nhất|Most relevant|nổi bật|Featured|Highlighted|Người kiểm duyệt nổi bật|Top contributor|Chuyên gia trong nhóm|Group expert)(?:\s*[·•]\s*(?:Theo dõi|Follow))?$/i,
    /^[·•]$/,
  ];

  const INLINE_UI_PATTERNS = [
    // Chỉ bỏ nhãn UI nhiều từ. Các từ đơn như "like", "share", "thích"
    // có thể là nội dung thật của người dùng nên không được xóa giữa câu.
    /\b(?:See translation|View translation)\b/gi,
    /(?:Xem bản dịch|Đã chỉnh sửa)/gi,
    /(?:Tác giả|Quản trị viên|Người đóng góp(?: đang lên)?)/gi,
    /\b\d+\s+(?:reactions?|comments?|replies?)\b/gi,
  ];

  const TIME_TEXT_PATTERN = /(?:\b(?:just now|now|vừa xong|today|yesterday|hôm nay|hôm qua)\b|\b\d+\s*(?:m|min|mins|h|hr|hrs|d|w|wk|wks|mo|mos|month|months|y|yr|yrs|year|years|phút|giờ|ngày|tuần|tháng|năm)\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b|\b\d{1,2}\s+tháng\s+\d{1,2}\b)/i;

  // Facebook render các nút này viết hoa chữ đầu. Giữ regex phân biệt hoa/thường
  // để không xóa từ tự nhiên như "I like this" hoặc "please share".
  const INLINE_ACTION_PATTERN = /(?:Thích|Trả lời|Chia sẻ|Like|React|Reply|Share|Follow|Theo dõi)(?=\s*(?:\d+|Thích|Trả lời|Chia sẻ|Like|React|Reply|Share|Follow|Theo dõi|$))/g;
  const INLINE_CHROME_PATTERN = /(?:See translation|View translation|Xem bản dịch|Xem thêm|See more|Đã chỉnh sửa|nhiều nhất|phổ biến nhất|Most relevant|nổi bật|Featured|Highlighted|Người kiểm duyệt nổi bật|Top contributor|Chuyên gia trong nhóm|Group expert)(?=\s*(?:·|•|Theo dõi|Follow|\d+|$))/gi;
  const LEADING_FOLLOW_PATTERN = /^(?:[·•⋅]\s*(?:Theo dõi|theo dõi|Đang theo dõi|đang theo dõi|Follow(?:ing)?|follow(?:ing)?)(?:\s*[·•⋅]\s*)?|(?:Theo dõi|theo dõi|Đang theo dõi|đang theo dõi|Follow(?:ing)?|follow(?:ing)?)(?=[A-ZÀ-Ỹ]))/u;
  const AUTHOR_STATUS_PATTERN = /(?:Chỉ báo trạng thái online|Online status)(?:\s*(?:Đang hoạt động|Active now))?|(?:Đang hoạt động|Active now)$/gi;
  const LEADING_AUTHOR_STATUS_PATTERN = /^(?:Chỉ báo trạng thái online|Online status)(?:\s*(?:Đang hoạt động|Active now))?\s*/iu;

  const UI_GROUP_HEADINGS = new Set([
    "about",
    "bạn bè",
    "cài đặt",
    "discussion",
    "feed",
    "friends",
    "groups",
    "home",
    "info",
    "marketplace",
    "menu",
    "more",
    "nhóm",
    "notifications",
    "notification",
    "reels",
    "search",
    "settings",
    "shortcuts",
    "thảo luận",
    "thông báo",
    "thông tin",
    "trang chủ",
    "video",
    "watch",
  ]);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const normalizeSpace = (value) => String(value || "").replace(/\s+/g, " ").trim();

  function isLikelyUiGroupHeading(value) {
    return UI_GROUP_HEADINGS.has(normalizeSpace(value).toLowerCase());
  }

  function isLikelyMemberCount(value) {
    return /^\d[\d.,]*\s*[KMB]?\s*(?:thành viên|members?)$/i.test(normalizeSpace(value));
  }

  function isLikelyPostTitle(value) {
    const text = normalizeSpace(value);
    return /\?|\b(?:has anyone|anyone got|anyone had|looking for|recommend(?:ation)?|quote from|how much|what price)\b/i.test(text);
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function cleanAuthorLabel(value) {
    return normalizeSpace(String(value || "").replace(AUTHOR_STATUS_PATTERN, " "));
  }

  function hasFacebookChrome(rawText) {
    const text = String(rawText || "");
    INLINE_ACTION_PATTERN.lastIndex = 0;
    INLINE_CHROME_PATTERN.lastIndex = 0;
    const hasInlineAction = INLINE_ACTION_PATTERN.test(text);
    const hasInlineChrome = INLINE_CHROME_PATTERN.test(text);
    INLINE_ACTION_PATTERN.lastIndex = 0;
    INLINE_CHROME_PATTERN.lastIndex = 0;
    return UI_LINE_PATTERNS.some((pattern) => pattern.test(normalizeSpace(text)))
      || hasInlineAction
      || hasInlineChrome
      || /\b\d+\s+(?:reactions?|comments?|replies?)\b/i.test(text);
  }

  function isLikelyAnonymousAlias(name) {
    const value = normalizeSpace(name);
    if (!value) return false;

    if (/^(?:anonymous (?:participant|member)|người tham gia ẩn danh|thành viên ẩn danh)$/i.test(value)) {
      return true;
    }

    // Facebook cấp nickname ẩn danh dạng AdjectiveNoun + 3–4 chữ số,
    // ví dụ TrustyRhino842, SunnyKangaroo8613 hoặc PastelLychee5270.
    return /^[A-Z][a-z]{2,24}[A-Z][a-z]{2,24}\d{3,4}$/.test(value);
  }

  function canonicalPostUrl(rawUrl) {
    if (!rawUrl) return "";
    try {
      const base = typeof location !== "undefined" && location.origin
        ? location.origin
        : "https://www.facebook.com";
      const url = new URL(rawUrl, base);
      const match = url.pathname.match(/\/groups\/([^/]+)\/posts\/(\d+)/);
      if (match) return `${url.origin}/groups/${match[1]}/posts/${match[2]}/`;

      // Một số giao diện Facebook vẫn dùng permalink.php?story_fbid=...&id=...
      // thay vì /groups/<id>/posts/<id>/.
      const storyId = url.searchParams.get("story_fbid") || url.searchParams.get("post_id");
      const groupMatch = url.pathname.match(/\/groups\/([^/]+)/i);
      const currentGroupMatch = typeof location !== "undefined"
        ? location.pathname.match(/\/groups\/([^/]+)/i)
        : null;
      const groupId = groupMatch?.[1] || url.searchParams.get("id") || currentGroupMatch?.[1];
      return storyId && groupId
        ? `${url.origin}/groups/${groupId}/posts/${storyId}/`
        : "";
    } catch (_error) {
      return "";
    }
  }

  function canonicalGroupUrl(rawUrl) {
    if (!rawUrl) return "";
    try {
      const url = new URL(rawUrl, "https://www.facebook.com");
      const match = url.pathname.match(/\/groups\/([^/]+)/i);
      return match ? `${url.origin}/groups/${match[1]}/` : "";
    } catch (_error) {
      return "";
    }
  }

  function isPostInGroup(postUrl, groupUrl) {
    const postGroup = canonicalGroupUrl(postUrl);
    const targetGroup = canonicalGroupUrl(groupUrl);
    return Boolean(postGroup && targetGroup && postGroup === targetGroup);
  }

  function isExactGroupLink(rawUrl, groupUrl) {
    if (!isPostInGroup(rawUrl, groupUrl)) return false;
    try {
      const url = new URL(rawUrl, "https://www.facebook.com");
      return /^\/groups\/[^/]+\/?$/i.test(url.pathname);
    } catch (_error) {
      return false;
    }
  }

  function getGroupContext(groupNameOverride = "") {
    const trustedGroupName = normalizeSpace(groupNameOverride);
    if (typeof document === "undefined") return { groupName: trustedGroupName, groupUrl: "" };
    const groupUrl = canonicalGroupUrl(typeof location !== "undefined" ? location.href : "");
    if (trustedGroupName) return { groupName: trustedGroupName, groupUrl };
    const groupLinkNames = [...document.querySelectorAll("a[href]")]
      .filter((link) => isExactGroupLink(link.href || link.getAttribute("href"), groupUrl))
      .map((link) => normalizeSpace(link.getAttribute("aria-label") || link.textContent))
      .filter((value) => value && !isLikelyUiGroupHeading(value) && !isLikelyMemberCount(value) && !isLikelyPostTitle(value));
    const headingNames = [...document.querySelectorAll("h1")]
      .map((node) => normalizeSpace(node.textContent))
      .filter((value) => value && !isLikelyUiGroupHeading(value) && !isLikelyMemberCount(value) && !isLikelyPostTitle(value));
    const candidates = [...groupLinkNames, ...headingNames];
    return { groupName: candidates[0] || "", groupUrl };
  }

  function checkpointStorageKey(groupUrl) {
    return `${CONFIG.checkpointStoragePrefix}${groupUrl || "unknown-group"}`;
  }

  function readCheckpoint(groupUrl) {
    if (!CONFIG.useCheckpoint) return null;

    // The project checkpoint manifest is injected by the runner before this
    // script is pasted. A present key (including null) is authoritative;
    // this prevents an old browser-local value from overriding the file.
    try {
      const external = typeof globalThis !== "undefined" ? globalThis.__FB_GROUP_CHECKPOINTS__ : null;
      if (external && Object.prototype.hasOwnProperty.call(external, groupUrl)) {
        const value = external[groupUrl];
        if (!value) return null;
        const checkpoint = new Date(value);
        return Number.isNaN(checkpoint.getTime()) ? null : checkpoint;
      }
    } catch (_error) {
      // Fall back to localStorage below.
    }

    if (typeof localStorage === "undefined") return null;
    try {
      const value = localStorage.getItem(checkpointStorageKey(groupUrl));
      if (!value) return null;
      const checkpoint = new Date(value);
      return Number.isNaN(checkpoint.getTime()) ? null : checkpoint;
    } catch (_error) {
      return null;
    }
  }

  function writeCheckpoint(groupUrl, checkpoint) {
    if (!CONFIG.useCheckpoint || typeof localStorage === "undefined") return false;
    try {
      localStorage.setItem(checkpointStorageKey(groupUrl), new Date(checkpoint).toISOString());
      return true;
    } catch (_error) {
      return false;
    }
  }

  function clearCheckpoint(groupUrl) {
    if (typeof localStorage === "undefined") return false;
    try {
      localStorage.removeItem(checkpointStorageKey(groupUrl));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function filterRecordsSince(rawRecords, cutoff) {
    const threshold = new Date(cutoff).getTime();
    if (Number.isNaN(threshold)) return rawRecords;
    return rawRecords.filter((record) => {
      const published = record.published_at
        ? new Date(record.published_at).getTime()
        : parseFacebookTime(record.published_at_text)?.getTime();
      if (!record.published_at && record.published_at_text && Number.isNaN(published)) return false;
      if (!published || Number.isNaN(published)) return !record.published_at_text;
      return published >= threshold;
    });
  }

  function normalizeProfileUrl(rawUrl) {
    if (!rawUrl) return "";
    try {
      const url = new URL(rawUrl, "https://www.facebook.com");
      const path = url.pathname;

      if (path === "/profile.php") {
        const id = url.searchParams.get("id");
        return id ? `https://www.facebook.com/profile.php?id=${id}` : "";
      }

      const groupUser = path.match(/\/groups\/[^/]+\/user\/([\w.-]+)/i);
      if (groupUser) return `https://www.facebook.com/${groupUser[1]}/`;

      const directUser = path.match(/^\/user\/([\w.-]+)/i);
      if (directUser) return `https://www.facebook.com/${directUser[1]}/`;

      const parts = path.split("/").filter(Boolean);
      const blocked = new Set([
        "groups", "pages", "watch", "marketplace", "messages", "notifications",
        "events", "photo", "reel", "share", "help", "settings",
      ]);
      if (parts.length === 1 && !blocked.has(parts[0].toLowerCase())) {
        return `https://www.facebook.com/${parts[0]}`;
      }
    } catch (_error) {
      return "";
    }
    return "";
  }

  function cleanSourceText(rawText, authorName, timeText) {
    const ignored = new Set([normalizeSpace(authorName), normalizeSpace(timeText)]);
    const lines = String(rawText || "")
      .split(/\r?\n/)
      .map(normalizeSpace)
      .filter(Boolean)
      .filter((line) => !ignored.has(line))
      .filter((line) => !UI_LINE_PATTERNS.some((pattern) => pattern.test(line)))
      .filter((line) => !/^\d+$/.test(line));

    const author = normalizeSpace(authorName);
    const time = normalizeSpace(timeText);
    let cleaned = normalizeSpace(lines.join(" "));
    cleaned = cleaned.replace(LEADING_AUTHOR_STATUS_PATTERN, "");
    if (author) {
      // DOM/CSV đôi khi nối tên tác giả ngay với nội dung, ví dụ
      // "Maria CarlssonI had ..."; không yêu cầu khoảng trắng ở đây.
      cleaned = cleaned.replace(new RegExp(`^${escapeRegExp(author)}`, "i"), "");
    }
    if (time) {
      cleaned = cleaned.replace(new RegExp(`\\s*${escapeRegExp(time)}`, "gi"), " ");
    }
    cleaned = cleaned
      .replace(/^(?:Chuyên gia trong nhóm|Group expert|nhiều nhất|phổ biến nhất|Most relevant|nổi bật|Featured|Highlighted|Người kiểm duyệt nổi bật|Top contributor)\s*(?:[·•]\s*(?:Theo dõi|Follow))?\s*/i, "")
      .replace(/^[·•]\s*(?:Theo dõi|Đang theo dõi|Follow(?:ing)?)\s*/i, "")
      .replace(LEADING_FOLLOW_PATTERN, "")
      .replace(INLINE_ACTION_PATTERN, " ")
      .replace(INLINE_CHROME_PATTERN, " ")
      .replace(/\b(?:Edited|Đã chỉnh sửa)\b/gi, "")
      .trim();
    for (const pattern of INLINE_UI_PATTERNS) cleaned = cleaned.replace(pattern, " ");
    cleaned = normalizeSpace(cleaned);

    cleaned = normalizeSpace(cleaned)
      .replace(/(?:See more|Xem thêm)(?:…|\.\.\.)?$/i, "")
      .replace(/(?:…|\.\.\.)\s*$/g, "")
      .replace(/\s+\d+\s*$/g, "")
      .trim();

    // Facebook thường nối các nút thao tác vào cuối text của bài/comment.
    // Chỉ xóa dạng viết hoa của nhãn UI để không làm mất câu tự nhiên như
    // "I would share" hoặc "I like this".
    return normalizeSpace(cleaned)
      .replace(/(?:\s+(?:Thích|Trả lời|Chia sẻ|Like|React|Reply|Share|Follow|Theo dõi)(?:\s+\d+)?)+\s*$/g, "")
      .replace(/(?:See more|Xem thêm)(?:…|\.\.\.)?$/i, "")
      .replace(/(?:…|\.\.\.)\s*$/g, "")
      .replace(/\s+\d+\s*$/g, "")
      .trim();
  }

  function sanitizeRecordText(record) {
    return cleanSourceText(
      record?.text ?? record?.text_excerpt ?? "",
      record?.name || "",
      record?.published_at_text || "",
    );
  }

  function parseFacebookTime(value, now = new Date()) {
    const text = normalizeSpace(value)
      .replace(/\u00a0/g, " ")
      .replace(/\s*[·•].*$/g, "")
      .trim()
      .toLowerCase();
    if (!text) return null;
    if (/^(just now|now|vừa xong)$/.test(text)) return new Date(now);

    const relative = text.match(/^(\d+)\s*(m|min|mins|h|hr|hrs|d|w|wk|wks|mo|mos|month|months|y|yr|yrs|year|years|phút|giờ|ngày|tuần|tháng|năm)$/i);
    if (relative) {
      const amount = Number(relative[1]);
      const unit = relative[2].toLowerCase();
      const minutesByUnit = {
        m: 1, min: 1, mins: 1, "phút": 1,
        h: 60, hr: 60, hrs: 60, "giờ": 60,
        d: 1440, "ngày": 1440,
        w: 10080, wk: 10080, wks: 10080, "tuần": 10080,
        mo: 43800, mos: 43800, month: 43800, months: 43800, "tháng": 43800,
        y: 525600, yr: 525600, yrs: 525600, year: 525600, years: 525600, "năm": 525600,
      };
      return new Date(now.getTime() - amount * minutesByUnit[unit] * 60_000);
    }

    const relativeDay = text.match(/^(today|yesterday|hôm nay|hôm qua)(?:\s+(?:at|lúc)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
    if (relativeDay) {
      const result = new Date(now);
      if (/yesterday|hôm qua/i.test(relativeDay[1])) result.setDate(result.getDate() - 1);
      if (relativeDay[2]) {
        let hour = Number(relativeDay[2]);
        const minute = Number(relativeDay[3] || 0);
        const meridiem = (relativeDay[4] || "").toLowerCase();
        if (meridiem === "pm" && hour < 12) hour += 12;
        if (meridiem === "am" && hour === 12) hour = 0;
        result.setHours(hour, minute, 0, 0);
      }
      return result;
    }

    const vietnamese = text.match(/^(\d{1,2})\s+tháng\s+(\d{1,2})(?:\s+năm\s+(\d{4}))?(?:\s+lúc\s+(\d{1,2})(?::(\d{2}))?)?$/i);
    if (vietnamese) {
      const result = new Date(now);
      result.setMonth(Number(vietnamese[2]) - 1, Number(vietnamese[1]));
      if (vietnamese[3]) result.setFullYear(Number(vietnamese[3]));
      if (vietnamese[4]) result.setHours(Number(vietnamese[4]), Number(vietnamese[5] || 0), 0, 0);
      else result.setHours(0, 0, 0, 0);
      if (!vietnamese[3] && result > now) result.setFullYear(result.getFullYear() - 1);
      return result;
    }

    const cleaned = text
      .replace(/\b(?:at|lúc)\b/gi, " ")
      .replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
    let parsed = new Date(cleaned);
    if (!Number.isNaN(parsed.getTime())) {
      if (!/\b\d{4}\b/.test(cleaned) && parsed > now) parsed.setFullYear(parsed.getFullYear() - 1);
      return parsed;
    }
    return null;
  }

  function countMatches(patterns, text) {
    return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
  }

  function detectProcedures(text) {
    return PROCEDURES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  }

  function extractDoctorOrClinic(text) {
    const matches = [];
    const stopWords = "in|at|of|the|is|was|gave|give|with|for|didn['’]?t|doesn['’]?t|don['’]?t|couldn['’]?t|seen|lots|good|she|he|they|that|said|before|pen|uses?|about|charges?|check|personally|works?|trained|world|renowned|bác|sĩ";
    const patterns = [
      /\b(?:dr\.?|doctor|surgeon|bác sĩ|bs\.?)\s+([A-ZÀ-Ỹ][\p{L}.'-]*(?:\s+[A-ZÀ-Ỹ][\p{L}.'-]*){0,2})/gu,
      new RegExp(`\\b(?:dr\\.?|doctor|bác sĩ|bs\\.?)\\s+((?!(?:${stopWords})\\b)[a-zà-ỹ][\\p{L}.'-]*(?:\\s+(?!(?:${stopWords})\\b)[a-zà-ỹ][\\p{L}.'-]*){0,1})`, "giu"),
      /\b([A-ZÀ-Ỹ][\p{L}&.'-]*(?:\s+[A-Za-zÀ-ỹ][\p{L}&.'-]*){0,3}\s+(?:Clinic|Hospital|Beauty|Aesthetic|Spa|Thẩm mỹ|Bệnh viện))\b/gu,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const value = normalizeSpace(match[0])
          .replace(/\s+(?:at|in|from|and|is|was|for|with|uses?|about|charges?|check|personally|works?|trained|world|renowned)\b.*$/i, "")
          .replace(/[.,;:]+$/, "")
          .trim();
        if (value && !/^(?:dr\.?|doctor|surgeon|bác sĩ|bs\.?)\s*(?:she|he|they|said|before|gave|bác sĩ|pen)?$/i.test(value)) {
          matches.push(value);
        }
      }
    }
    const unique = [];
    for (const value of matches) {
      if (!unique.some((existing) => existing.toLowerCase() === value.toLowerCase())) unique.push(value);
    }
    return unique.slice(0, 5).join(" | ");
  }

  function analyzeText(text, context = {}) {
    const clean = normalizeSpace(text);
    const procedures = detectProcedures(clean);
    const prospectSignals = countMatches(PROSPECT_PATTERNS, clean);
    const experienceSignals = countMatches(EXPERIENCE_PATTERNS, clean);
    const firstPersonSignals = countMatches(FIRST_PERSON_PATTERNS, clean);
    const personalDetailSignals = countMatches(PERSONAL_DETAIL_PATTERNS, clean);
    const seedingSignals = countMatches(SEEDING_PATTERNS, clean);
    const strongSeedingSignals = countMatches(STRONG_SEEDING_PATTERNS, clean);
    const doctorOrClinic = extractDoctorOrClinic(clean);
    const hasQuestion = /\?/.test(clean);

    let intentScore = 0;
    intentScore += Math.min(30, procedures.length * 15);
    intentScore += Math.min(35, prospectSignals * 18);
    intentScore += Math.min(35, experienceSignals * 18);
    intentScore += Math.min(15, firstPersonSignals * 8);
    intentScore += Math.min(15, personalDetailSignals * 7);
    if (doctorOrClinic) intentScore += 8;
    if (hasQuestion) intentScore += 5;
    if (clean.length >= 120) intentScore += 5;

    let authenticityScore = 20;
    authenticityScore += Math.min(25, firstPersonSignals * 12);
    authenticityScore += Math.min(25, personalDetailSignals * 10);
    authenticityScore += Math.min(15, Math.floor(clean.length / 100) * 5);
    if (procedures.length) authenticityScore += 10;
    if (hasQuestion) authenticityScore += 5;
    let seedingRisk = 0;
    seedingRisk += Math.min(75, seedingSignals * 25);
    seedingRisk += Math.min(90, strongSeedingSignals * 50);
    if (context.duplicateCount > 1) seedingRisk += Math.min(45, (context.duplicateCount - 1) * 20);
    if (context.authorActivityCount > 4) seedingRisk += Math.min(35, (context.authorActivityCount - 4) * 5);
    if (firstPersonSignals && personalDetailSignals) seedingRisk -= 12;
    if (experienceSignals && /\b(?:but|however|issue|problem|negative|unprofessional|nhưng|vấn đề|không hài lòng)\b/i.test(clean)) {
      seedingRisk -= 15;
    }

    intentScore = clamp(intentScore, 0, 100);
    authenticityScore = clamp(authenticityScore, 0, 100);
    seedingRisk = clamp(seedingRisk, 0, 100);

    let segment = "noise";
    if (seedingRisk >= 60) {
      segment = "seed_suspect";
    } else if (experienceSignals > 0 && (experienceSignals >= prospectSignals || /\breview\b/i.test(clean))) {
      segment = "experienced_customer";
    } else if (prospectSignals > 0 && intentScore >= CONFIG.minimumIntentScore) {
      segment = "potential_customer";
    }

    const reasons = [];
    if (procedures.length) reasons.push(`procedure:${procedures.join("|")}`);
    if (prospectSignals) reasons.push(`prospect_signals:${prospectSignals}`);
    if (experienceSignals) reasons.push(`experience_signals:${experienceSignals}`);
    if (firstPersonSignals) reasons.push("first_person");
    if (personalDetailSignals) reasons.push(`personal_details:${personalDetailSignals}`);
    if (doctorOrClinic) reasons.push("doctor_or_clinic");
    if (seedingSignals) reasons.push(`seeding_signals:${seedingSignals}`);
    if (strongSeedingSignals) reasons.push(`strong_seeding_signals:${strongSeedingSignals}`);
    if (context.duplicateCount > 1) reasons.push(`duplicate_text:${context.duplicateCount}`);
    if (context.authorActivityCount > 4) reasons.push(`high_activity:${context.authorActivityCount}`);
    if (context.isAnonymous) reasons.push("anonymous");

    return {
      segment,
      procedures: procedures.join(" | "),
      doctorOrClinic,
      intentScore,
      authenticityScore,
      seedingRisk,
      reasons: reasons.join("; "),
    };
  }

  function textFingerprint(text) {
    return normalizeSpace(text)
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\b\d+\b/g, "#")
      .slice(0, 260);
  }

  function canonicalContentUrl(rawUrl) {
    if (!rawUrl) return "";
    try {
      const base = typeof location !== "undefined" && location.origin
        ? location.origin
        : "https://www.facebook.com";
      const url = new URL(rawUrl, base);
      const postUrl = canonicalPostUrl(url.href);
      if (!postUrl) return "";
      const params = new URLSearchParams();
      for (const key of ["comment_id", "reply_comment_id"]) {
        if (url.searchParams.has(key)) params.set(key, url.searchParams.get(key));
      }
      return params.toString() ? `${postUrl}?${params.toString()}` : postUrl;
    } catch (_error) {
      return canonicalPostUrl(rawUrl);
    }
  }

  function getOwnArticleClone(article) {
    const clone = article.cloneNode(true);
    clone.querySelectorAll('div[role="article"]').forEach((nested) => nested.remove());
    return clone;
  }

  function inferAuthorFromText(rawText) {
    const original = normalizeSpace(String(rawText || ""));
    const directAlias = original.match(/^([A-Z][a-z]{2,24}[A-Z][a-z]{2,24}\d{3,4})\b/);
    if (directAlias) return { name: directAlias[1], isAnonymous: true };

    const raw = original.replace(/([a-z])([A-Z])/g, "$1 $2");
    const anonymous = raw.match(/^(?:Anonymous participant|Anonymous member|Người tham gia ẩn danh|Thành viên ẩn danh)(?:\s+\d+)?/i);
    if (anonymous) return { name: normalizeSpace(anonymous[0]), isAnonymous: true };

    const alias = raw.match(/^([A-Z][a-z]{2,24}[A-Z][a-z]{2,24}\d{3,4})\b/);
    if (alias) return { name: alias[1], isAnonymous: true };

    const normal = raw.match(/^([A-Z][A-Za-z.'-]+\s+[A-Z][A-Za-z.'-]+(?:\s+(?!(?:I|I['’]m|For|Can|Did|The|Best|Yeap|He|She|My|It|When|Well|Yes|No|Oh|If|Please|You|Don['’]t|Doesn['’]t|Đang|Mình|Tôi|Người|Tác giả)\b)[A-Z][A-Za-z.'-]+)?)(?=\s+(?:I|I['’]m|For|Can|Did|The|Best|Yeap|He|She|My|It|When|Well|Yes|No|Oh|If|Please|You|Don['’]t|Doesn['’]t|Đang|Mình|Tôi|Người|Tác giả)\b|[A-Z][a-z])/u);
    return normal ? { name: normalizeSpace(normal[1]), isAnonymous: false } : { name: "", isAnonymous: false };
  }

  function findAuthor(article) {
    const own = getOwnArticleClone(article);
    const links = [...own.querySelectorAll('a[href][role="link"], a[href]')];
    for (const link of links) {
      const profileUrl = normalizeProfileUrl(link.getAttribute("href"));
      const name = cleanAuthorLabel(link.textContent || link.getAttribute("aria-label"));
      if (profileUrl && name && name.length >= 2 && name.length <= 100) {
        const isAnonymous = isLikelyAnonymousAlias(name);
        return { name, profileUrl: isAnonymous ? "" : profileUrl, isAnonymous };
      }
    }

    const raw = cleanAuthorLabel(normalizeSpace(own.innerText));
    const inferred = inferAuthorFromText(raw);
    const firstLine = raw.split(/\r?\n/).map(cleanAuthorLabel).find(Boolean) || "";
    const name = cleanAuthorLabel(inferred.name || firstLine);
    const isAnonymous = inferred.isAnonymous || isLikelyAnonymousAlias(name);
    return {
      name: isAnonymous || inferred.name ? name : "",
      profileUrl: "",
      isAnonymous,
    };
  }

  function findContentLink(article, postUrl, isRootArticle = false) {
    const own = getOwnArticleClone(article);
    const candidates = [...own.querySelectorAll('a[href*="/posts/"], a[href*="comment_id"], a[href*="reply_comment_id"], a[href*="permalink.php"], a[href*="story_fbid"]')]
      .filter((link) => canonicalPostUrl(link.href) === postUrl);
    const postLink = candidates.find((link) => !/(?:comment_id|reply_comment_id)=/i.test(link.href));
    const commentLink = candidates.find((link) => /(?:comment_id|reply_comment_id)=/i.test(link.href));

    // A root article can contain permalink links belonging to its comments.
    // Its own content URL must always remain the post permalink.
    if (isRootArticle && postLink) {
      return { url: canonicalContentUrl(postLink.href) || postUrl, sourceType: "post" };
    }

    const link = commentLink || postLink || candidates[0];
    if (!link) return { url: postUrl, sourceType: "post" };
    const url = canonicalContentUrl(link.href) || postUrl;
    const sourceType = /reply_comment_id=/i.test(link.href)
      ? "reply"
      : /comment_id=/i.test(link.href)
        ? "comment"
        : "post";
    return { url, sourceType };
  }

  function findTimeText(article, postUrl) {
    const own = getOwnArticleClone(article);
    const candidates = [...own.querySelectorAll('a[href*="/posts/"], a[href*="comment_id"], a[href*="reply_comment_id"], a[href*="permalink.php"], a[href*="story_fbid"]')]
      .filter((link) => canonicalPostUrl(link.href) === postUrl)
      .flatMap((link) => [
        link.getAttribute("aria-label"),
        link.getAttribute("title"),
        link.getAttribute("data-tooltip-content"),
        link.textContent,
      ].map(normalizeSpace))
      .filter(Boolean);
    const timeText = candidates.find((value) => {
      TIME_TEXT_PATTERN.lastIndex = 0;
      return TIME_TEXT_PATTERN.test(value) || Boolean(parseFacebookTime(value));
    });
    if (timeText) return timeText;

    const raw = normalizeSpace(own.innerText);
    const matches = raw.match(/(?:just now|now|vừa xong|\d+\s*(?:m|min|mins|h|hr|hrs|d|w|wk|wks|mo|mos|month|months|y|yr|yrs|year|years|phút|giờ|ngày|tuần|tháng|năm))/gi);
    return matches?.at(-1) || "";
  }

  function getOwnArticleText(article) {
    const clone = getOwnArticleClone(article);
    return clone.innerText || clone.textContent || "";
  }

  function getArticleDepth(article, postArticle) {
    if (article === postArticle) return 0;
    let depth = 0;
    let parentArticle = article.parentElement?.closest('div[role="article"]');
    while (parentArticle) {
      depth += 1;
      if (parentArticle === postArticle) break;
      parentArticle = parentArticle.parentElement?.closest('div[role="article"]');
    }
    return depth;
  }

  function getTopLevelArticles() {
    return [...document.querySelectorAll('div[role="article"]')]
      .filter((article) => !article.parentElement?.closest('div[role="article"]'));
  }

  function inferSourceType(isRootArticle, contentLinkType, articleDepth) {
    if (isRootArticle) return "post";
    if (contentLinkType && contentLinkType !== "post") return contentLinkType;
    return articleDepth >= 2 ? "reply" : "comment";
  }

  function hasExplicitCommentEvidence(record) {
    const sourceType = normalizeSpace(record?.source_type).toLowerCase();
    if (sourceType === "comment" || sourceType === "reply") return true;
    const postUrl = canonicalPostUrl(record?.post_url || "");
    const contentUrl = canonicalContentUrl(record?.comment_url || record?.content_url || "");
    if (/(?:comment_id|reply_comment_id)=/i.test(`${record?.comment_url || ""} ${record?.content_url || ""}`)) {
      return true;
    }
    return Boolean(postUrl && contentUrl && contentUrl !== postUrl);
  }

  function recordClassificationIdentity(record) {
    const author = normalizeSpace(record?.profile_url)
      || `name:${normalizeSpace(record?.name).toLowerCase() || "unknown"}`;
    return `${author}::${textFingerprint(record?.text || "")}`;
  }

  function inferDuplicatePostComments(records) {
    const byPost = new Map();
    for (const record of records) {
      const postUrl = canonicalPostUrl(record?.post_url || record?.content_url || "");
      if (!postUrl) continue;
      if (!byPost.has(postUrl)) byPost.set(postUrl, []);
      byPost.get(postUrl).push(record);
    }

    for (const group of byPost.values()) {
      let rootSeen = false;
      const seenIdentities = new Set();
      for (const record of group) {
        const identity = recordClassificationIdentity(record);
        const explicit = hasExplicitCommentEvidence(record);
        const sourceType = normalizeSpace(record?.source_type).toLowerCase();
        if (!explicit && sourceType === "post") {
          if (!rootSeen) {
            rootSeen = true;
          } else if (!seenIdentities.has(identity)) {
            record.source_type = "comment";
            record.comment_url = record.comment_url || canonicalPostUrl(record.post_url);
            const flags = String(record.data_quality_flags || "")
              .split(/[;|]/)
              .map((flag) => flag.trim())
              .filter(Boolean);
            for (const flag of ["source_type_inferred", "comment_permalink_missing"]) {
              if (!flags.includes(flag)) flags.push(flag);
            }
            record.data_quality_flags = flags.join("; ");
          }
        }
        seenIdentities.add(identity);
      }
    }
    return records;
  }

  function collectRenderedRecords() {
    const records = [];
    const currentGroupUrl = canonicalGroupUrl(typeof location !== "undefined" ? location.href : "");
    for (const rootArticle of getTopLevelArticles()) {
      const rootLinks = [...rootArticle.querySelectorAll('a[href*="/posts/"], a[href*="comment_id"], a[href*="reply_comment_id"], a[href*="permalink.php"], a[href*="story_fbid"]')];
      const postLink = rootLinks.find((link) => canonicalPostUrl(link.href) && !/(?:comment_id|reply_comment_id)=/i.test(link.href));
      const fallbackLink = rootLinks.find((link) => canonicalPostUrl(link.href));
      const postUrl = canonicalPostUrl((postLink || fallbackLink)?.href);
      if (!postUrl || !isPostInGroup(postUrl, currentGroupUrl)) continue;

      const articles = [rootArticle, ...rootArticle.querySelectorAll('div[role="article"]')];
      const uniqueArticles = [...new Set(articles)];
      for (const article of uniqueArticles) {
        const articleDepth = getArticleDepth(article, rootArticle);
        // Top-level Facebook articles are posts. A post article often contains
        // comment permalinks in its subtree, so basing this only on the first
        // link incorrectly turned every post into a comment.
        const isPost = article === rootArticle;
        const contentLink = findContentLink(article, postUrl, isPost);
        const author = findAuthor(article);
        const timeText = findTimeText(article, postUrl);
        const rawText = getOwnArticleText(article);
        const text = cleanSourceText(rawText, author.name, timeText);
        if (!text || text.length < 12) continue;

        const sourceType = inferSourceType(isPost, contentLink.sourceType, articleDepth);
        const contentUrl = sourceType === "post" ? postUrl : contentLink.url || postUrl;
        const parsedTime = parseFacebookTime(timeText);
        const qualityFlags = [];
        if (!author.name) qualityFlags.push("author_missing");
        if (author.isAnonymous) qualityFlags.push("anonymous_author");
        if (!timeText) qualityFlags.push("time_missing");
        if (hasFacebookChrome(rawText)) qualityFlags.push("ui_chrome_removed");
        if (/…\s*(?:Xem thêm|See more)/i.test(rawText)) qualityFlags.push("text_truncated");
        if (sourceType !== "post" && contentUrl === postUrl) qualityFlags.push("comment_permalink_missing");
        const key = [contentUrl, sourceType, author.profileUrl || author.name, textFingerprint(text)].join("::");
        records.push({
          key,
          name: author.name,
          profile_url: author.profileUrl,
          is_anonymous: author.isAnonymous,
          source_type: sourceType,
          post_url: postUrl,
          comment_url: sourceType === "post" ? "" : contentUrl,
          published_at_text: parsedTime?.toISOString() || timeText,
          published_at: parsedTime?.toISOString() || "",
          data_quality_flags: qualityFlags.join("; "),
          text,
        });
      }
    }
    return records;
  }

  function classifyRecords(rawRecords, groupContext = {}) {
    const candidateRecords = inferDuplicatePostComments(rawRecords.filter((record) =>
      record && normalizeSpace(record.text)
    ).map((record) => ({
      ...record,
      text: sanitizeRecordText(record),
    })).filter((record) => normalizeSpace(record.text)));
    const byAuthor = new Map();
    const byFingerprint = new Map();
    for (const record of candidateRecords) {
      const isAnonymous = Boolean(record.is_anonymous || isLikelyAnonymousAlias(record.name));
      const authorKey = !isAnonymous && record.profile_url
        ? record.profile_url
        : `anon:${normalizeSpace(record.name) || "unknown"}`;
      const fingerprint = textFingerprint(record.text);
      byAuthor.set(authorKey, (byAuthor.get(authorKey) || 0) + 1);
      byFingerprint.set(fingerprint, (byFingerprint.get(fingerprint) || 0) + 1);
    }

    return candidateRecords.map((record) => {
      const isAnonymous = Boolean(record.is_anonymous || isLikelyAnonymousAlias(record.name));
      const authorKey = !isAnonymous && record.profile_url
        ? record.profile_url
        : `anon:${normalizeSpace(record.name) || "unknown"}`;
      const fingerprint = textFingerprint(record.text);
      const analysis = analyzeText(record.text, {
        isAnonymous,
        authorActivityCount: byAuthor.get(authorKey) || 1,
        duplicateCount: byFingerprint.get(fingerprint) || 1,
      });
      const contentAssessment = analysis.segment === "experienced_customer"
        ? "review"
        : analysis.segment === "potential_customer"
          ? "service_question"
          : analysis.segment;
      return {
        group_name: groupContext.groupName || "",
        group_url: groupContext.groupUrl || "",
        content_url: record.source_type === "post"
          ? (record.post_url || "")
          : (record.comment_url || record.post_url || ""),
        content_assessment: contentAssessment,
        published_at: record.published_at,
        procedure: analysis.procedures,
        doctor_name: analysis.doctorOrClinic,
        name: record.name,
        profile_url: isAnonymous ? "" : (record.profile_url || ""),
        segment: analysis.segment,
        source_type: record.source_type,
        post_url: record.post_url,
        comment_url: record.comment_url,
        published_at_text: record.published_at || record.published_at_text,
        doctor_or_clinic: analysis.doctorOrClinic,
        intent_score: analysis.intentScore,
        authenticity_score: analysis.authenticityScore,
        seeding_risk: analysis.seedingRisk,
        classification_reasons: analysis.reasons,
        text_excerpt: record.text.slice(0, 500),
        review_status: analysis.segment === "seed_suspect"
          ? "excluded_seed_suspect"
          : analysis.segment === "noise"
            ? "excluded_noise"
            : "pending_human_review",
        is_anonymous: isAnonymous ? "yes" : "no",
        data_quality_flags: record.data_quality_flags || "",
      };
    });
  }

  function csvEscape(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
  }

  function buildCsv(rows) {
    const headers = CSV_HEADERS;
    return "\uFEFF" + [
      headers.map(csvEscape).join(","),
      ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
    ].join("\n");
  }

  function makeScanFilename(days, runStamp) {
    return `fb_group_scan_${days}d_${runStamp}.csv`;
  }

  function makeManifestFilename(scanFilename) {
    return String(scanFilename || "").replace(/\.csv$/i, ".manifest.json");
  }

  function buildRunManifest({
    groupUrl,
    groupName,
    runId,
    startedAt,
    completedAt,
    rowCount,
    status,
    outputFile,
  }) {
    return {
      group_url: groupUrl || "",
      group_name: groupName || "",
      run_id: runId,
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date(completedAt).toISOString(),
      row_count: Number(rowCount),
      status,
      output_file: outputFile,
    };
  }

  function manifestStatusForRun(runStatus, rowCount) {
    if (Number(rowCount) === 0) return "zero_result";
    return runStatus === "completed_with_rows" ? "completed" : "stopped";
  }

  function downloadCsv(rows, filename) {
    // Luôn tải cả file rỗng chỉ có header. Như vậy group không có dòng mới
    // vẫn có bằng chứng output và không bị nhầm với group chưa chạy.
    const csv = buildCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1_000);
  }

  function downloadJson(value, filename) {
    const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
      type: "application/json;charset=utf-8",
    });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1_000);
  }

  function createHud(state) {
    document.getElementById("fb-lead-pilot-hud")?.remove();
    const hud = document.createElement("aside");
    hud.id = "fb-lead-pilot-hud";
    hud.style.cssText = [
      "position:fixed", "right:20px", "bottom:20px", "z-index:2147483647",
      "width:340px", "padding:16px", "border-radius:14px",
      "background:#111827", "color:#f9fafb", "box-shadow:0 14px 42px rgba(0,0,0,.38)",
      "font:13px/1.45 Segoe UI,Arial,sans-serif", "border:1px solid #374151",
    ].join(";");
    hud.innerHTML = `
      <div style="font-size:15px;font-weight:700;margin-bottom:8px">FB Lead Pilot · quét tăng dần</div>
      <div id="fb-lead-pilot-status" style="color:#cbd5e1;margin-bottom:10px">Đang khởi tạo…</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px">
        <div>Đã đọc: <b id="fb-lead-pilot-total">0</b></div>
        <div>Lead: <b id="fb-lead-pilot-leads" style="color:#34d399">0</b></div>
        <div>Seeding: <b id="fb-lead-pilot-seeds" style="color:#fbbf24">0</b></div>
        <div>Nhiễu: <b id="fb-lead-pilot-noise">0</b></div>
      </div>
      <button id="fb-lead-pilot-stop" style="width:100%;border:0;border-radius:8px;padding:9px;background:#dc2626;color:white;font-weight:700;cursor:pointer">Dừng & xuất CSV</button>
    `;
    document.body.appendChild(hud);
    hud.querySelector("#fb-lead-pilot-stop").addEventListener("click", () => {
      state.stopped = true;
      hud.querySelector("#fb-lead-pilot-stop").disabled = true;
    });
    return {
      update(message, classified) {
        const counts = classified.reduce((acc, row) => {
          acc[row.segment] = (acc[row.segment] || 0) + 1;
          return acc;
        }, {});
        hud.querySelector("#fb-lead-pilot-status").textContent = message;
        hud.querySelector("#fb-lead-pilot-total").textContent = classified.length;
        hud.querySelector("#fb-lead-pilot-leads").textContent = (counts.potential_customer || 0) + (counts.experienced_customer || 0);
        hud.querySelector("#fb-lead-pilot-seeds").textContent = counts.seed_suspect || 0;
        hud.querySelector("#fb-lead-pilot-noise").textContent = counts.noise || 0;
      },
      finish(message) {
        hud.querySelector("#fb-lead-pilot-status").textContent = message;
      },
    };
  }

  async function expandVisibleDiscussion() {
    const labels = [
      /view more comments/i, /view \d+ (?:more )?comments?/i,
      /view \d+ replies?/i, /view \d+ more replies?/i,
      /xem thêm bình luận/i, /xem \d+ câu trả lời/i,
      /^see more$/i, /^xem thêm$/i,
    ];
    const buttons = [...new Set([
      ...document.querySelectorAll('div[role="article"] button'),
      ...document.querySelectorAll('div[role="article"] [role="button"]'),
      ...document.querySelectorAll('div[role="article"] [role="link"]'),
    ])]
      .filter((button) => {
        const label = normalizeSpace(button.innerText || button.getAttribute("aria-label"));
        return labels.some((pattern) => pattern.test(label));
      })
      .slice(0, CONFIG.maxExpandClicksPerRound);

    for (const button of buttons) {
      try {
        button.click();
        await sleep(180);
      } catch (_error) {
        // Facebook thường thay DOM ngay sau click; bỏ qua nút đã stale.
      }
    }
    return buttons.length;
  }

  async function run(options = {}) {
    if (typeof document === "undefined") throw new Error("Chỉ chạy script này trên trang Facebook trong trình duyệt.");
    Object.assign(CONFIG, options);
    if (!/facebook\.com\/groups\//i.test(location.href)) {
      alert("Hãy mở tab Discussion của Facebook Group trước khi chạy FB Lead Pilot.");
      return;
    }

    const runStamp = Date.now();
    const scanFilename = options.scanFilename || makeScanFilename(CONFIG.days, runStamp);
    const runId = options.runId || `scan_${CONFIG.days}d_${runStamp}`;
    const manifestFilename = makeManifestFilename(scanFilename);

    const state = { stopped: false, stopReason: "" };
    const hud = createHud(state);
    const records = new Map();
    const groupContext = getGroupContext(options.groupName);
    const groupUrl = groupContext.groupUrl || canonicalGroupUrl(location.href);
    const scanStartedAt = new Date();
    const previousCheckpoint = readCheckpoint(groupUrl);
    const cutoff = previousCheckpoint || new Date(scanStartedAt.getTime() - CONFIG.days * 86_400_000);
    let lastHeight = 0;
    let idleRounds = 0;
    let oldPostRounds = 0;
    let round = 0;

    globalThis.STOP_FB_LEAD_PILOT = () => {
      state.stopped = true;
      state.stopReason = "manual";
    };

    while (!state.stopped
      && idleRounds < CONFIG.maxIdleRounds
      && oldPostRounds < CONFIG.maxOldPostRounds
      && (!CONFIG.maxRounds || round < CONFIG.maxRounds)
      && (!CONFIG.maxRuntimeMs || Date.now() - scanStartedAt.getTime() < CONFIG.maxRuntimeMs)) {
      round += 1;
      await expandVisibleDiscussion();
      for (const record of collectRenderedRecords()) records.set(record.key, record);

      const allRecords = [...records.values()];
      const classified = classifyRecords(filterRecordsSince(allRecords, cutoff), groupContext);
      // Dùng toàn bộ dữ liệu đã thấy để biết lúc nào đã cuộn qua mốc checkpoint.
      // Nếu chỉ nhìn dữ liệu sau cutoff thì điều kiện này không bao giờ đúng.
      const recordDates = allRecords
        .map((record) => record.published_at
          ? new Date(record.published_at)
          : parseFacebookTime(record.published_at_text))
        .filter((date) => date && !Number.isNaN(date.getTime()));
      const oldest = recordDates.length ? new Date(Math.min(...recordDates.map(Number))) : null;
      oldPostRounds = oldest && oldest < cutoff ? oldPostRounds + 1 : 0;
      hud.update(`Vòng ${round} · bài cũ nhất: ${oldest ? oldest.toLocaleDateString() : "chưa xác định"}`, classified);

      const before = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      window.scrollTo({ top: before, behavior: "smooth" });
      await sleep(CONFIG.scrollIntervalMs);
      const after = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      idleRounds = after <= lastHeight ? idleRounds + 1 : 0;
      lastHeight = after;
    }

    const reachedHardLimit = !state.stopped && (
      (CONFIG.maxRounds > 0 && round >= CONFIG.maxRounds)
      || (CONFIG.maxRuntimeMs > 0 && Date.now() - scanStartedAt.getTime() >= CONFIG.maxRuntimeMs)
    );
    if (reachedHardLimit) {
      state.stopped = true;
      state.stopReason = "hard_limit";
    }

    for (const record of collectRenderedRecords()) records.set(record.key, record);
    const classified = classifyRecords(filterRecordsSince([...records.values()], cutoff), groupContext);
    const leads = classified.filter((row) =>
      ["potential_customer", "experienced_customer"].includes(row.segment) &&
      row.intent_score >= CONFIG.minimumIntentScore &&
      row.seeding_risk <= CONFIG.maximumSeedingRisk
    );
    const audit = classified.filter((row) => !leads.includes(row));

    // Collector chỉ xuất một file raw/all. Việc chia leads/audit là trách
    // nhiệm của bước merge/QA downstream để tránh phải gộp lại ngay sau đó.
    downloadCsv(classified, scanFilename);
    const completedNaturally = !state.stopped;
    // Không tiến checkpoint nếu trang không trả về bản ghi nào (ví dụ bị
    // login wall, DOM chưa tải hoặc Facebook thay đổi giao diện), để lần sau
    // vẫn quét lại khoảng thời gian chưa chắc đã đọc được.
    const checkpointSaved = completedNaturally && records.size > 0 && writeCheckpoint(groupUrl, scanStartedAt);
    const runStatus = state.stopped
      ? "stopped"
      : records.size === 0
        ? "no_records_seen"
        : classified.length === 0
          ? "zero_result_after_checkpoint"
          : "completed_with_rows";
    hud.update("Đã hoàn tất phân loại.", classified);
    const checkpointMessage = checkpointSaved
      ? " Đã lưu checkpoint."
      : state.stopped
        ? ` Chưa cập nhật checkpoint vì đã dừng (${state.stopReason || "stopped"}).`
        : records.size === 0
          ? " Chưa cập nhật checkpoint vì chưa đọc được bản ghi."
          : " Không có dòng sau khi lọc theo checkpoint.";
    const completedAt = new Date();
    const manifestStatus = manifestStatusForRun(runStatus, classified.length);
    const runManifest = buildRunManifest({
      groupUrl,
      groupName: groupContext.groupName,
      runId,
      startedAt: scanStartedAt,
      completedAt,
      rowCount: classified.length,
      status: manifestStatus,
      outputFile: scanFilename,
    });
    hud.finish(`Đã xuất file scan raw với ${classified.length} dòng (${leads.length} lead nội bộ, ${audit.length} audit nội bộ).${checkpointMessage}`);

    const result = {
      leads,
      audit,
      all: classified,
      cutoff,
      scanStartedAt,
      completedAt,
      checkpoint: checkpointSaved ? scanStartedAt : previousCheckpoint,
      runStatus,
      runId,
      manifest: runManifest,
    };

    downloadJson(runManifest, manifestFilename);

    if (typeof globalThis !== "undefined") {
      globalThis.__FB_GROUP_LEAD_PILOT_LAST_RUN__ = {
        group_name: groupContext.groupName || "",
        group_url: groupUrl,
        scan_started_at: scanStartedAt.toISOString(),
        previous_checkpoint: previousCheckpoint ? previousCheckpoint.toISOString() : null,
        checkpoint: result.checkpoint ? new Date(result.checkpoint).toISOString() : null,
        checkpoint_saved: checkpointSaved,
        run_status: runStatus,
        run_id: runId,
        records_seen: records.size,
        classified_count: classified.length,
        leads_count: leads.length,
        audit_count: audit.length,
        scan_filename: scanFilename,
        manifest_filename: manifestFilename,
      };
    }

    return result;
  }

  return {
    CONFIG,
    CSV_HEADERS,
    analyzeText,
    buildCsv,
    canonicalContentUrl,
    canonicalPostUrl,
    canonicalGroupUrl,
    classifyRecords,
    clearCheckpoint,
    cleanSourceText,
    sanitizeRecordText,
    cleanAuthorLabel,
    detectProcedures,
    isLikelyAnonymousAlias,
    getGroupContext,
    filterRecordsSince,
    inferAuthorFromText,
    inferSourceType,
    isLikelyUiGroupHeading,
    isLikelyMemberCount,
    isLikelyPostTitle,
    isPostInGroup,
    isExactGroupLink,
    buildRunManifest,
    manifestStatusForRun,
    makeScanFilename,
    makeManifestFilename,
    readCheckpoint,
    writeCheckpoint,
    normalizeProfileUrl,
    parseFacebookTime,
    textFingerprint,
    run,
  };
});
