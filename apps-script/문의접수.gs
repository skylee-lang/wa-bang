/**
 * 와방 · 손님 문의 자동 접수 서버 (구글 Apps Script)
 *
 * 손님이 매물 사이트에서 '오픈카톡으로 보내기'를 누르면 (손님 전화번호는 받지 않음)
 *   1) 손님 화면이 만든 문의번호(예: K7M3A)로 시트 '문의접수' 탭에 기록
 *      → 손님이 오픈카톡에 붙여넣는 글 첫 줄에도 같은 번호가 있어서, 오픈카톡 대화와 시트·상세 페이지가 연결됨
 *   2) 시트의 '상세페이지' 링크 → 중개사 전용 문의 상세 페이지
 *      (매물 사진·조건 비교·비공개 정보·오픈카톡 답장 문구·처리상태 변경·메모)
 *
 * ───────── 설치 순서 ─────────
 * [1] 매물 구글 시트 → 확장 프로그램 → Apps Script → 이 코드 전체 붙여넣기 → 저장
 *     (script.google.com 에서 따로 만든 프로젝트라면 아래 SHEET_ID 를 꼭 채우기)
 * [2] 위쪽 함수 선택 칸에서 '설치하기' → 실행 → 권한 허용
 *     (내 계정 선택 → 고급 → 안전하지 않음으로 이동 → 허용)
 * [3] 배포 → 새 배포 → 유형: 웹 앱 / 실행 사용자: 나 / 액세스 권한: 모든 사용자 → 배포
 * [4] '웹 앱 URL'(…/exec)을 매물 사이트 index.html 의 CONFIG.INQUIRY_URL 에 붙여넣기
 *     → 여기까지 하면 문의 접수 + 시트 기록 + 상세 페이지(시트의 '상세페이지' 링크)가 작동
 *
 * ※ 시트의 '관리용' 탭(직접 만드세요)에 [매물번호, 상세주소, 임대인 연락처, 비밀번호 …] 처럼 적어두면
 *   중개사 상세 페이지에만 표시됩니다. (손님에게 공개되는 매물 탭에는 절대 적지 마세요)
 * ※ 코드를 고친 뒤에는 '배포 관리 → 수정 → 새 버전 → 배포' 해야 반영됩니다. (주소 유지)
 */

const SHEET_ID            = "";              // 매물 시트 주소의 /d/ 와 /edit 사이 값 (매물등록.gs 의 SHEET_ID 와 같은 값)
const SITE_URL            = "https://skylee-lang.github.io/wa-bang/";
const ADMIN_PAGE_URL      = SITE_URL + "admin/";
const LISTING_SHEET_GID   = 2138382865;    // 손님에게 공개되는 매물 탭 '설문지응답' (CSV 주소의 gid= 값)
const PRIVATE_SHEET_NAME  = "관리용";      // 중개사만 보는 정보 탭
const INQUIRY_SHEET_GID   = 76524047;      // 문의가 기록되는 탭 '문의 응답' (주소의 gid= 값)
const SHEET_NAME          = "문의접수";       // 위 탭을 못 찾을 때만 이 이름으로 새로 만듦
const LIMIT_10MIN         = 30;            // 10분에 이보다 많이 들어오면 잠시 접수 중단 (장난·스팸 방지)
const LIMIT_DAY           = 200;           // 하루 최대 접수 건수
const STATUSES            = ["신규", "연락함", "투어예약", "계약", "보류", "종료"];
const HEAD = ["문의번호", "접수시간", "접수경로", "오픈카톡 확인", "입주 시기", "매물번호", "고른 매물", "방 볼 수 있는 날", "희망 조건", "처리상태", "상세페이지", "메모", "열쇠", "데이터"];
const C = Object.fromEntries(HEAD.map((h, i) => [h, i + 1]));   // 열 번호

const PROPS = PropertiesService.getScriptProperties();

/* ===================== 손님 문의 접수 ===================== */
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const d = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const items = (d.items || []).slice(0, 10), c = d.chat || {};
    const clean = v => String(v == null ? "" : v).replace(/^[=+\-@]/, "'$&").slice(0, 2000);
    const message = String(d.message || "").slice(0, 4000);
    if (!items.length && !Object.keys(c).length) return json_({ ok: false, error: "빈 문의" });

    // 문의번호: 손님 화면이 만든 5글자 (오픈카톡 글과 같은 번호). 형식이 이상하면 새로 만듦
    let code = String(d.code || "").toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) code = newCode_();

    const sh = getSheet_();
    // 같은 번호·같은 내용이 이미 있으면 (손님이 여러 번 누름) 다시 기록하지 않음
    const last = sh.getLastRow(), from = Math.max(2, last - 299);
    if (last >= 2) {
      const rows = sh.getRange(from, 1, last - from + 1, HEAD.length).getValues();
      const same = rows.filter(r => String(r[C["문의번호"] - 1]).replace(/-\d+$/, "") === code);
      if (same.some(r => safeJson_(r[C["데이터"] - 1]).message === message)) return json_({ ok: true, id: code, duplicate: true });
      if (same.length) code = code + "-" + (same.length + 1);   // 아주 드물게 번호가 겹치면 -2 붙임
    }

    // 장난·스팸 방지: 10분·하루 접수 상한
    const cache = CacheService.getScriptCache();
    const k10 = "n10_" + Math.floor(Date.now() / 600000), today = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyyMMdd");
    const dc = String(PROPS.getProperty("DAY_COUNT") || "").split(":");
    const n10 = Number(cache.get(k10) || 0) + 1, nDay = (dc[0] === today ? Number(dc[1] || 0) : 0) + 1;
    if (n10 > LIMIT_10MIN || nDay > LIMIT_DAY) return json_({ ok: false, error: "잠시 후 다시 시도해 주세요." });
    cache.put(k10, String(n10), 700);
    PROPS.setProperty("DAY_COUNT", today + ":" + nDay);

    const key = Utilities.getUuid().replace(/-/g, "").slice(0, 20);
    const link = adminLink_(code, key);
    sh.appendRow([
      code, new Date(), clean(d.via || "오픈카톡"), false,
      (isUrgent_(c) ? "🔥 " : "") + clean(c.moveInDate),
      items.map(x => x.id).join(", "),
      items.map(x => `#${x.id} ${x.short || x.area}`).join("\n"),
      clean(c.viewingDate), clean(condText_(c)),
      "신규", linkCell_(link), "", key,
      JSON.stringify({ via: d.via || "", items, chat: c, message })
    ]);
    const row = sh.getLastRow();
    sh.getRange(row, C["상세페이지"]).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);   // 옆 '메모' 칸을 가리지 않게
    sh.getRange(row, C["오픈카톡 확인"]).insertCheckboxes();
    PROPS.setProperty("LAST_ID", String(Number(PROPS.getProperty("LAST_ID") || 0) + 1));   // 누적 건수

    return json_({ ok: true, id: code });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
function newCode_() {
  const ch = "ACDEFHJKMNPRTUVWXY34679";
  let c = ""; for (let i = 0; i < 5; i++) c += ch[Math.floor(Math.random() * ch.length)];
  return c;
}

/* 입주가 한 달 안이면 '급함' → 시트·상세 페이지에 🔥 표시 (먼저 연락할 손님) */
function isUrgent_(c) { return /즉시|1개월|이번\s*달|급/.test(String((c || {}).moveInDate || "")); }
function condText_(c) {
  return [c.structure,
    c.deposit && "보증금 " + c.deposit,
    c.monthlyRent && (/전세|매매/.test(c.monthlyRent) ? c.monthlyRent : "월세 " + c.monthlyRent),
    c.parking && !/불필요/.test(c.parking) ? ("주차 " + c.parking.replace(/필요\s*/, "")).trim() : "",
    c.pet && !/없/.test(c.pet) ? "🐾" + c.pet : "",
    c.location
  ].filter(Boolean).join(" · ");
}
/* 시트에는 긴 주소 대신 '📄 상세 보기' 글자만 보이게 (눌러서 여는 건 그대로) */
function linkCell_(url) {
  return '=HYPERLINK("' + String(url).replace(/"/g, '""') + '","📄 상세 보기")';
}
/* 한 번만 실행: 이미 접수된 문의의 긴 주소도 '📄 상세 보기'로 바꾸고 칸 폭을 줄임 */
function 상세링크_짧게() {
  const sh = getSheet_(), last = sh.getLastRow(), col = C["상세페이지"];
  if (last >= 2) {
    const rng = sh.getRange(2, col, last - 1, 1);
    const vals = rng.getValues(), forms = rng.getFormulas();
    let n = 0;
    vals.forEach((v, i) => {
      const u = String(v[0] || "");
      if (!forms[i][0] && /^https?:\/\//.test(u)) { sh.getRange(i + 2, col).setFormula(linkCell_(u)); n++; }
    });
    Logger.log("✅ 상세페이지 링크 " + n + "개를 '📄 상세 보기'로 바꿨어요");
  }
  sh.setColumnWidth(col, 110);
  sh.getRange(1, col, sh.getMaxRows(), 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);   // 넘치는 글자가 '메모' 칸을 덮지 않게
}
function adminLink_(id, key) {
  return ADMIN_PAGE_URL + "?id=" + id + "&k=" + key;   // 서버 주소는 admin/index.html 의 CONFIG.API_URL 에 들어 있어서 링크가 짧음
}

/* ===================== 웹 주소로 들어오는 요청 ===================== */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.api === "inquiry") return json_(apiInquiry_(p));
  if (p.api === "update") return json_(apiUpdate_(p));

  return html_("와방 문의 접수 서버 작동 중",
    "접수된 문의(누적): " + (PROPS.getProperty("LAST_ID") || 0) + "건");
}

/* 문의 상세 (중개사 페이지용) */
function apiInquiry_(p) {
  const f = findInquiry_(p.id, p.k);
  if (!f) return { ok: false, error: "문의를 찾을 수 없거나 링크가 올바르지 않아요." };
  const r = f.row, data = safeJson_(r[C["데이터"] - 1]);
  const ids = (data.items || []).map(x => String(x.id));
  return {
    ok: true,
    inquiry: {
      id: r[C["문의번호"] - 1], time: r[C["접수시간"] - 1], via: r[C["접수경로"] - 1], message: data.message || "",
      status: r[C["처리상태"] - 1], memo: r[C["메모"] - 1], items: data.items || [], chat: data.chat || {}
    },
    listings: findListings_(ids),
    statuses: STATUSES,
    site: SITE_URL
  };
}
function apiUpdate_(p) {
  const f = findInquiry_(p.id, p.k);
  if (!f) return { ok: false, error: "권한이 없어요." };
  if (p.status != null && STATUSES.includes(p.status)) f.sh.getRange(f.rowNum, C["처리상태"]).setValue(p.status);
  if (p.memo != null) f.sh.getRange(f.rowNum, C["메모"]).setValue(String(p.memo).replace(/^[=+\-@]/, "'$&").slice(0, 5000));
  return { ok: true };
}
function findInquiry_(id, key) {
  if (!id || !key) return null;
  const sh = getSheet_(), v = sh.getDataRange().getDisplayValues();
  for (let i = 1; i < v.length; i++) {
    if (String(v[i][C["문의번호"] - 1]) === String(id) && v[i][C["열쇠"] - 1] === key) return { sh, row: v[i], rowNum: i + 1 };
  }
  return null;
}

/* 매물번호로 공개 정보 + 관리용(비공개) 정보 찾기 */
function findListings_(ids) {
  if (!ids.length) return [];
  const ss = ss_();
  const norm = h => String(h).replace(/\([^)]*\)/g, "").replace(/\s/g, "");
  const idCol = h => h.map(norm).findIndex(x => ["매물번호", "번호", "ID", "id"].includes(x));
  const toObj = (h, r) => Object.fromEntries(h.map((k, i) => [String(k).trim(), r[i]]).filter(([k, val]) => k && String(val).trim() !== ""));

  const pubSh = ss.getSheets().find(s => s.getSheetId() === LISTING_SHEET_GID);
  const pv = pubSh ? pubSh.getDataRange().getDisplayValues() : [[]];
  const pic = idCol(pv[0]);
  const privSh = ss.getSheetByName(PRIVATE_SHEET_NAME);
  const qv = privSh ? privSh.getDataRange().getDisplayValues() : [[]];
  const qic = idCol(qv[0]);

  return ids.map(id => {
    let pr = null;
    if (pic >= 0) pr = pv.find((r, i) => i > 0 && String(r[pic]).trim() === id);
    else if (/^\d+$/.test(id) && Number(id) >= 2 && Number(id) <= pv.length) pr = pv[Number(id) - 1];   // 매물번호 열이 없으면 행 번호
    const qr = qic >= 0 ? qv.find((r, i) => i > 0 && String(r[qic]).trim() === id) : null;
    return { id, pub: pr ? toObj(pv[0], pr) : null, priv: qr ? toObj(qv[0], qr) : null };
  });
}

/* ===================== 처음 한 번 실행 ===================== */
function 설치하기() {
  getSheet_();
  Logger.log("시트 확인: " + ss_().getName() + " / 문의 탭: " + getSheet_().getName());
  const pub = ss_().getSheets().find(s => s.getSheetId() === LISTING_SHEET_GID);
  Logger.log(pub ? "매물 탭 확인: " + pub.getName() : "⚠️ 매물 탭(gid " + LISTING_SHEET_GID + ")을 못 찾았어요. LISTING_SHEET_GID 를 확인하세요.");
  상세링크_짧게();   // 이미 들어와 있는 긴 주소도 '📄 상세 보기'로
  Logger.log("설치 완료! 이제 웹 앱으로 배포하세요.");
}

/* ===================== 도우미 ===================== */
function ss_() {
  if (SHEET_ID) return SpreadsheetApp.openById(SHEET_ID);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("시트를 못 찾았어요. 코드 위쪽 SHEET_ID 에 매물 시트 주소의 /d/ 와 /edit 사이 값을 넣어 주세요.");
  return ss;
}
function getSheet_() {
  const ss = ss_();
  let sh = ss.getSheets().find(s => s.getSheetId() === INQUIRY_SHEET_GID) || ss.getSheetByName(SHEET_NAME);
  if (sh) {
    const w = Math.max(sh.getLastColumn(), 1);
    let h = sh.getRange(1, 1, 1, w).getValues()[0].map(String);
    if (h.every(x => !x.trim())) {               // 빈 탭이면 제목 줄을 만들어 줌
      sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight("bold").setBackground("#E0F2FE");
      sh.setFrozenRows(1);
      sh.hideColumns(C["열쇠"], 2);
      sh.getRange(2, C["처리상태"], 1000, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).build());
      return sh;
    }
    // 예전 카카오 버전으로 만들어진 탭: '카톡알림' 열을 지워 열 위치를 맞춤
    const kk = h.indexOf("카톡알림");
    if (kk >= 0) { sh.deleteColumn(kk + 1); h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String); }
    // 예전 형식(성함·연락처 열)이면 열 이름만 새 이름으로 바꿈 (열 위치는 같음)
    if (h[2] === "성함" || h[3] === "연락처") { sh.getRange(1, 3, 1, 2).setValues([[HEAD[2], HEAD[3]]]); h[2] = HEAD[2]; h[3] = HEAD[3]; }
    if (h[0] !== HEAD[0] || h[C["상세페이지"] - 1] !== "상세페이지")
      throw new Error("'" + sh.getName() + "' 탭의 제목 줄이 문의 형식과 달라요. 빈 탭으로 만들거나 INQUIRY_SHEET_GID 를 확인하세요.");
  } else {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEAD);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEAD.length).setFontWeight("bold").setBackground("#E0F2FE");
    sh.hideColumns(C["열쇠"], 2);   // 열쇠·데이터 열은 숨김
    sh.getRange(2, C["처리상태"], 1000, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).build());
  }
  return sh;
}
function safeJson_(s) { try { return JSON.parse(s || "{}"); } catch (e) { return {}; } }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function html_(title, body) {
  return HtmlService.createHtmlOutput(
    `<div style="font-family:-apple-system,sans-serif;max-width:420px;margin:40px auto;padding:0 20px">
     <h2 style="font-size:20px">${title}</h2><div style="font-size:15px;line-height:1.6;color:#334155">${body}</div></div>`
  ).setTitle("와방 문의 접수").addMetaTag("viewport", "width=device-width, initial-scale=1");
}
