/**
 * src/data/estimate.js — 스크린·객석 기하 명시적 추정기
 *
 * 세 사업자(CGV·메가박스·롯데시네마) 모두 상영관 실측 치수를 대체로 공개하지 않는다.
 * 실측치가 없는 상영관(인덱스의 screen/auditorium 이 null, geometrySource === "estimated")은
 * 좌석 배치(열 수·좌석 수·그리드 폭)와 특별관 종류로부터 이 함수가 기하를 추정한다.
 * 추정값은 UI 에 "추정" 으로 표기된다. 추측을 실측인 척 하지 않는다.
 *
 * 추정 근거(모든 상수는 국내 멀티플렉스 통상 범위):
 *  - 1 그리드단위 = 0.28 m (좌석 피치 0.56 m 의 절반, layout.js 와 동일)
 *  - 스크린 폭 = 객석 최대 폭 × 계수. 계수는 특별관 종류별로 다르다(HALL 표):
 *    일반관 0.85(벽·통로 여유) · IMAX 1.05(객석보다 넓다) · SCREENX 0.95(좌우 벽 투사가 이어진다)
 *    수퍼플렉스 1.02 · 돌비시네마 0.95 · LED 0.72(패널 규격이 객석 폭을 따라가지 않는다)
 *  - 스크린 물리 종횡비: IMAX 디지털 1.90 · LED(삼성 Onyx 계열) 1.78 · 그 외 2.35(스코프 마스킹 기준)
 *  - 최전열 거리 = 스크린 폭 × 계수. IMAX·수퍼플렉스는 의도적으로 가깝다.
 *  - 열 피치: 일반 1.05 / IMAX·수퍼플렉스 1.15 / 컴포트 1.2 / 4DX 1.1 / 리클라이너 1.4 /
 *    부티크(샤롯데·부티크스위트) 1.5 m
 *  - SCREENX 측면 투사: 정면 스크린 좌우 모서리에서 객석 쪽으로 이어지는 벽면,
 *    길이 ≈ 객석 깊이 × 0.7 (실제 ScreenX 는 객석 측벽의 약 2/3 를 사용)
 *  - 단차(rowRiseM)는 상수가 아니라 시야선 기준(C-value)으로 역산한다 — 아래 주석 참조.
 */
(function () {
  "use strict";

  /**
   * 특별관 종류별 계수. hall 값은 tools/import-raw.js 의 hallKindOf() 가 상영관 이름·구분에서 뽑는다.
   *   widthRt   스크린 폭 / 객석 최대 폭
   *   aspect    스크린 물리 종횡비
   *   zRt       최전열 거리 / 스크린 폭
   *   pitch     열 피치 (m)
   *   curveRt   곡률 반경 / 스크린 폭 (null 이면 평면)
   *   tilt      스크린 기울기 (도)
   */
  var HALL = {
    imax:      { widthRt: 1.05, aspect: 1.90, zRt: 0.28, pitch: 1.15, curveRt: 1.8,  tilt: 2 },
    screenx:   { widthRt: 0.95, aspect: 2.35, zRt: 0.42, pitch: 1.10, curveRt: null, tilt: 0 },
    superplex: { widthRt: 1.02, aspect: 2.35, zRt: 0.30, pitch: 1.15, curveRt: 2.2,  tilt: 1 },
    dolby:     { widthRt: 0.95, aspect: 2.39, zRt: 0.38, pitch: 1.20, curveRt: null, tilt: 0 },
    premium:   { widthRt: 0.92, aspect: 2.35, zRt: 0.40, pitch: 1.15, curveRt: null, tilt: 0 },
    led:       { widthRt: 0.88, aspect: 1.78, zRt: 0.50, pitch: 1.15, curveRt: null, tilt: 0 },
    "4dx":     { widthRt: 0.85, aspect: 2.35, zRt: 0.42, pitch: 1.10, curveRt: null, tilt: 0 },
    boutique:  { widthRt: 0.80, aspect: 2.35, zRt: 0.50, pitch: 1.50, curveRt: null, tilt: 0 },
    recliner:  { widthRt: 0.85, aspect: 2.35, zRt: 0.45, pitch: 1.40, curveRt: null, tilt: 0 },
    comfort:   { widthRt: 0.85, aspect: 2.35, zRt: 0.42, pitch: 1.20, curveRt: null, tilt: 0 }
  };
  var DEFAULT_HALL = { widthRt: 0.85, aspect: 2.35, zRt: 0.42, pitch: 1.05, curveRt: null, tilt: 0 };

  /**
   * @param {Object} meta { name, hall, grid:{minX,maxX,unitM}, nRows, gradeNames:[] }
   * @returns {{screen:Object, auditorium:Object}}
   */
  function estimateScreenGeometry(meta) {
    var name = meta.name || "";
    var grades = meta.gradeNames || [];
    // hall 힌트가 없는 옛 데이터도 동작하도록 이름에서 한 번 더 찾는다.
    var hall = meta.hall ||
      (/IMAX/i.test(name) ? "imax" :
       /SCREENX/i.test(name) ? "screenx" :
       /4DX/i.test(name) ? "4dx" :
       grades.some(function (k) { return /리클라이너/.test(k); }) ? "recliner" :
       grades.some(function (k) { return /컴포트/.test(k); }) ? "comfort" : null);
    var H = HALL[hall] || DEFAULT_HALL;
    var isScreenX = hall === "screenx";

    var g = meta.grid;
    var rowWidthM = (g.maxX - g.minX) * g.unitM;
    var nRows = meta.nRows;

    var widthM = rowWidthM * H.widthRt;
    // 하한 4.5 m: 8~30석짜리 부티크·스위트관까지 다루므로 예전 7 m 하한은 소형관을 왜곡했다.
    widthM = Math.max(4.5, Math.min(hall === "imax" || hall === "superplex" ? 34 : 26, widthM));
    var heightM = Math.max(2.4, Math.min(16, widthM / H.aspect));

    var rowPitchM = H.pitch;
    // 좌석 등급이 관 이름보다 구체적일 때가 있다 (일반관 안의 리클라이너 구역 등)
    if (grades.some(function (k) { return /리클라이너/.test(k); })) rowPitchM = Math.max(rowPitchM, 1.40);
    else if (grades.some(function (k) { return /컴포트/.test(k); })) rowPitchM = Math.max(rowPitchM, 1.20);

    var floorProfile = (rowPitchM >= 1.4 && nRows <= 6) ? "sloped" : "stepped";

    var firstRowZM = Math.max(hall === "imax" ? 5.0 : 3.5, widthM * H.zRt);
    var hallDepthM = firstRowZM + nRows * rowPitchM;
    var bottomHeightM = hall === "imax" ? 0.9 : 0.8;

    /* 단차(rowRiseM): 고정 상수가 아니라 극장 설계 표준인 시야선 기준(C-value)으로 역산.
     * 조건: 눈(+1.15 m)에서 스크린 하단(z=0, y=bottomHeight)으로 가는 시선이
     *       두 열 앞 관객의 머리끝(+1.25 m)보다 C=0.12 m 위를 지나야 한다.
     *       (두 열 앞인 이유: 국내 멀티플렉스 좌석은 엇배열이라 바로 앞머리 사이로 본다)
     * 유도: 2r ≥ 0.1 + C + (i·r + 1.15 − sb) · 2p/(z0 + i·p)
     * 평가 열: 중간 열(i=N/2). 실제 설계도 중간 객석 기준으로 잡고 최후열은 약간
     * 타협한다(최후열 기준이면 스타디움이 비현실적으로 가팔라진다).
     * r 이 양변에 있으므로 고정점 반복으로 수렴시킨다. */
    var rowRiseM = 0.30;
    if (floorProfile === "sloped") {
      rowRiseM = 0.25;
    } else {
      var C = 0.12, i = Math.max(1, Math.round(nRows / 2)), p = rowPitchM, z0 = firstRowZM;
      for (var it = 0; it < 20; it++) {
        var need = 0.5 * (0.1 + C + (i * rowRiseM + 1.15 - bottomHeightM) * (2 * p) / (z0 + i * p));
        rowRiseM = Math.max(0.26, Math.min(0.45, need));
      }
      rowRiseM = +rowRiseM.toFixed(3);
    }

    return {
      screen: {
        widthM: +widthM.toFixed(2),
        heightM: +heightM.toFixed(2),
        bottomHeightM: bottomHeightM,
        curvatureRadiusM: H.curveRt ? +(widthM * H.curveRt).toFixed(1) : null,
        tiltDeg: H.tilt,
        maskingRatios: {},
        sideProjection: isScreenX,                                 // SCREENX: 좌우 벽면 투사
        sideLenM: isScreenX ? +(hallDepthM * 0.7).toFixed(1) : null // 측면 투사 길이 (객석 깊이의 70%)
      },
      auditorium: {
        floorProfile: floorProfile,
        rowRiseM: rowRiseM,
        rowPitchM: rowPitchM,
        seatPitchM: 0.56,
        firstRowZM: +firstRowZM.toFixed(2),
        firstRowFloorYM: 0.0,
        eyeHeightM: 1.15
      }
    };
  }

  window.estimateScreenGeometry = estimateScreenGeometry;
})();
