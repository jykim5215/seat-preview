/**
 * src/data/layout.js — 좌석번호(그리드) → 3차원 미터 좌표 변환기
 *
 * theaters.json 좌석의 xM 은 임포트 시 확정(통로 반영 실제 그리드 기반).
 * 이 모듈은 열 방향(z)·바닥 높이(floorY)를 auditorium 파라미터로 계산해
 * 렌더러·계측이 쓰는 SeatSpec 배열을 만든다.
 */
(function () {
  "use strict";

  /** 통로 폭 기본값 (m). CGV 그리드에서 통로는 대개 4단위 ≈ 1.12 m */
  var AISLE_WIDTH_M = 1.1;

  /**
   * 상영관 레코드 → 완전한 SeatSpec 배열.
   * screen/auditorium 이 null 이면 estimateScreenGeometry() 로 채운 뒤 사용.
   * @returns {{screen:Object, auditorium:Object, seats:Array, byId:Object, rows:Array}}
   */
  function buildLayout(screenRec) {
    var screen = screenRec.screen, auditorium = screenRec.auditorium;
    if (!screen || !auditorium) {
      var est = window.estimateScreenGeometry(screenRec);
      screen = screen || est.screen;
      auditorium = auditorium || est.auditorium;
    }

    var minGy = Infinity;
    screenRec.rows.forEach(function (r) { minGy = Math.min(minGy, r.gy); });

    var nRows = screenRec.rows.length;
    var seats = [], byId = {};
    screenRec.rows.forEach(function (row, ri) {
      // 그리드 y 는 2단위 = 1열. 열 인덱스는 (gy - minGy)/2
      var rowIndex = Math.round((row.gy - minGy) / 2);
      var zM = auditorium.firstRowZM + rowIndex * auditorium.rowPitchM;
      var floorYM = auditorium.floorProfile === "flat"
        ? auditorium.firstRowFloorYM
        : auditorium.firstRowFloorYM + rowIndex * auditorium.rowRiseM;
      // 섹션 구분: 앞 25% front / 뒤 25% rear / 나머지 center
      var section = ri < nRows * 0.25 ? "front" : ri >= nRows * 0.75 ? "rear" : "center";
      row.seats.forEach(function (s) {
        var spec = {
          id: row.label + s.n,
          rowLabel: row.label,
          colNumber: s.n,
          xM: s.xM,
          zM: +zM.toFixed(3),
          floorYM: +floorYM.toFixed(3),
          section: section,
          grade: s.grade,
          aisleAfter: !!s.aisleAfter,
          rowIndex: rowIndex
        };
        seats.push(spec);
        byId[spec.id] = spec;
      });
    });

    return { screen: screen, auditorium: auditorium, seats: seats, byId: byId, rows: screenRec.rows };
  }

  /** 방향키 이동: 현재 좌석에서 dx(좌우)/dz(앞뒤) 방향의 가장 가까운 좌석 */
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
        if (dir === "up" ? ddz >= 0 : ddz <= 0) return; // up = 스크린 쪽(앞열)
        cost = Math.abs(ddz) * 10 + Math.abs(ddx);
      }
      if (cost < bestCost) { bestCost = cost; best = s; }
    });
    return best;
  }

  window.SeatLayout = {
    AISLE_WIDTH_M: AISLE_WIDTH_M,
    buildLayout: buildLayout,
    findNeighbor: findNeighbor
  };
})();
