/**
 * tools/collect-megabox.js — 메가박스 공개 예매 API 읽기 전용 수집기
 *
 * 로그인·쿠키 없이 접근 가능한 공개 엔드포인트만 사용한다 (읽기 전용, 예매 행위 없음).
 *   /on/oh/ohc/Brch/selectFooterBrchListWithArea.do  지역별 극장 목록 (HTML)
 *   /on/oh/ohb/SimpleBooking/selectBokdList.do       극장·날짜별 상영 회차 → 상영관 목록
 *   /on/oh/ohz/PcntSeatChoi/selectSeatList.do        회차별 좌석도 + 출입구(gateTyCd)
 *
 * 산출: data/raw-megabox-full.json
 *   { collectedAt, playDe, regions:[[code,name]], sites:[[region,brchNo,name]],
 *     data: { brchNo: { nm, screens: { theabNo: { nm, tot, seats:[], gates:[], info:{} } } } } }
 *
 * 재실행 시 기존 산출물을 읽어 이미 수집된 상영관은 건너뛴다 (증분 수집).
 *
 *   node tools/collect-megabox.js [YYYYMMDD]
 */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "data", "raw-megabox-full.json");
const BASE = "https://www.megabox.co.kr";
const PLAY_DE = process.argv[2] || nextDay();
const CONCURRENCY = 4;

function nextDay() {
  const d = new Date(Date.now() + 86400000);
  return "" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(url, body, asText) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(BASE + url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          "Referer": BASE + "/booking",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0 Safari/537.36"
        },
        body: JSON.stringify(body || {})
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return asText ? await r.text() : await r.json();
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(800 * (attempt + 1));
    }
  }
}

async function pool(items, n, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx], idx); } catch (e) { console.log("  ! " + (e && e.message)); }
      await sleep(120);
    }
  }));
}

/** 푸터 극장찾기 HTML → [[지역명, brchNo, 극장명]] */
function parseBranches(html) {
  const out = [];
  let area = null;
  const re = /<p class="loca">([^<]+)<\/p>|<a href="\/theater\?brchNo=(\d+)" title="([^"]+) 상세보기">/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) area = m[1].trim();
    else if (area) out.push([area, m[2], m[3].trim()]);
  }
  return out;
}

const decode = s => String(s == null ? "" : s)
  .replace(/&#40;/g, "(").replace(/&#41;/g, ")").replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();

(async () => {
  const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { data: {} };
  out.collectedAt = new Date().toISOString().slice(0, 10);
  out.source = "megabox.co.kr 공개 예매 API (읽기 전용)";
  out.playDe = PLAY_DE;

  console.log("메가박스 극장 목록…");
  const html = await post("/on/oh/ohc/Brch/selectFooterBrchListWithArea.do", {}, true);
  const branches = parseBranches(html);
  const areas = [...new Set(branches.map(b => b[0]))];
  out.regions = areas.map((a, i) => [String(i + 1).padStart(2, "0"), a]);
  const areaCode = Object.fromEntries(areas.map((a, i) => [a, String(i + 1).padStart(2, "0")]));
  out.sites = branches.map(([a, no, nm]) => [areaCode[a], no, decode(nm)]);
  console.log("  지역 " + areas.length + " · 극장 " + branches.length);

  /* ── 1단계: 극장별 상영 회차 → 상영관 목록 ── */
  const targets = [];
  await pool(branches, CONCURRENCY, async ([, brchNo, brchNm]) => {
    const j = await post("/on/oh/ohb/SimpleBooking/selectBokdList.do",
      { playDe: PLAY_DE, brchNo1: brchNo, sellChnlCd: "MEGABOX" });
    const list = j.movieFormList || [];
    const site = out.data[brchNo] = out.data[brchNo] || { nm: decode(brchNm), screens: {} };
    site.nm = decode(brchNm);
    const seen = new Set();
    for (const s of list) {
      if (String(s.brchNo) !== String(brchNo) || seen.has(s.theabNo)) continue;
      seen.add(s.theabNo);
      const prev = site.screens[s.theabNo];
      site.screens[s.theabNo] = {
        nm: decode(s.theabExpoNm),
        tot: s.theabSeatCnt,
        seats: prev && prev.seats ? prev.seats : null,
        gates: prev && prev.gates ? prev.gates : null,
        info: prev && prev.info ? prev.info : null,
        grades: prev && prev.grades ? prev.grades : null
      };
      if (!site.screens[s.theabNo].seats) targets.push({ brchNo, theabNo: s.theabNo, schdl: s.playSchdlNo });
    }
    console.log("  " + decode(brchNm) + " — 상영관 " + seen.size);
  });

  console.log("좌석도 수집 대상 " + targets.length + "관");

  /* ── 2단계: 상영관별 좌석도 + 출입구 ── */
  let done = 0;
  await pool(targets, CONCURRENCY, async (t) => {
    const j = await post("/on/oh/ohz/PcntSeatChoi/selectSeatList.do",
      { playSchdlNo: t.schdl, brchNo: t.brchNo });
    const rec = out.data[t.brchNo].screens[t.theabNo];
    const seats = j.seatListSD01 || [];
    if (!seats.length) { rec.err = "no seats"; return; }
    // 좌석: [행라벨, 좌석번호, 가로그리드, 세로그리드, 등급코드, 가로크기비]
    rec.seats = seats.map(s => [s.rowNm, s.seatNo, s.horzCoorVal, s.vertCoorVal, s.seatClassCd, s.horzSizeRt || 1]);
    // 출입구/게이트: [게이트유형, 가로그리드, 세로그리드]  (SD05 = 좌석이 아닌 표시 요소)
    rec.gates = (j.seatListSD05 || []).filter(s => s.gateTyCd)
      .map(s => [s.gateTyCd, s.horzCoorVal, s.vertCoorVal]);
    const si = j.seatInfoSD01 || {};
    rec.info = { rowMin: si.rowNmMin, rowMax: si.rowNmMax, colMin: si.colNoMin, colMax: si.colNoMax, rowNoMin: si.rowNoMin, rowNoMax: si.rowNoMax };
    rec.grades = (j.seatClassCdList || []).map(c => [c.seatClassCd, decode(c.seatClassNm || c.seatClassCdNm)]);
    if (++done % 25 === 0) {
      console.log("  좌석도 " + done + "/" + targets.length);
      fs.writeFileSync(OUT, JSON.stringify(out), "utf8");
    }
  });

  fs.writeFileSync(OUT, JSON.stringify(out), "utf8");
  const nScreen = Object.values(out.data).reduce((a, s) => a + Object.keys(s.screens).length, 0);
  const nSeats = Object.values(out.data).reduce((a, s) =>
    a + Object.values(s.screens).reduce((b, x) => b + (x.seats ? x.seats.length : 0), 0), 0);
  console.log("완료 — 극장 " + Object.keys(out.data).length + " · 상영관 " + nScreen + " · " + nSeats + "석");
})();
