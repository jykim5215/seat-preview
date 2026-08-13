/**
 * src/data/estimate.js — 스크린·객석 기하 명시적 추정기
 *
 * CGV 는 상영관 실측 치수를 공개하지 않는다. 실측치가 없는 상영관
 * (인덱스의 screen/auditorium 이 null, geometrySource === "estimated")은
 * 좌석 배치(열 수·좌석 수·그리드 폭)로부터 이 함수가 기하를 추정한다.
 * 추정값은 UI 에 "추정" 으로 표기된다. 추측을 실측인 척 하지 않는다.
 *
 * 추정 근거(모든 상수는 국내 멀티플렉스 통상 범위):
 *  - 1 그리드단위 = 0.28 m (좌석 피치 0.56 m 의 절반, layout.js 와 동일)
 *  - 일반관 스크린 폭 ≈ 객석 최대 폭 × 0.85 (벽·통로 여유), IMAX ≈ ×1.05 (객석보다 넓음),
 *    SCREENX 정면 스크린 ≈ ×0.95 (좌우 벽면 투사가 이어지므로 객석 폭에 가깝게)
 *  - 스크린 물리 종횡비: IMAX 디지털 1.90, 일반관 2.35(스코프 마스킹 기준)
 *  - 최전열 거리: 일반관 ≈ 스크린 폭 × 0.42, IMAX ≈ × 0.28 (IMAX 는 의도적으로 가깝다)
 *  - 열 피치: 일반 1.05 / IMAX 1.15 / 컴포트 1.2 / 4DX 1.1 / 리클라이너 1.4 m
 *  - 열 단차: 일반 0.30 / IMAX 0.42 / 4DX 0.35 m (stepped)
 *  - SCREENX 측면 투사: 정면 스크린 좌우 모서리에서 객석 쪽으로 이어지는 벽면,
 *    길이 ≈ 마지막 열 거리 × 0.7 (실제 ScreenX 는 객석 측벽의 약 2/3 를 사용)
 */
(function () {
  "use strict";

  /**
   * @param {Object} meta { name, grid:{minX,maxX,unitM}, nRows, gradeNames:[] }
   * @returns {{screen:Object, auditorium:Object}}
   */
  function estimateScreenGeometry(meta) {
    var name = meta.name || "";
    var isImax = /IMAX/i.test(name);
    var is4dx = /4DX/i.test(name);
    var isScreenX = /SCREENX/i.test(name);
    var grades = meta.gradeNames || [];
    var isRecliner = grades.some(function (k) { return /리클라이너/.test(k); });
    var isComfort = grades.some(function (k) { return /컴포트/.test(k); });

    var g = meta.grid;
    var rowWidthM = (g.maxX - g.minX) * g.unitM;
    var nRows = meta.nRows;

    var widthM = rowWidthM * (isImax ? 1.05 : isScreenX ? 0.95 : 0.85);
    widthM = Math.max(7, Math.min(26, widthM));
    var aspect = isImax ? 1.90 : 2.35;
    var heightM = Math.max(3.5, Math.min(14, widthM / aspect));

    var rowPitchM = isRecliner ? 1.40 : isComfort ? 1.20 : isImax ? 1.15 : is4dx ? 1.10 : 1.05;
    var rowRiseM = isImax ? 0.42 : is4dx ? 0.35 : 0.30;
    var floorProfile = (isRecliner && nRows <= 6) ? "sloped" : "stepped";
    if (floorProfile === "sloped") rowRiseM = 0.25;

    var firstRowZM = Math.max(isImax ? 5.0 : 3.5, widthM * (isImax ? 0.28 : 0.42));
    var hallDepthM = firstRowZM + nRows * rowPitchM;

    return {
      screen: {
        widthM: +widthM.toFixed(2),
        heightM: +heightM.toFixed(2),
        bottomHeightM: isImax ? 0.9 : 0.8,
        curvatureRadiusM: isImax ? widthM * 0.85 : null, // IMAX 는 완만한 곡면 (근거: IMAX 시방 관행)
        tiltDeg: isImax ? 2 : 0,
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
