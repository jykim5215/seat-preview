/**
 * tools/import-raw.js — 3사 수집 원본 → 앱 데이터 변환기 (CGV · 메가박스 · 롯데시네마)
 *
 * 입력:
 *  - data/raw-cgv-collected.json / raw-cgv-full.json   CGV      (좌석 인코딩이 이미 그리드)
 *  - data/raw-megabox-full.json                        메가박스 (horz/vert 그리드 + gateTyCd)
 *  - data/raw-lotte-full.json                          롯데시네마 (픽셀 좌표 + 출입구 좌표)
 *
 * 출력:
 *  - data/theaters.json        인덱스 (브랜드→지역→극장→상영관 메타. 좌석 없음 — 사람이 편집하는 소스)
 *  - data/sites/{siteKey}.js   사이트별 좌석 데이터 (앱이 선택 시 지연 로딩)
 *
 * siteKey 는 브랜드 접두사로 구분한다: CGV "0056" · 메가박스 "mb1372" · 롯데 "lc1013".
 * 이후 node tools/build-data.js 로 theaters.js 를 재생성한다.
 *
 * 좌석 인코딩("n,x,y[,wWhH][,k코드][,L][,R]")의 해석은 src/data/layout.js 가 단독 담당한다.
 * 출입구는 같은 그리드계의 "gx,gy,종류" 문자열 배열(gates)로 함께 저장한다 — 좌석과 같은
 * 좌표계라야 layout.js 가 한 번의 변환으로 미터 좌표를 만들 수 있다.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const dataDir = p => path.join(ROOT, "data", p);
const readJson = p => JSON.parse(fs.readFileSync(dataDir(p), "utf8"));
const exists = p => fs.existsSync(dataDir(p));

/* ══════════════════════════════════════════════════════════════════════
   공통 — 좌표 → CGV 호환 그리드 인코딩
   ══════════════════════════════════════════════════════════════════════ */

/** 배열에서 최빈값 (동률이면 작은 값). 좌석 간격 추정에 쓴다. */
function mode(values) {
  const count = new Map();
  for (const v of values) count.set(v, (count.get(v) || 0) + 1);
  let best = null, bestN = 0;
  for (const [v, n] of [...count.entries()].sort((a, b) => a[0] - b[0])) {
    if (n > bestN) { best = v; bestN = n; }
  }
  return best;
}

/**
 * 좌석 피치 추정.
 * 같은 열 안에서 이웃 좌석 사이 간격의 최빈값이 곧 좌석 피치다.
 * (통로는 그 정수배로 벌어지므로 최빈값을 흐리지 않는다. 최솟값은 좌표가
 *  겹치는 이상 좌석 때문에 신뢰할 수 없어 쓰지 않는다.)
 */
function estimatePitch(groups) {
  const diffs = [];
  for (const values of groups) {
    const uniq = [...new Set(values)].sort((a, b) => a - b);
    for (let i = 1; i < uniq.length; i++) {
      const d = uniq[i] - uniq[i - 1];
      if (d > 0) diffs.push(d);
    }
  }
  if (!diffs.length) return null;
  const m = mode(diffs);
  // 최빈값이 이상치(겹친 좌석 등)일 때를 대비해 하한을 둔다: 전체 간격 중앙값의 40% 이상
  const sorted = diffs.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return m >= median * 0.4 ? m : median;
}

/**
 * 좌석·출입구 좌표 → CGV 호환 그리드 인코딩.
 * CGV 규약을 그대로 따른다: 좌석 1칸 = 가로 2단위 × 세로 2단위, 통로는 그만큼 벌어진 빈칸.
 *
 * @param {Array} seats [{row, num, x, y, grade, wide}]  x/y 는 브랜드 원좌표 (y 클수록 스크린에서 멀다)
 * @param {Array} gates [{x, y, kind}]
 * @returns {{kinds:Object, rows:Object, gates:Array}|null}
 */
function encodeGrid(seats, gates) {
  if (!seats.length) return null;

  const byRow = new Map();
  for (const s of seats) {
    if (!byRow.has(s.row)) byRow.set(s.row, []);
    byRow.get(s.row).push(s);
  }

  const pitchX = estimatePitch([...byRow.values()].map(list => list.map(s => s.x)));
  // 열 사이 간격: 열별 대표 y 의 간격
  const rowY = [...byRow.values()].map(list => Math.min(...list.map(s => s.y)));
  const pitchY = estimatePitch([rowY]) || pitchX;
  if (!pitchX || !pitchY) return null;

  const minX = Math.min(...seats.map(s => s.x));
  const minY = Math.min(...seats.map(s => s.y));
  const gx = x => Math.round(((x - minX) / pitchX) * 2);
  const gy = y => Math.round(((y - minY) / pitchY) * 2);

  /* 등급 이름 → 2자리 코드 */
  const kinds = {};
  const kindCode = new Map();
  for (const s of seats) {
    const name = s.grade || "일반석";
    if (!kindCode.has(name)) {
      const code = String(kindCode.size + 1).padStart(2, "0");
      kindCode.set(name, code);
      kinds[code] = name;
    }
  }

  const rows = {};
  for (const [label, list] of byRow) {
    const placed = new Map(); // gx → 좌석 (좌표가 겹치는 이상 좌석은 하나만 남긴다)
    for (const s of list.slice().sort((a, b) => a.x - b.x)) {
      let key = gx(s.x);
      while (placed.has(key)) key += 2; // 겹치면 오른쪽으로 밀어 배치 유지
      placed.set(key, s);
    }
    const ordered = [...placed.entries()].sort((a, b) => a[0] - b[0]);
    const tokens = ordered.map(([x, s], i) => {
      const prev = i > 0 ? ordered[i - 1][0] : null;
      const next = i < ordered.length - 1 ? ordered[i + 1][0] : null;
      const width = s.wide ? s.wide * 2 : 2;
      const parts = [s.num, x, gy(s.y)];
      if (width !== 2) parts.push("w" + width + "h2");
      const code = kindCode.get(s.grade || "일반석");
      if (code !== "01") parts.push("k" + code);
      if (prev === null || x - prev > 2) parts.push("L");
      if (next === null || next - x > 2) parts.push("R");
      return parts.join(",");
    });
    rows[label] = tokens.join(";");
  }

  const gateList = (gates || []).map(g => [gx(g.x), gy(g.y), g.kind].join(","));
  return { kinds, rows, gates: gateList.length ? gateList : undefined };
}

/* ══════════════════════════════════════════════════════════════════════
   브랜드별 기하 추정 힌트 (특별관 종류) — src/data/estimate.js 가 소비
   ══════════════════════════════════════════════════════════════════════ */

/** 상영관 이름·구분에서 특별관 종류를 뽑는다. estimate.js 의 hall 힌트가 된다. */
function hallKindOf(brand, name, division) {
  const s = (name + " " + (division || "")).toUpperCase();
  if (brand === "cgv") {
    if (/IMAX/.test(s)) return "imax";
    if (/SCREENX/.test(s)) return "screenx";
    if (/4DX/.test(s)) return "4dx";
    if (/GOLD ?CLASS|CINE ?DE ?CHEF|템퍼|PRIVATE/.test(s)) return "boutique";
    return null;
  }
  if (brand === "megabox") {
    // 실제 수집된 상영관 이름 기준: "DOLBY CINEMA [Laser]" · "MEGA | MX4D관" ·
    // "MEGA | LED 2관" · "부티크 스위트 101호" · "르 리클라이너 3관" · "컴포트 1관"
    if (/MX4D|MEGA4D/.test(s)) return "4dx";
    if (/DOLBY/.test(s)) return "dolby";
    if (/LUMINEON|LED/.test(s)) return "led";
    if (/BOUTIQUE|부티크|PRIVATE|프라이빗/.test(s)) return "boutique";
    if (/리클라이너|RECLINER|RECLINE/.test(s)) return "recliner";
    if (/COMFORT|컴포트/.test(s)) return "comfort";
    return null;
  }
  if (brand === "lotte") {
    // 상영관 구분(ScreenDivisionNameKR) 기준: 수퍼플렉스 · 광음시네마 · 샤롯데 ·
    // 수퍼LED · 광음LED · 수퍼MX4D · 리클라이너 · 씨네패밀리 · 아르떼
    if (/수퍼4D|SUPER ?4D|MX4D/.test(s)) return "4dx";
    if (/수퍼플렉스|SUPER ?PLEX/.test(s)) return "superplex";
    if (/LED/.test(s)) return "led";
    if (/광음/.test(s)) return "premium";
    if (/샤롯데|CHARLOTTE|스위트|SUITE/.test(s)) return "boutique";
    if (/리클라이너|RECLINE/.test(s)) return "recliner";
    // 아르떼는 좌석 사양이 아니라 예술영화 브랜드라 특별관으로 보지 않는다
    if (/씨네패밀리|씨네커플|패밀리/.test(s)) return "comfort";
    return null;
  }
  return null;
}

function formatsFor(hall) {
  if (hall === "imax") return ["IMAX 1.90", "2.39", "1.85"];
  if (hall === "screenx") return ["SCREENX", "2.39", "1.85"];
  return ["2.39", "1.85"];
}

/* ══════════════════════════════════════════════════════════════════════
   수동 큐레이션 — 사업자가 수치를 공개한 상영관만 "실측"
   ══════════════════════════════════════════════════════════════════════ */
const CURATED = {
  "0013-018": {
    geometrySource: "measured",
    sourceNote: "CGV 용산아이파크몰 IMAX LASER(GT). 스크린 폭 31 m × 높이 22.4 m 는 CGV/IMAX 공개 수치. 곡률·경사·객석 기하는 좌석 배치 기반 추정.",
    formats: ["IMAX 1.90", "IMAX 1.43", "2.39", "1.85"],
    screen: { widthM: 31.0, heightM: 22.4, bottomHeightM: 1.0, curvatureRadiusM: 26.0, tiltDeg: 2.0, maskingRatios: {}, sideProjection: false, sideLenM: null },
    auditorium: { floorProfile: "stepped", rowRiseM: 0.45, rowPitchM: 1.15, seatPitchM: 0.56, firstRowZM: 8.5, firstRowFloorYM: 0.0, eyeHeightM: 1.15 }
  },
  "lc1016-101621": {
    geometrySource: "measured",
    sourceNote: "롯데시네마 월드타워 21관 SUPER PLEX. 스크린 34 m × 13.8 m는 롯데 공식 공개 수치. 객석 높이·간격은 좌석도와 특별좌석 유형 기반 추정.",
    formats: ["2.39", "1.85"],
    screen: { widthM: 34.0, heightM: 13.8, bottomHeightM: 0.8, curvatureRadiusM: 74.8, tiltDeg: 1.0, maskingRatios: {}, sideProjection: false, sideLenM: null },
    auditorium: { floorProfile: "stepped", rowRiseM: 0.32, rowPitchM: 1.40, seatPitchM: 0.72, sightlineTargetM: 0.20, firstRowZM: 10.2, firstRowFloorYM: 0.0, eyeHeightM: 1.15 },
    seatProfileRows: {
      "A": "빈백", "B": "소파베드",
      "C": "스탠다드 리클라이너", "D": "스탠다드 리클라이너", "E": "스탠다드 리클라이너",
      "F": "스위트 리클라이너", "G": "스위트 리클라이너",
      "H": "스튜디오 리클라이너", "I": "스튜디오 리클라이너"
    }
  }
};
/* 공개 치수가 확인된 상영관만 CURATED에 올린다. 화면 치수만 공개된 경우에도
 * 객석 기하는 별도 추정임을 sourceNote와 좌석도 NOTE에 명시한다. */
function curatedFor(brand, key) {
  return CURATED[key] || null;
}

/* ══════════════════════════════════════════════════════════════════════
   출력 누적기
   ══════════════════════════════════════════════════════════════════════ */
const sitesOut = {};   // siteKey → { scnNo: enc }
const stats = {};

/**
 * 상영관별 출처 주기.
 * 대다수 상영관은 브랜드 공통 문구(brand.sourceNote)라서 관마다 넣으면 인덱스만 수십만 자
 * 커진다. 공통과 다른 경우(실측 큐레이션·미수집)에만 관 레코드에 적는다.
 */
const NO_ROWS_NOTE = "좌석 배치 미수집 (수집일에 상영 회차 없음) — 선택 불가";
function brandNote(brandName) {
  return "스크린·객석 치수는 좌석 배치 기반 추정 (estimateScreenGeometry). 좌석 배치는 " + brandName + " 예매 좌석도 실데이터.";
}
function noteFor(cur, hasRows) {
  if (cur) return cur.sourceNote;
  if (!hasRows) return NO_ROWS_NOTE;
  return null; // 브랜드 공통 문구를 따른다
}

/* ── CGV ─────────────────────────────────────────────────────────────── */
function buildCgv() {
  const old = readJson("raw-cgv-collected.json");
  const full = exists("raw-cgv-full.json") ? readJson("raw-cgv-full.json") : null;

  const bySite = {};
  const put = (siteNo, scnNo, rec) => { (bySite[siteNo] = bySite[siteNo] || {})[scnNo] = rec; };

  for (const [key, v] of Object.entries(old.screens)) {
    const [siteNo, scnNo] = key.split("-");
    put(siteNo, scnNo, { nm: v.nm, tot: null, kinds: v.kinds, rows: v.rows });
  }
  for (const [siteNo, list] of Object.entries(old.extraScreens)) {
    for (const [scnNo, name, tot] of list) {
      if (bySite[siteNo] && bySite[siteNo][scnNo]) { bySite[siteNo][scnNo].tot = tot; continue; }
      put(siteNo, scnNo, { nm: name, tot: tot, kinds: null, rows: null });
    }
  }
  if (full) {
    for (const [siteNo, site] of Object.entries(full.data)) {
      for (const [scnNo, v] of Object.entries(site.screens)) {
        if (v.rows) put(siteNo, scnNo, { nm: v.nm, tot: v.tot, kinds: v.kinds, rows: v.rows });
        else if (!(bySite[siteNo] && bySite[siteNo][scnNo] && bySite[siteNo][scnNo].rows))
          put(siteNo, scnNo, { nm: v.nm, tot: v.tot, kinds: null, rows: null });
      }
    }
  }

  const seatCount = rows => Object.values(rows).reduce((a, r) => a + r.split(";").length, 0);
  let nScreens = 0, nSeats = 0, nNoRows = 0;

  const regions = old.regions.map(([code, name]) => ({
    id: "r" + code,
    name,
    theaters: old.sites.filter(s => s[0] === code).map(([, siteNo, siteNm]) => {
      const scns = bySite[siteNo] || {};
      const siteName = "CGV " + siteNm;
      const screens = Object.keys(scns).sort().map(scnNo => {
        const v = scns[scnNo];
        const key = siteNo + "-" + scnNo;
        const hasRows = !!v.rows;
        const cur = curatedFor("cgv", key);
        if (hasRows) {
          (sitesOut[siteNo] = sitesOut[siteNo] || {})[scnNo] = { kinds: v.kinds, rows: v.rows };
          nScreens++; nSeats += seatCount(v.rows);
        } else nNoRows++;
        const hall = hallKindOf("cgv", v.nm, null);
        return {
          id: key,
          name: v.nm,
          totalSeats: v.tot != null ? v.tot : (hasRows ? seatCount(v.rows) : 0),
          formats: (cur && cur.formats) || formatsFor(hall),
          hall: hall,
          geometrySource: cur ? cur.geometrySource : "estimated",
          sourceNote: noteFor(cur, hasRows),
          screen: cur ? cur.screen : null,
          auditorium: cur ? cur.auditorium || null : null,
          ...(cur && cur.seatProfileRows ? { seatProfileRows: cur.seatProfileRows } : {}),
          hasRows: hasRows
        };
      });
      return { id: "s" + siteNo, siteNo, name: siteName, screens };
    })
  }));

  stats.cgv = { screens: nScreens, seats: nSeats, noRows: nNoRows };
  return { id: "cgv", name: "CGV", accent: "#d40000", sourceNote: brandNote("CGV"), regions };
}

/* ── 메가박스 ─────────────────────────────────────────────────────────── */
function buildMegabox() {
  if (!exists("raw-megabox-full.json")) return null;
  const raw = readJson("raw-megabox-full.json");
  let nScreens = 0, nSeats = 0, nNoRows = 0, nGates = 0;

  /** 메가박스 등급 코드 → 사람이 읽는 이름 (좌석 응답의 seatClassCd) */
  const CLASS_NAMES = {
    GERN_CLS: "일반석", RECLINE_CLS: "리클라이너", COMFORT_CLS: "컴포트",
    SPECIAL_CLS: "특별석", ROYAL_CLS: "로얄석", SWEET_CLS: "스위트박스",
    COUPLE_CLS: "커플석", DISABLED_CLS: "장애인석", BOUTIQUE_CLS: "부티크",
    "2P_CLS": "2인석", BALCONY_CLS: "발코니석", BALCONY2_CLS: "발코니석",
    BALCONY2P_CLS: "발코니 2인석", BALCONY3P_CLS: "발코니 3인석"
  };
  const className = cd => CLASS_NAMES[cd] || (cd ? cd.replace(/_CLS$/, "") : "일반석");
  /** gateTyCd → 방향. GTU 상(스크린쪽) · GTD 하(후방) · GTL 좌 · GTR 우,
   *  GTUD/GTLR 은 상하·좌우로 놓인 양문이라 방향을 좌표로 판정한다(side). */
  const GATE_KIND = { GTL: "left", GTR: "right", GTU: "front", GTD: "rear", GTUD: "side", GTLR: "side" };

  const regions = raw.regions.map(([code, name]) => ({
    id: "mr" + code,
    name,
    theaters: raw.sites.filter(s => s[0] === code).map(([, brchNo, brchNm]) => {
      const site = raw.data[brchNo] || { screens: {} };
      const siteKey = "mb" + brchNo;
      const siteName = "메가박스 " + brchNm;
      const screens = Object.keys(site.screens).sort().map(scnNo => {
        const v = site.screens[scnNo];
        const key = siteKey + "-" + scnNo;
        let enc = null;
        if (v.seats && v.seats.length) {
          enc = encodeGrid(
            v.seats.map(([row, num, x, y, cls, wide]) => ({
              row, num, x, y, grade: className(cls), wide: wide > 1 ? wide : null
            })),
            (v.gates || []).map(([cd, x, y]) => ({ x, y, kind: GATE_KIND[cd] || "side" }))
          );
        }
        const hasRows = !!(enc && Object.keys(enc.rows).length);
        if (hasRows) {
          (sitesOut[siteKey] = sitesOut[siteKey] || {})[scnNo] = enc;
          nScreens++; nSeats += v.seats.length; nGates += (v.gates || []).length;
        } else nNoRows++;
        const hall = hallKindOf("megabox", v.nm, null);
        const cur = curatedFor("megabox", key);
        return {
          id: key,
          name: v.nm,
          // tot 은 그 회차의 판매 가능 좌석수라 특수 판매(가족관 등)에서 실제 배치와 어긋난다.
          // 좌석도를 받았으면 좌석도가 진리원.
          totalSeats: hasRows ? v.seats.length : (v.tot || 0),
          formats: (cur && cur.formats) || formatsFor(hall),
          hall: hall,
          geometrySource: cur ? cur.geometrySource : "estimated",
          sourceNote: noteFor(cur, hasRows),
          screen: cur ? cur.screen : null,
          auditorium: cur ? cur.auditorium || null : null,
          ...(cur && cur.seatProfileRows ? { seatProfileRows: cur.seatProfileRows } : {}),
          hasRows: hasRows
        };
      });
      return { id: "s" + siteKey, siteNo: siteKey, name: siteName, screens };
    })
  }));

  stats.megabox = { screens: nScreens, seats: nSeats, noRows: nNoRows, gates: nGates };
  return { id: "megabox", name: "메가박스", accent: "#6f2c91", sourceNote: brandNote("메가박스"), regions };
}

/* ── 롯데시네마 ───────────────────────────────────────────────────────── */
function buildLotte() {
  if (!exists("raw-lotte-full.json")) return null;
  const raw = readJson("raw-lotte-full.json");
  let nScreens = 0, nSeats = 0, nNoRows = 0, nGates = 0;

  /** 상영관 구분(ScreenDivisionNameKR) → 좌석 등급 표기. 롯데는 관 단위로 좌석 사양이 갈린다. */
  function gradeOfDivision(div) {
    if (!div || /^일반$/.test(div)) return "일반석";
    return div.replace(/\(.*\)/, "").trim() || "일반석";
  }

  const regions = raw.regions.map(([code, name]) => ({
    id: "lr" + code,
    name,
    theaters: raw.cinemas.filter(c => c[0] === code).map(([, cinemaId, cinemaNm]) => {
      const site = raw.data[cinemaId] || { screens: {} };
      const siteKey = "lc" + cinemaId;
      const siteName = "롯데시네마 " + cinemaNm;
      const screens = Object.keys(site.screens).sort().map(scnNo => {
        const v = site.screens[scnNo];
        const key = siteKey + "-" + scnNo;
        const grade = gradeOfDivision(v.div);
        let enc = null;
        if (v.seats && v.seats.length) {
          enc = encodeGrid(
            v.seats.map(([row, num, x, y]) => ({ row, num, x, y, grade })),
            (v.ents || []).map(([nm, , x, y]) => ({ x, y, kind: nm === "출구" ? "exit" : "entry" }))
          );
        }
        const hasRows = !!(enc && Object.keys(enc.rows).length);
        if (hasRows) {
          (sitesOut[siteKey] = sitesOut[siteKey] || {})[scnNo] = enc;
          nScreens++; nSeats += v.seats.length; nGates += (v.ents || []).length;
        } else nNoRows++;
        const hall = hallKindOf("lotte", v.nm, v.div);
        const cur = curatedFor("lotte", key);
        const label = v.div && v.div !== "일반" ? v.nm + " [" + v.div + "]" : v.nm;
        return {
          id: key,
          name: label,
          // tot 은 그 회차의 판매 가능 좌석수라 특수 판매(가족관 등)에서 실제 배치와 어긋난다.
          // 좌석도를 받았으면 좌석도가 진리원.
          totalSeats: hasRows ? v.seats.length : (v.tot || 0),
          formats: (cur && cur.formats) || formatsFor(hall),
          hall: hall,
          geometrySource: cur ? cur.geometrySource : "estimated",
          sourceNote: noteFor(cur, hasRows),
          screen: cur ? cur.screen : null,
          auditorium: cur ? cur.auditorium || null : null,
          ...(cur && cur.seatProfileRows ? { seatProfileRows: cur.seatProfileRows } : {}),
          hasRows: hasRows
        };
      });
      return { id: "s" + siteKey, siteNo: siteKey, name: siteName, screens };
    })
  }));

  stats.lotte = { screens: nScreens, seats: nSeats, noRows: nNoRows, gates: nGates };
  return { id: "lotte", name: "롯데시네마", accent: "#e4002b", sourceNote: brandNote("롯데시네마"), regions };
}

/* ══════════════════════════════════════════════════════════════════════
   실행
   ══════════════════════════════════════════════════════════════════════ */
const brands = [buildCgv(), buildMegabox(), buildLotte()].filter(Boolean);

const sources = ["raw-cgv-collected.json + raw-cgv-full.json"];
if (exists("raw-megabox-full.json")) sources.push("raw-megabox-full.json (" + readJson("raw-megabox-full.json").collectedAt + ")");
if (exists("raw-lotte-full.json")) sources.push("raw-lotte-full.json (" + readJson("raw-lotte-full.json").collectedAt + ")");

const index = {
  schemaVersion: 3,
  generatedFrom: sources.join(" · "),
  note: "좌석 데이터는 data/sites/{siteNo}.js 로 분리 (지연 로딩). 인코딩 해석: src/data/layout.js",
  unitM: 0.28,
  brands
};

fs.writeFileSync(dataDir("theaters.json"), JSON.stringify(index, null, 1), "utf8");

const sitesDir = dataDir("sites");
fs.mkdirSync(sitesDir, { recursive: true });
for (const f of fs.readdirSync(sitesDir)) fs.unlinkSync(path.join(sitesDir, f));
for (const [siteKey, scns] of Object.entries(sitesOut)) {
  const js = "/* 자동 생성 — node tools/import-raw.js */\n" +
    "window.SITE_SEATS = window.SITE_SEATS || {};\n" +
    "window.SITE_SEATS[" + JSON.stringify(siteKey) + "] = " + JSON.stringify(scns) + ";\n";
  fs.writeFileSync(path.join(sitesDir, siteKey + ".js"), js, "utf8");
}

for (const b of brands) {
  const s = stats[b.id];
  const nTheaters = b.regions.reduce((a, r) => a + r.theaters.length, 0);
  console.log(b.name.padEnd(6) + " 지역 " + b.regions.length + " · 극장 " + nTheaters +
    " · 배치 수집 " + s.screens + "관 (" + s.seats.toLocaleString() + "석)" +
    (s.gates != null ? " · 출입구 " + s.gates : "") + " · 미수집 " + s.noRows);
}
console.log("sites/*.js: " + Object.keys(sitesOut).length + "개 파일");
