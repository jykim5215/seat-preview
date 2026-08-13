/**
 * tools/import-cgv-raw.js — 수집 원본 → 앱 데이터 변환기
 *
 * 입력:
 *  - data/raw-cgv-collected.json  1차 수집 (용산아이파크몰·춘천, 인코딩 동일)
 *  - data/raw-cgv-full.json       전체 수집 (있으면 병합; { data: {siteNo: {nm, screens:{scnNo:{nm,tot,kinds,rows|err}}}} })
 *
 * 출력:
 *  - data/theaters.json           인덱스 (지역→극장→상영관 메타. 좌석 없음 — 사람이 편집하는 소스)
 *  - data/sites/{siteNo}.js       사이트별 좌석 데이터 (앱이 선택 시 지연 로딩)
 *
 * 이후 node tools/build-data.js 로 theaters.js(인덱스의 JS 버전)를 재생성한다.
 * 좌석 인코딩("n,x,y[,wWhH][,k코드][,L][,R]")의 해석은 src/data/layout.js 가 단독 담당.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const dataDir = p => path.join(ROOT, "data", p);

const old = JSON.parse(fs.readFileSync(dataDir("raw-cgv-collected.json"), "utf8"));
let full = null;
if (fs.existsSync(dataDir("raw-cgv-full.json"))) {
  full = JSON.parse(fs.readFileSync(dataDir("raw-cgv-full.json"), "utf8"));
}

/* ── 사이트별 상영관 병합 맵: site → scn → {nm, tot, kinds, rows|null} ── */
const bySite = {};
function put(siteNo, scnNo, rec) {
  (bySite[siteNo] = bySite[siteNo] || {})[scnNo] = rec;
}
// 1차 수집 (rows 있는 화면들)
for (const [key, v] of Object.entries(old.screens)) {
  const [siteNo, scnNo] = key.split("-");
  put(siteNo, scnNo, { nm: v.nm, tot: null, kinds: v.kinds, rows: v.rows });
}
// 1차 수집 당시 이름·좌석수만 알던 화면들 (rows 없음)
for (const [siteNo, list] of Object.entries(old.extraScreens)) {
  for (const [scnNo, name, tot] of list) {
    if (bySite[siteNo] && bySite[siteNo][scnNo]) { bySite[siteNo][scnNo].tot = tot; continue; }
    put(siteNo, scnNo, { nm: name, tot: tot, kinds: null, rows: null });
  }
}
// 전체 수집 병합 (이미 있는 항목은 새 데이터 우선 — 더 최신)
if (full) {
  for (const [siteNo, site] of Object.entries(full.data)) {
    for (const [scnNo, v] of Object.entries(site.screens)) {
      if (v.rows) put(siteNo, scnNo, { nm: v.nm, tot: v.tot, kinds: v.kinds, rows: v.rows });
      else if (!(bySite[siteNo] && bySite[siteNo][scnNo] && bySite[siteNo][scnNo].rows))
        put(siteNo, scnNo, { nm: v.nm, tot: v.tot, kinds: null, rows: null });
    }
  }
}

/* ── 수동 큐레이션: 실측치가 공개된 상영관 ── */
const CURATED = {
  "0013-018": {
    geometrySource: "measured",
    sourceNote: "CGV 용산아이파크몰 IMAX LASER(GT). 스크린 폭 31 m × 높이 22.4 m 는 CGV/IMAX 공개 수치. 곡률·경사·객석 기하는 좌석 배치 기반 추정.",
    formats: ["IMAX 1.90", "IMAX 1.43", "2.39", "1.85"], // 기본 선택이 첫 항목 — 1.90 이 일반적
    screen: { widthM: 31.0, heightM: 22.4, bottomHeightM: 1.0, curvatureRadiusM: 26.0, tiltDeg: 2.0, maskingRatios: {}, sideProjection: false, sideLenM: null },
    auditorium: { floorProfile: "stepped", rowRiseM: 0.45, rowPitchM: 1.15, seatPitchM: 0.56, firstRowZM: 8.5, firstRowFloorYM: 0.0, eyeHeightM: 1.15 }
  }
};

function formatsFor(key, name) {
  if (CURATED[key] && CURATED[key].formats) return CURATED[key].formats;
  if (/IMAX/i.test(name)) return ["IMAX 1.90", "2.39", "1.85"];
  if (/SCREENX/i.test(name)) return ["SCREENX", "2.39", "1.85"];
  return ["2.39", "1.85"];
}

function seatCount(rows) {
  return Object.values(rows).reduce((a, r) => a + r.split(";").length, 0);
}

/* ── 인덱스 + 사이트 파일 생성 ── */
const sitesOut = {};
let nScreens = 0, nSeats = 0, nNoRows = 0;

const regions = old.regions.map(([code, name]) => ({
  id: "r" + code,
  name,
  theaters: old.sites.filter(s => s[0] === code).map(([, siteNo, siteNm]) => {
    const scns = bySite[siteNo] || {};
    const screens = Object.keys(scns).sort().map(scnNo => {
      const v = scns[scnNo];
      const key = siteNo + "-" + scnNo;
      const cur = CURATED[key] || null;
      const hasRows = !!v.rows;
      if (hasRows) {
        (sitesOut[siteNo] = sitesOut[siteNo] || {})[scnNo] = { kinds: v.kinds, rows: v.rows };
        nScreens++; nSeats += seatCount(v.rows);
      } else nNoRows++;
      return {
        id: key,
        name: v.nm,
        totalSeats: v.tot != null ? v.tot : (hasRows ? seatCount(v.rows) : 0),
        formats: formatsFor(key, v.nm),
        geometrySource: cur ? cur.geometrySource : "estimated",
        sourceNote: cur ? cur.sourceNote
          : hasRows ? "스크린·객석 치수는 좌석 배치 기반 추정 (estimateScreenGeometry). 좌석 배치는 CGV 예매 좌석도 실데이터."
          : "좌석 배치 미수집 (수집일에 상영 회차 없음) — 선택 불가",
        screen: cur ? cur.screen : null,
        auditorium: cur ? cur.auditorium : null,
        hasRows: hasRows
      };
    });
    return { id: "s" + siteNo, siteNo, name: "CGV " + siteNm, screens };
  })
}));

const index = {
  schemaVersion: 2,
  generatedFrom: "raw-cgv-collected.json + raw-cgv-full.json (" + (full ? full.collectedAt || "" : "전체 수집 전") + ")",
  note: "좌석 데이터는 data/sites/{siteNo}.js 로 분리 (지연 로딩). 인코딩 해석: src/data/layout.js",
  unitM: 0.28,
  regions
};

fs.writeFileSync(dataDir("theaters.json"), JSON.stringify(index, null, 1), "utf8");

const sitesDir = dataDir("sites");
if (!fs.existsSync(sitesDir)) fs.mkdirSync(sitesDir);
// 이전 산출물 정리 후 재생성
for (const f of fs.readdirSync(sitesDir)) fs.unlinkSync(path.join(sitesDir, f));
for (const [siteNo, scns] of Object.entries(sitesOut)) {
  const js = "/* 자동 생성 — node tools/import-cgv-raw.js */\n" +
    "window.SITE_SEATS = window.SITE_SEATS || {};\n" +
    "window.SITE_SEATS[" + JSON.stringify(siteNo) + "] = " + JSON.stringify(scns) + ";\n";
  fs.writeFileSync(path.join(sitesDir, siteNo + ".js"), js, "utf8");
}

console.log(`theaters.json: 지역 ${regions.length} · 극장 ${old.sites.length}`);
console.log(`sites/*.js: ${Object.keys(sitesOut).length}개 파일 · 배치 수집 상영관 ${nScreens} (${nSeats}석) · 미수집 ${nNoRows}`);
