/**
 * tools/collect-lotte.js — 롯데시네마 공개 예매 API 읽기 전용 수집기
 *
 * 로그인·인증 없이 접근 가능한 공개 엔드포인트만 사용한다 (읽기 전용, 예매 행위 없음).
 *   /LCWS/Cinema/CinemaData.aspx      GetCinemaItems    극장 목록 (지역 구분 포함)
 *   /LCWS/Ticketing/TicketingData.aspx GetPlaySequence  극장·날짜별 상영 회차 → 상영관 목록
 *   /LCWS/Ticketing/TicketingData.aspx GetSeats         회차별 좌석도 + 출입구 좌표
 *
 * 산출: data/raw-lotte-full.json
 *   { collectedAt, playDate, regions:[[code,name]], cinemas:[[region,cinemaId,name,divCode,detailDiv]],
 *     data: { cinemaId: { nm, screens: { screenId: { nm, tot, div, seats:[], ents:[], info:{} } } } } }
 *
 * 재실행 시 기존 산출물을 읽어 이미 수집된 상영관은 건너뛴다 (증분 수집).
 *
 *   node tools/collect-lotte.js [YYYY-MM-DD]
 */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "data", "raw-lotte-full.json");
const PLAY_DATE = process.argv[2] || nextDay();
const CONCURRENCY = 4;

/* 지역 코드는 API 가 이름을 주지 않는다 — 예매 페이지의 지역 탭 순서·극장 수와 대조해 확정한 매핑 */
const REGION_NAMES = {
  "0001": "서울",
  "0002": "경기/인천",
  "0003": "충청/대전",
  "0004": "전라/광주",
  "0005": "경북/대구",
  "0006": "강원",
  "0007": "제주",
  "0101": "경남/부산/울산"
};

function nextDay() {
  const d = new Date(Date.now() + 86400000);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

async function lcws(page, params) {
  const fd = new FormData();
  fd.append("paramList", JSON.stringify(Object.assign(
    { channelType: "HO", osType: "Windows", osVersion: "Chrome" }, params)));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch("https://www.lottecinema.co.kr/LCWS/" + page, { method: "POST", body: fd });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(800 * (attempt + 1));
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 동시 실행 수를 제한한 순차 소비 */
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

(async () => {
  const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { data: {} };
  out.collectedAt = new Date().toISOString().slice(0, 10);
  out.source = "lottecinema.co.kr 공개 예매 API (읽기 전용)";
  out.playDate = PLAY_DATE;
  out.regions = Object.entries(REGION_NAMES);

  console.log("롯데시네마 극장 목록…");
  const cin = await lcws("Cinema/CinemaData.aspx", { MethodName: "GetCinemaItems" });
  // DivisionCode 1 만 실제 극장. 2 는 특별관 묶음(샤롯데·수퍼플렉스…) 이라 극장 목록에서 제외한다.
  const cinemas = cin.Cinemas.Items.filter(c => c.DivisionCode === 1 && REGION_NAMES[c.DetailDivisionCode]);
  out.cinemas = cinemas.map(c => [c.DetailDivisionCode, String(c.CinemaID), c.CinemaNameKR, c.DivisionCode, c.DetailDivisionCode]);
  console.log("  극장 " + cinemas.length);

  /* ── 1단계: 극장별 상영 회차 → 상영관 목록 ── */
  const targets = [];
  await pool(cinemas, CONCURRENCY, async (c) => {
    const id = String(c.CinemaID);
    const ps = await lcws("Ticketing/TicketingData.aspx", {
      MethodName: "GetPlaySequence",
      playDate: PLAY_DATE,
      cinemaID: c.DivisionCode + "|" + c.DetailDivisionCode + "|" + c.CinemaID,
      representationMovieCode: ""
    });
    const items = (ps.PlaySeqs && ps.PlaySeqs.Items) || [];
    const site = out.data[id] = out.data[id] || { nm: c.CinemaNameKR, screens: {} };
    site.nm = c.CinemaNameKR;
    const seen = new Set();
    for (const s of items) {
      const sid = String(s.ScreenID);
      if (seen.has(sid)) continue;
      seen.add(sid);
      const prev = site.screens[sid];
      site.screens[sid] = {
        nm: s.ScreenNameKR,
        tot: s.TotalSeatCount,
        div: s.ScreenDivisionNameKR,
        film: s.FilmNameKR,
        sound: s.SoundTypeNameKR,
        seats: prev && prev.seats ? prev.seats : null,
        ents: prev && prev.ents ? prev.ents : null,
        info: prev && prev.info ? prev.info : null
      };
      if (!site.screens[sid].seats) targets.push({ cinemaId: c.CinemaID, screenId: s.ScreenID, seq: s.PlaySequence, date: s.PlayDt, key: id + "/" + sid });
    }
    console.log("  " + c.CinemaNameKR + " — 상영관 " + seen.size);
  });

  console.log("좌석도 수집 대상 " + targets.length + "관");

  /* ── 2단계: 상영관별 좌석도 + 출입구 ── */
  let done = 0;
  await pool(targets, CONCURRENCY, async (t) => {
    const j = await lcws("Ticketing/TicketingData.aspx", {
      MethodName: "GetSeats",
      cinemaId: Number(t.cinemaId),
      screenId: Number(t.screenId),
      playDate: t.date,
      playSequence: Number(t.seq)
    });
    const [cid, sid] = t.key.split("/");
    const rec = out.data[cid].screens[sid];
    const seats = (j.Seats && j.Seats.Items) || [];
    if (!seats.length) { rec.err = "no seats"; return; }
    // 좌석: [행라벨, 표시열번호, X, Y, 폭, 높이, 등급코드, 스위트스팟]
    rec.seats = seats.map(s => [s.SeatRow, s.ShowSeatColumn, s.SeatXCoordinate, s.SeatYCoordinate,
      s.SeatXLength, s.SeatYLength, s.CustomerDivisionCode, s.SweetSpotYN === "Y" ? 1 : 0]);
    // 출입구: [구분명, 각도코드, X, Y]
    rec.ents = ((j.Enterences && j.Enterences.Items) || []).map(e =>
      [e.EnterenceDivisionNameKR, e.EnterenceAngleCode, Number(e.EnterenceXCoordination), Number(e.EnterenceYCoordination)]);
    const si = (j.ScreenSeatInfo && j.ScreenSeatInfo.Items && j.ScreenSeatInfo.Items[0]) || {};
    rec.info = { maxCol: si.MaxSeatColumn, x0: si.StartXCoordinate, y0: si.StartYCoordinate, x1: si.EndXCoordinate };
    rec.grades = ((j.CustomerDivision && j.CustomerDivision.Items) || [])
      .map(c => [c.CustomerDivisionCode, c.CustomerDivisionNameKR]);
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
