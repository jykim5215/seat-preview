/**
 * tools/import-cgv-raw.js — 1회성 변환기
 * data/raw-cgv-collected.json (CGV 수집 원본, 그리드 단위)
 *   → data/theaters.json (사람이 편집하는 소스, 미터 단위 좌석 좌표 포함)
 *
 * 실행: node tools/import-cgv-raw.js
 * 이후 node tools/build-data.js 로 theaters.js 를 재생성한다.
 *
 * 좌표 변환 근거:
 *  - CGV 좌석도 그리드에서 좌석 1개는 가로 2단위를 차지한다 (수집 데이터에서 인접 좌석 x간격=2).
 *  - 일반 좌석 좌우 피치를 0.56 m 로 두면 1그리드단위 = 0.28 m.
 *    (0.52~0.60 m 는 국내 멀티플렉스 일반석 피치의 통상 범위. 실측 아님 → 추정 표기)
 *  - xM 은 "해당 상영관 좌석 전체의 기하 중심"을 0 으로 하는 좌우 오프셋(관객 기준 오른쪽 +).
 *  - 열(z)·바닥높이(y)는 앱 로드 시 auditorium 파라미터로부터 계산한다 (src/data/layout.js).
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "raw-cgv-collected.json"), "utf8"));

const UNIT_M = 0.28; // 1 그리드단위 (m) = seatPitch 0.56 / 2

/* ── 그리드 인코딩 해석: "n,x,y[,wWhH][,k코드][,L][,R]" ── */
function decodeRow(str) {
  return str.split(";").map(tok => {
    const parts = tok.split(",");
    const seat = { n: +parts[0], gx: +parts[1], gy: +parts[2], gw: 2, gh: 2, knd: "01", L: false, R: false };
    for (let i = 3; i < parts.length; i++) {
      const p = parts[i];
      if (p === "L") seat.L = true;
      else if (p === "R") seat.R = true;
      else if (p[0] === "k") seat.knd = p.slice(1);
      else if (p[0] === "w") { const m = p.match(/^w(\d+)h(\d+)$/); if (m) { seat.gw = +m[1]; seat.gh = +m[2]; } }
    }
    return seat;
  });
}

/* ── 수동 큐레이션: 실측치가 공개된 상영관 ──
 * screen.widthM/heightM 만 실측(공개 보도자료). 나머지 필드는 좌석 데이터 기반 추정.
 */
const CURATED = {
  "0013-018": {
    geometrySource: "measured",
    sourceNote: "CGV 용산아이파크몰 IMAX LASER(GT). 스크린 폭 31 m × 높이 22.4 m 는 CGV/IMAX 공개 수치. 곡률·경사·객석 기하는 좌석 배치 기반 추정.",
    formats: ["IMAX 1.43", "IMAX 1.90", "2.39", "1.85"],
    screen: { widthM: 31.0, heightM: 22.4, bottomHeightM: 1.0, curvatureRadiusM: 26.0, tiltDeg: 2.0, maskingRatios: {} },
    auditorium: { floorProfile: "stepped", rowRiseM: 0.45, rowPitchM: 1.15, seatPitchM: 0.56, firstRowZM: 8.5, firstRowFloorYM: 0.0, eyeHeightM: 1.15 }
  }
};

/* 포맷 결정: IMAX 디지털관은 1.90, 그 외 2.39/1.85 */
function formatsFor(key, name) {
  if (CURATED[key] && CURATED[key].formats) return CURATED[key].formats;
  if (/IMAX/i.test(name)) return ["IMAX 1.90", "2.39", "1.85"];
  return ["2.39", "1.85"];
}

/* ── 상영관 레코드 생성 ── */
function buildScreen(siteNo, scnNo, meta /* {name,totalSeats} */, collected /* raw.screens 항목 | null */) {
  const key = siteNo + "-" + scnNo;
  const cur = CURATED[key] || null;
  const rec = {
    id: key,
    name: meta.name,
    totalSeats: meta.totalSeats,
    formats: formatsFor(key, meta.name),
    geometrySource: cur ? cur.geometrySource : "estimated",
    sourceNote: cur ? cur.sourceNote : "스크린·객석 치수는 CGV 비공개 → 좌석 배치(열 수·좌석 수·피치)로부터 추정 (src/data/estimate.js estimateScreenGeometry). 좌석 배치 자체는 CGV 예매 좌석도 실데이터.",
    screen: cur ? cur.screen : null,        // null 이면 앱이 estimateScreenGeometry() 로 채움
    auditorium: cur ? cur.auditorium : null,
    grid: null,
    rows: null
  };
  if (!collected) { rec.sourceNote = "좌석 배치 미수집 — 선택 불가 (이름·좌석 수만 수집)"; return rec; }

  // 열을 y 오름차순(스크린 가까운 열부터)으로 정리
  const rowEntries = Object.entries(collected.rows)
    .map(([label, str]) => ({ label, seats: decodeRow(str) }))
    .map(r => ({ label: r.label, y: Math.min(...r.seats.map(s => s.gy)), seats: r.seats.sort((a, b) => a.gx - b.gx) }))
    .sort((a, b) => a.y - b.y);

  // 좌석 기하 중심을 x=0 으로
  let minX = Infinity, maxX = -Infinity, maxY = 0;
  rowEntries.forEach(r => r.seats.forEach(s => {
    minX = Math.min(minX, s.gx); maxX = Math.max(maxX, s.gx + s.gw); maxY = Math.max(maxY, s.gy + s.gh);
  }));
  const cx = (minX + maxX) / 2;

  const kinds = collected.kinds || {};
  rec.grid = { minX, maxX, maxY, unitM: UNIT_M };
  rec.rows = rowEntries.map(r => ({
    label: r.label,
    gy: r.y,
    seats: r.seats.map(s => ({
      n: s.n,
      xM: +(((s.gx + s.gw / 2) - cx) * UNIT_M).toFixed(3),
      gx: s.gx, gy: s.gy,
      grade: kinds[s.knd] || "일반석",
      aisleAfter: s.R
    }))
  }));
  const cnt = rec.rows.reduce((a, r) => a + r.seats.length, 0);
  if (cnt !== meta.totalSeats) console.warn(`  [주의] ${key} ${meta.name}: 수집 ${cnt}석 ≠ 회차정보 ${meta.totalSeats}석`);
  return rec;
}

/* ── 극장/지역 트리 ── */
const collectedBySite = {};
for (const key of Object.keys(raw.screens)) {
  const [siteNo, scnNo] = key.split("-");
  (collectedBySite[siteNo] = collectedBySite[siteNo] || {})[scnNo] = raw.screens[key];
}

const theatersBySite = {};
for (const [siteNo, list] of Object.entries(raw.extraScreens)) {
  theatersBySite[siteNo] = list.map(([scnNo, name, total]) =>
    buildScreen(siteNo, scnNo, { name, totalSeats: total }, (collectedBySite[siteNo] || {})[scnNo] || null));
}

const regions = raw.regions.map(([code, name]) => ({
  id: "r" + code,
  name,
  theaters: raw.sites.filter(s => s[0] === code).map(([, siteNo, siteNm]) => ({
    id: "s" + siteNo,
    siteNo,
    name: "CGV " + siteNm,
    screens: theatersBySite[siteNo] || []
  }))
}));

const out = {
  schemaVersion: 1,
  generatedFrom: "raw-cgv-collected.json (" + raw.collectedAt + " 수집)",
  aisleWidthNote: "좌석 xM 은 통로를 포함한 실제 그리드 좌표 기반. 그리드 통로 폭은 대개 4단위 ≈ 1.12 m.",
  unitM: UNIT_M,
  regions
};

fs.writeFileSync(path.join(ROOT, "data", "theaters.json"), JSON.stringify(out, null, 1), "utf8");
const nScreens = Object.values(theatersBySite).flat().filter(s => s.rows).length;
const nSeats = Object.values(theatersBySite).flat().filter(s => s.rows).reduce((a, s) => a + s.rows.reduce((b, r) => b + r.seats.length, 0), 0);
console.log(`theaters.json 생성: 지역 ${regions.length} · 극장 ${raw.sites.length} · 배치 수집 상영관 ${nScreens} · 좌석 ${nSeats}`);
