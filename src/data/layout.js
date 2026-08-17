/**
 * src/data/layout.js — 좌석 인코딩 해석 + 좌석번호(그리드) → 3차원 미터 좌표 변환기
 *
 * 좌석 데이터는 data/sites/{siteNo}.js 가 지연 로딩되어 window.SITE_SEATS 에 들어온다.
 * 인코딩: "n,x,y[,wWhH][,k등급코드][,L][,R]" 세미콜론 구분 (예매 좌석도 그리드 단위).
 * 출입구가 수집된 상영관은 같은 그리드계의 gates: ["gx,gy,종류"] 를 함께 갖는다
 * (메가박스 gateTyCd · 롯데시네마 Enterences. CGV 는 좌표 미공개라 없다).
 * 이 모듈이 디코딩·미터 변환·z/바닥높이 계산을 모두 담당한다 (단일 구현).
 */
(function () {
  "use strict";

  /** 통로 폭 기본값 (m). CGV 그리드에서 통로는 대개 4단위 ≈ 1.12 m */
  var AISLE_WIDTH_M = 1.1;
  /** 1 그리드단위 (m) = 일반석 좌우 피치 0.56 m 의 절반 */
  var UNIT_M = 0.28;

  function decodeRowStr(str) {
    return str.split(";").map(function (tok) {
      var p = tok.split(",");
      var s = { n: +p[0], gx: +p[1], gy: +p[2], gw: 2, gh: 2, knd: "01", L: false, R: false };
      for (var i = 3; i < p.length; i++) {
        if (p[i] === "L") s.L = true;
        else if (p[i] === "R") s.R = true;
        else if (p[i][0] === "k") s.knd = p[i].slice(1);
        else if (p[i][0] === "w") { var m = p[i].match(/^w(\d+)h(\d+)$/); if (m) { s.gw = +m[1]; s.gh = +m[2]; } }
      }
      return s;
    });
  }

  /**
   * 인덱스 레코드 + 인코딩된 좌석 데이터 → 완전한 레이아웃.
   * @param {Object} screenRec  theaters.js 인덱스의 상영관 레코드 (name, screen, auditorium, geometrySource…)
   * @param {Object} enc        SITE_SEATS[siteNo][scnNo] = { kinds, rows: {label: "인코딩"} }
   * @returns {{screen, auditorium, seats, byId, rows, grid}}
   */
  function buildLayout(screenRec, enc) {
    var kinds = enc.kinds || {};
    // 열을 y 오름차순(스크린 가까운 열부터)으로 정리
    var rows = Object.keys(enc.rows).map(function (label) {
      var seats = decodeRowStr(enc.rows[label]).sort(function (a, b) { return a.gx - b.gx; });
      return { label: label, gy: Math.min.apply(null, seats.map(function (s) { return s.gy; })), seats: seats };
    }).sort(function (a, b) { return a.gy - b.gy; });

    // 그리드 범위·중심
    var minX = Infinity, maxX = -Infinity, maxY = 0, minGy = Infinity;
    rows.forEach(function (r) {
      minGy = Math.min(minGy, r.gy);
      r.seats.forEach(function (s) {
        minX = Math.min(minX, s.gx); maxX = Math.max(maxX, s.gx + s.gw); maxY = Math.max(maxY, s.gy + s.gh);
      });
    });
    var cx = (minX + maxX) / 2;
    var grid = { minX: minX, maxX: maxX, maxY: maxY, unitM: UNIT_M };

    // 기하: 실측(인덱스에 명시)이 없으면 명시적 추정
    var screen = screenRec.screen, auditorium = screenRec.auditorium;
    if (!screen || !auditorium) {
      var est = window.estimateScreenGeometry({
        name: screenRec.name,
        hall: screenRec.hall || null,
        grid: grid,
        nRows: rows.length,
        gradeNames: Object.values(kinds)
      });
      screen = screen || est.screen;
      auditorium = auditorium || est.auditorium;
    }

    var nRows = rows.length;
    var seats = [], byId = {};
    var outRows = rows.map(function (row, ri) {
      // 그리드 y 는 2단위 = 1열
      var rowIndex = Math.round((row.gy - minGy) / 2);
      var zM = auditorium.firstRowZM + rowIndex * auditorium.rowPitchM;
      var floorYM = auditorium.floorProfile === "flat"
        ? auditorium.firstRowFloorYM
        : auditorium.firstRowFloorYM + rowIndex * auditorium.rowRiseM;
      var section = ri < nRows * 0.25 ? "front" : ri >= nRows * 0.75 ? "rear" : "center";
      var outSeats = row.seats.map(function (s) {
        var xM = +(((s.gx + s.gw / 2) - cx) * UNIT_M).toFixed(3);
        var spec = {
          id: row.label + s.n,
          rowLabel: row.label, colNumber: s.n,
          xM: xM, zM: +zM.toFixed(3), floorYM: +floorYM.toFixed(3),
          section: section,
          grade: kinds[s.knd] || "일반석",
          aisleAfter: s.R,
          rowIndex: rowIndex,
          gx: s.gx, gy: s.gy, gw: s.gw, gh: s.gh
        };
        seats.push(spec);
        byId[spec.id] = spec;
        return spec;
      });
      return { label: row.label, gy: row.gy, seats: outSeats };
    });

    return {
      screen: screen, auditorium: auditorium, seats: seats, byId: byId, rows: outRows, grid: grid,
      exits: decodeGates(enc.gates, auditorium, cx, minGy, maxY, nRows)
    };
  }

  /**
   * 수집된 출입구 좌표 → 미터 좌표 + 위치 분류.
   *
   * 인코딩의 종류 코드(메가박스 gateTyCd 등)는 유도표지 화살표 방향이지 벽면이 아니다
   * (같은 오른쪽 벽의 두 문이 GTR·GTL 로 나뉜다). 그래서 어느 벽·어느 구역인지는
   * 좌석 블록 대비 좌표로 판정하고, 원래 코드는 kind 로 보존만 한다.
   *
   * @returns {Array|null} [{xM, zM, floorYM, side:"left"|"right"|"center", zone:"front"|"mid"|"rear", kind}]
   */
  function decodeGates(gates, auditorium, cx, minGy, maxY, nRows) {
    if (!gates || !gates.length) return null;
    var lastGy = maxY - 2; // 마지막 열의 gy
    return gates.map(function (token) {
      var p = String(token).split(",");
      var gxv = +p[0], gyv = +p[1], kind = p[2] || "gate";
      var rowIndex = (gyv - minGy) / 2;
      var xM = +(((gxv + 1) - cx) * UNIT_M).toFixed(3);
      var zM = +(auditorium.firstRowZM + rowIndex * auditorium.rowPitchM).toFixed(3);
      // 바닥 높이는 객석 범위로 자른 열 위치에서 취한다 (전·후방 문은 최전·최후열 바닥)
      var clamped = Math.max(0, Math.min(nRows - 1, Math.round(rowIndex)));
      var floorYM = auditorium.floorProfile === "flat"
        ? auditorium.firstRowFloorYM
        : auditorium.firstRowFloorYM + clamped * auditorium.rowRiseM;
      return {
        xM: xM, zM: zM, floorYM: +floorYM.toFixed(3),
        gx: gxv, gy: gyv,                       // 좌석도(평면) 표기용 원 그리드 좌표
        side: xM < -0.8 ? "left" : xM > 0.8 ? "right" : "center",
        zone: gyv < minGy ? "front" : gyv > lastGy ? "rear" : "mid",
        kind: kind
      };
    });
  }

  /** 방향키 이동: 현재 좌석에서 해당 방향의 가장 가까운 좌석 (up = 스크린 쪽) */
  function findNeighbor(layout, seat, dir) {
    var best = null, bestCost = Infinity;
    layout.seats.forEach(function (s) {
      if (s === seat) return;
      var ddx = s.xM - seat.xM, ddz = s.zM - seat.zM;
      var cost;
      if (dir === "left" || dir === "right") {
        if (s.rowIndex !== seat.rowIndex) return;
        if (dir === "left" ? ddx >= 0 : ddx <= 0) return;
        cost = Math.abs(ddx);
      } else {
        if (dir === "up" ? ddz >= 0 : ddz <= 0) return;
        cost = Math.abs(ddz) * 10 + Math.abs(ddx);
      }
      if (cost < bestCost) { bestCost = cost; best = s; }
    });
    return best;
  }

  window.SeatLayout = {
    AISLE_WIDTH_M: AISLE_WIDTH_M,
    UNIT_M: UNIT_M,
    decodeRowStr: decodeRowStr,
    decodeGates: decodeGates,
    buildLayout: buildLayout,
    findNeighbor: findNeighbor
  };
})();
