/**
 * 와방 · 손님 문의 자동 접수 서버 (구글 Apps Script)
 *
 * 손님이 매물 사이트에서 '중개사에게 바로 전송'을 누르면
 *   1) 문의번호(#1, #2 …)를 자동으로 붙여 시트 '문의접수' 탭에 기록
 *   2) 중개사 카카오톡 '나와의 채팅'으로 한눈에 보이는 요약 메시지 발송 (카카오 연결 시)
 *   3) 메시지의 [문의 전체 보기] 버튼 → 중개사 전용 문의 상세 페이지
 *      (매물 사진·조건 비교·비공개 정보·전화/문자 답장·처리상태 변경·메모)
 *
 * ───────── 설치 순서 ─────────
 * [1] 매물 구글 시트 → 확장 프로그램 → Apps Script → 이 코드 전체 붙여넣기 → 저장
 * [2] 위쪽 함수 선택 칸에서 '설치하기' → 실행 → 권한 허용
 *     (내 계정 선택 → 고급 → 안전하지 않음으로 이동 → 허용)
 * [3] 배포 → 새 배포 → 유형: 웹 앱 / 실행 사용자: 나 / 액세스 권한: 모든 사용자 → 배포
 * [4] '웹 앱 URL'(…/exec)을 매물 사이트 index.html 의 CONFIG.INQUIRY_URL 에 붙여넣기
 *     → 여기까지 하면 문의 접수 + 시트 기록 + 상세 페이지(시트의 '상세페이지' 링크)가 작동
 *
 * [5] (마지막) 카카오톡 알림 연결
 *   a. https://developers.kakao.com → 내 애플리케이션 → 애플리케이션 추가
 *   b. 앱 키의 'REST API 키' → 아래 KAKAO_REST_API_KEY 에 붙여넣기
 *   c. 카카오 로그인 활성화 ON / Redirect URI 에 웹 앱 URL 그대로 등록
 *   d. 동의항목 → '카카오톡 메시지 전송(talk_message)' 선택 동의
 *   e. 플랫폼(제품 링크 관리) → Web 사이트 도메인에 https://bu-room.github.io 등록
 *   f. (Client Secret '사용함'이면 코드 값을 KAKAO_CLIENT_SECRET 에)
 *   g. 코드 저장 → 배포 관리 → 수정(연필) → 버전: 새 버전 → 배포
 *   h. 브라우저에서  웹앱URL?setup=1  → 카카오톡 연결하기 → 테스트 메시지 오면 끝
 *
 * ※ 시트의 '관리용' 탭(직접 만드세요)에 [매물번호, 상세주소, 임대인 연락처, 비밀번호 …] 처럼 적어두면
 *   중개사 상세 페이지에만 표시됩니다. (손님에게 공개되는 매물 탭에는 절대 적지 마세요)
 * ※ 코드를 고친 뒤에는 '배포 관리 → 수정 → 새 버전 → 배포' 해야 반영됩니다. (주소 유지)
 */

const KAKAO_REST_API_KEY  = "";            // 카카오 연결할 때 입력
const KAKAO_CLIENT_SECRET = "";
const SITE_URL            = "https://bu-room.github.io/siteandchat/";
const ADMIN_PAGE_URL      = SITE_URL + "admin/";
const LISTING_SHEET_GID   = 2138382865;    // 손님에게 공개되는 매물 탭 (CSV 주소의 gid= 값)
const PRIVATE_SHEET_NAME  = "관리용";      // 중개사만 보는 정보 탭
const SHEET_NAME          = "문의접수";
const STATUSES            = ["신규", "연락함", "투어예약", "계약", "보류", "종료"];
const HEAD = ["문의번호", "접수시간", "성함", "연락처", "입주 시기", "매물번호", "고른 매물", "방 볼 수 있는 날", "희망 조건", "처리상태", "카톡알림", "상세페이지", "메모", "열쇠", "데이터"];
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
    const id = Number(PROPS.getProperty("LAST_ID") || 0) + 1;
    PROPS.setProperty("LAST_ID", String(id));
    const key = Utilities.getUuid().replace(/-/g, "").slice(0, 20);
    const link = adminLink_(id, key);

    const sh = getSheet_();
    sh.appendRow([
      id, new Date(), clean(d.name), clean(d.phone),
      (isUrgent_(c) ? "🔥 " : "") + clean(c.moveInDate),
      items.map(x => x.id).join(", "),
      items.map(x => `#${x.id} ${x.short || x.area}`).join("\n"),
      clean(c.viewingDate), clean(condText_(c)),
      "신규", "", link, "", key,
      JSON.stringify({ name: d.name || "", phone: d.phone || "", items, chat: c, message: d.message || "" })
    ]);
    const row = sh.getLastRow();

    let kakao = "미연결";
    if (PROPS.getProperty("KAKAO_REFRESH")) {
      try { sendKakaoLong_(agentMsg_(id, d), link); kakao = "발송"; }
      catch (err) { kakao = "실패: " + String(err.message).slice(0, 200); }
    }
    sh.getRange(row, C["카톡알림"]).setValue(kakao);
    return json_({ ok: true, id });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* 중개사 카톡용 한눈에 보는 메시지 (200자 안쪽 목표) */
function agentMsg_(id, d) {
  const c = d.chat || {}, items = d.items || [], N = "①②③④⑤⑥⑦⑧⑨⑩";
  const L = [`🏠 새 문의 #${id}${isUrgent_(c) ? " 🔥입주 급함" : ""} · ${d.name || "손님"} ${d.phone || ""}`.trim()];
  const when = [c.moveInDate && (/입주/.test(c.moveInDate) ? c.moveInDate : "입주 " + c.moveInDate), c.viewingDate && "방 보기 " + c.viewingDate].filter(Boolean).join(" · ");
  if (when) L.push("📅 " + when);
  if (items.length) { L.push(`❤️ 고른 매물 ${items.length}개`); items.forEach((x, i) => L.push(`${N[i] || i + 1 + "."} #${x.id} ${x.short || x.area}`)); }
  else L.push("❤️ 고른 매물 없음 (조건만 접수)");
  // 짧은 조건: "투룸 · 1,000/50~80만 · 주차 · 🐾강아지 1마리"
  const mr = String(c.monthlyRent || "");
  const price = /전세|매매/.test(mr) ? mr : [c.deposit, mr].filter(Boolean).map(s => s.replace(/만원|이하|\s/g, "")).join("/") + (c.deposit || mr ? "만" : "");
  const cond = [c.structure, price, c.parking && !/불필요/.test(c.parking) ? "주차" : "", c.pet && !/없/.test(c.pet) ? "🐾" + c.pet : ""].filter(Boolean).join(" · ");
  if (cond) L.push("💬 " + cond);
  if (c.location && L.join("\n").length + c.location.length < 185) L.push("📍 " + c.location);   // 자리 남으면 위치까지
  return L.join("\n");
}
/* 입주가 한 달 안이면 '급함' → 카톡·시트·상세 페이지에 🔥 표시 (먼저 연락할 손님) */
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
function adminLink_(id, key) {
  return ADMIN_PAGE_URL + "?id=" + id + "&k=" + key + "&api=" + encodeURIComponent(ScriptApp.getService().getUrl());
}

/* ===================== 웹 주소로 들어오는 요청 ===================== */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.api === "inquiry") return json_(apiInquiry_(p));
  if (p.api === "update") return json_(apiUpdate_(p));

  const self = ScriptApp.getService().getUrl();
  if (p.code) {                                   // 카카오 로그인 후 돌아옴
    try {
      saveToken_(kakaoToken_({ grant_type: "authorization_code", redirect_uri: self, code: p.code }));
      sendKakao_("✅ 와방 문의 알림이 연결됐어요!\n이제 새 문의가 오면 여기로 알려드려요.", SITE_URL);
      return html_("✅ 연결 완료!", "카카오톡 '나와의 채팅'에 테스트 메시지가 왔는지 확인해 주세요.");
    } catch (err) {
      return html_("❌ 연결 실패", "원인: " + err.message + "<br><br>Redirect URI 에 아래 주소가 정확히 등록돼 있는지 확인해 주세요.<br><code>" + self + "</code>");
    }
  }
  if (p.setup) {
    if (!KAKAO_REST_API_KEY) return html_("REST API 키가 없어요", "코드 맨 위 KAKAO_REST_API_KEY 를 입력하고 새 버전으로 배포해 주세요.");
    const url = "https://kauth.kakao.com/oauth/authorize?response_type=code&scope=talk_message&client_id=" +
      encodeURIComponent(KAKAO_REST_API_KEY) + "&redirect_uri=" + encodeURIComponent(self);
    return html_("카카오톡 알림 연결",
      `<a href="${url}" target="_top" style="display:block;margin-top:16px;padding:16px;border-radius:14px;background:#FEE500;color:#191919;font-weight:800;text-decoration:none;text-align:center">카카오톡 연결하기</a>
       <p style="margin-top:14px;color:#64748b;font-size:13px">문의를 받을 <b>중개사 본인 카카오 계정</b>으로 로그인해 주세요.</p>`);
  }
  if (p.test) {
    try { sendKakao_("🔔 와방 테스트 알림입니다.", SITE_URL); return html_("테스트 발송 완료", "카톡을 확인해 주세요."); }
    catch (err) { return html_("테스트 실패", err.message); }
  }
  return html_("와방 문의 접수 서버 작동 중",
    "카카오톡 연결: " + (PROPS.getProperty("KAKAO_REFRESH") ? "✅ 연결됨" : "❌ 미연결 (마지막 단계에서 주소 뒤에 ?setup=1)") +
    "<br>접수된 문의: " + (PROPS.getProperty("LAST_ID") || 0) + "건");
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
      id: r[C["문의번호"] - 1], time: r[C["접수시간"] - 1], name: data.name, phone: data.phone,
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
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === "토큰갱신").forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("토큰갱신").timeBased().everyDays(1).atHour(4).create();
  UrlFetchApp.getRequest("https://kauth.kakao.com");
  const pub = SpreadsheetApp.getActiveSpreadsheet().getSheets().find(s => s.getSheetId() === LISTING_SHEET_GID);
  Logger.log(pub ? "매물 탭 확인: " + pub.getName() : "⚠️ 매물 탭(gid " + LISTING_SHEET_GID + ")을 못 찾았어요. LISTING_SHEET_GID 를 확인하세요.");
  Logger.log("설치 완료! 이제 웹 앱으로 배포하세요.");
}
function 토큰갱신() { if (PROPS.getProperty("KAKAO_REFRESH")) accessToken_(true); }

/* ===================== 카카오 API ===================== */
function kakaoToken_(params) {
  const payload = Object.assign({ client_id: KAKAO_REST_API_KEY }, params);
  if (KAKAO_CLIENT_SECRET) payload.client_secret = KAKAO_CLIENT_SECRET;
  const res = UrlFetchApp.fetch("https://kauth.kakao.com/oauth/token", { method: "post", payload, muteHttpExceptions: true });
  const t = JSON.parse(res.getContentText());
  if (!t.access_token) throw new Error("토큰 발급 실패 " + res.getContentText());
  return t;
}
function saveToken_(t) {
  PROPS.setProperty("KAKAO_ACCESS", t.access_token);
  PROPS.setProperty("KAKAO_EXPIRES", String(Date.now() + (t.expires_in - 300) * 1000));
  if (t.refresh_token) PROPS.setProperty("KAKAO_REFRESH", t.refresh_token);
}
function accessToken_(force) {
  const refresh = PROPS.getProperty("KAKAO_REFRESH");
  if (!refresh) throw new Error("카카오톡 미연결");
  if (!force && Date.now() < Number(PROPS.getProperty("KAKAO_EXPIRES") || 0)) return PROPS.getProperty("KAKAO_ACCESS");
  saveToken_(kakaoToken_({ grant_type: "refresh_token", refresh_token: refresh }));
  return PROPS.getProperty("KAKAO_ACCESS");
}
function sendKakao_(text, link) {
  const tpl = { object_type: "text", text: text.slice(0, 200), link: { web_url: link, mobile_web_url: link }, button_title: "문의 전체 보기" };
  const res = UrlFetchApp.fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "post", headers: { Authorization: "Bearer " + accessToken_() },
    payload: { template_object: JSON.stringify(tpl) }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error(res.getContentText());
}
/* 카톡 텍스트는 200자 제한 → 넘치면 줄 단위로 나눠 여러 개로 */
function sendKakaoLong_(text, link) {
  const parts = [];
  let cur = "";
  text.split("\n").forEach(l => {
    while (l.length > 190) { if (cur) { parts.push(cur); cur = ""; } parts.push(l.slice(0, 190)); l = l.slice(190); }
    const next = cur ? cur + "\n" + l : l;
    if (next.length > 190) { parts.push(cur); cur = l; } else cur = next;
  });
  if (cur.trim()) parts.push(cur);
  parts.forEach((p, i) => { sendKakao_((parts.length > 1 ? `(${i + 1}/${parts.length}) ` : "") + p, link); if (i < parts.length - 1) Utilities.sleep(300); });
}

/* ===================== 도우미 ===================== */
function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
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
  ).setTitle("와방 알림").addMetaTag("viewport", "width=device-width, initial-scale=1");
}
