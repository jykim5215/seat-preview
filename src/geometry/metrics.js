/**
 * src/geometry/metrics.js — 시야 계측의 단일 진리원(single source of truth)
 *
 * 좌표계 (전 프로젝트 공통):
 *  단위 m, 오른손 좌표계. 원점 = 스크린 하단 중앙이 최전열 바닥 레벨에 투영된 지점.
 *  +X = 관객 기준 오른쪽, +Y = 위, +Z = 스크린 → 관객석 방향 (좌석은 z > 0).
 *
 * 렌더러와 계측 패널은 반드시 이 파일의 함수만 사용한다. (이중 구현 금지)
 * 클래식 스크립트 — 전역 window.SeatMetrics 로 노출.
 */
(function () {
  "use strict";

  var DEG = 180 / Math.PI;

  /** 포맷 문자열 → 화면비 (가로/세로). 근거: IMAX 필름/디지털 풀프레임 1.43,
   *  IMAX 디지털 1.90, 스코프 2.39, 플랫 1.85 */
  var FORMAT_RATIOS = { "IMAX 1.43": 1.43, "IMAX 1.90": 1.90, "2.39": 2.39, "1.85": 1.85, "SCREENX": 2.39 };

  /**
   * 화면비 마스킹 후 실제 점등(영상) 영역.
   * 규칙: 스크린 유효 영역(widthM×heightM) 안에서 목표 화면비의 최대 내접 사각형,
   *       스크린 중앙 기준. screen.maskingRatios 에 명시값이 있으면 그것을 우선.
   * @returns {{w:number,h:number,centerY:number}} w/h: 점등 폭·높이(m),
   *          centerY: 점등 중심의 바닥 기준 높이(m)
   */
  function litArea(screen, format) {
    var ratio = FORMAT_RATIOS[format] || 1.85;
    var key = format.replace("IMAX ", "");
    var w, h, offY = 0;
    var mr = screen.maskingRatios && screen.maskingRatios[key];
    if (mr && mr.widthRatio) {
      w = screen.widthM * mr.widthRatio;
      h = screen.heightM * mr.heightRatio;
      offY = screen.heightM * (mr.offsetYRatio || 0);
    } else {
      var screenAspect = screen.widthM / screen.heightM;
      if (ratio >= screenAspect) { w = screen.widthM; h = w / ratio; }   // 위아래 마스킹
      else { h = screen.heightM; w = h * ratio; }                        // 좌우 마스킹
    }
    return { w: w, h: h, centerY: screen.bottomHeightM + screen.heightM / 2 + offY };
  }

  /**
   * 곡면 스크린 위 x 위치의 z 오프셋(관객 쪽 +).
   * 모델: 수직축 실린더 섹션, 곡률 중심이 관객 쪽(z=+R). 중앙 z=0, 가장자리 z>0.
   * 평면(curvatureRadiusM=null)이면 0.
   */
  function curveZ(screen, x) {
    var R = screen.curvatureRadiusM;
    if (!R) return 0;
    var c = Math.min(Math.abs(x), R * 0.999);
    return R - Math.sqrt(R * R - c * c);
  }

  /** 점등 영역의 3D 기준점들 (기울기 tiltDeg 반영: 하단 모서리 축, 상단이 +z 로) */
  function litPoints(screen, format) {
    var lit = litArea(screen, format);
    var tilt = (screen.tiltDeg || 0) / DEG;
    var yBot = lit.centerY - lit.h / 2, yTop = lit.centerY + lit.h / 2;
    // 기울기: 스크린 하단(bottomHeightM) 기준 높이에 비례해 z 가 +쪽으로 이동
    function tz(y) { return Math.sin(tilt) * (y - screen.bottomHeightM); }
    var zc = curveZ(screen, 0), ze = curveZ(screen, lit.w / 2);
    return {
      lit: lit,
      center: { x: 0, y: lit.centerY, z: zc + tz(lit.centerY) },
      left:   { x: -lit.w / 2, y: lit.centerY, z: ze + tz(lit.centerY) },
      right:  { x: +lit.w / 2, y: lit.centerY, z: ze + tz(lit.centerY) },
      top:    { x: 0, y: yTop, z: zc + tz(yTop) },
      bottom: { x: 0, y: yBot, z: zc + tz(yBot) }
    };
  }

  /** 착석 눈 위치 (m): 카메라 위치와 동일해야 한다 */
  function eyePosition(seat, auditorium) {
    return { x: seat.xM, y: seat.floorYM + auditorium.eyeHeightM, z: seat.zM };
  }

  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function len(v) { return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }
  function angleBetween(a, b) { // 두 벡터 사이 각 (도)
    var d = (a.x * b.x + a.y * b.y + a.z * b.z) / (len(a) * len(b));
    return Math.acos(Math.max(-1, Math.min(1, d))) * DEG;
  }

  /**
   * 7개 계측값 계산.
   * @param {Object} screen   §3.2 ScreenSpec
   * @param {Object} auditorium AuditoriumSpec (eyeHeightM 사용)
   * @param {Object} seat     SeatSpec (xM, zM, floorYM)
   * @param {string} format   "IMAX 1.43" | "IMAX 1.90" | "2.39" | "1.85"
   */
  function compute(screen, auditorium, seat, format) {
    var P = litPoints(screen, format);
    var E = eyePosition(seat, auditorium);

    // 1) 스크린까지 거리: 눈 → 점등 영역 중심 직선거리 (m)
    var toCenter = sub(P.center, E);
    var distance = len(toCenter);

    // 2) 수평 시야각: 점등 좌·우 끝을 잇는 각을 수평면(XZ)에 투영해 계산 (도)
    //    기준선: THX 권장 36° 이상, SMPTE 30° 이상
    var vl = sub(P.left, E), vr = sub(P.right, E);
    var hFov = angleBetween({ x: vl.x, y: 0, z: vl.z }, { x: vr.x, y: 0, z: vr.z });

    // 3) 수직 시야각: 점등 상·하단 중앙을 잇는 각 (도, 3D)
    var vFov = angleBetween(sub(P.top, E), sub(P.bottom, E));

    // 4) 시선 올림각: 점등 상단까지의 앙각 (도). 35° 초과 시 목 부담 경고
    var vt = sub(P.top, E);
    var elevation = Math.atan2(vt.y, Math.sqrt(vt.x * vt.x + vt.z * vt.z)) * DEG;

    // 5) 좌우 이탈각: 점등 중심 법선(+Z, 곡면은 현의 법선)에서 눈이 벗어난 각 (도).
    //    15° 초과 시 사다리꼴 왜곡 경고
    var offAxis = Math.atan2(Math.abs(E.x - P.center.x), Math.max(0.01, E.z - P.center.z)) * DEG;

    // 6) 화면 채움률: 시야에서 점등 영역이 차지하는 입체각 비율.
    //    근사 Ω ≈ hFov × vFov (rad², 소각 근사), 기준 시야 = 전방 반구 2π sr
    var omega = (hFov / DEG) * (vFov / DEG);
    var fill = Math.min(1, omega / (2 * Math.PI));

    // SCREENX: 좌우 벽면 투사가 만드는 랩(wrap) 각 — 정면 스크린 모서리에서
    // 객석 쪽으로 이어지는 측면 투사면 끝점 기준. 표시용 부가 지표 (등급에는 미반영:
    // 주변시 몰입이지 정면 화질이 아니므로 정면 점등 영역 기준 지표를 유지한다)
    var sideWrapDeg = null;
    if (format === "SCREENX" && screen.sideProjection) {
      var sideLen = screen.sideLenM || 12;
      var zEnd = Math.min(sideLen, Math.max(0.5, E.z - 0.5));
      var wl = sub({ x: -screen.widthM / 2, y: P.center.y, z: zEnd }, E);
      var wr = sub({ x: +screen.widthM / 2, y: P.center.y, z: zEnd }, E);
      sideWrapDeg = angleBetween({ x: wl.x, y: 0, z: wl.z }, { x: wr.x, y: 0, z: wr.z });
      // 좌석이 투사면보다 뒤에 있으면 벽 끝점이 시야 앞쪽 — wrap 은 최소한 정면 화각 이상
      sideWrapDeg = Math.max(sideWrapDeg, hFov);
    }

    // 7) 종합 등급: 아래 gradeOf() — 수식·가중치는 함수 주석 참조
    var g = gradeOf(hFov, elevation, offAxis);

    return {
      sideWrapDeg: sideWrapDeg,
      distance: distance, hFov: hFov, vFov: vFov,
      elevation: elevation, offAxis: offAxis, fill: fill,
      score: g.score, grade: g.grade,
      warnings: {
        neck: elevation > 35,        // 목 부담
        keystone: offAxis > 15,      // 사다리꼴 왜곡
        thx: hFov >= 36, smpte: hFov >= 30
      },
      lit: P.lit
    };
  }

  /**
   * 종합 등급 산정.
   * score = 0.4·fH(수평시야각) + 0.3·fE(올림각) + 0.3·fO(이탈각)  ∈ [0,1]
   *  - fH: THX 36° 이상을 상급으로 보되 75° 초과(최전열급)는 과대 시야로 감점.
   *        20°↓:0.2 / 20~30°:0.2→0.6 / 30~36°:0.6→0.9 / 36~55°:0.9→1.0 /
   *        55~75°:1.0→0.7 / 75°↑:0.7→0.3(90°에서)
   *  - fE: 20°↓:1.0 / 20~35°:1.0→0.6 / 35~60°:0.6→0.2
   *  - fO: 5°↓:1.0 / 5~15°:1.0→0.7 / 15~30°:0.7→0.3
   * 등급 컷: S≥0.90, A≥0.78, B≥0.62, C≥0.45, D 그 외 (5단계)
   */
  function gradeOf(hFov, elevation, offAxis) {
    function lerp(x, x0, x1, y0, y1) { return y0 + (y1 - y0) * Math.max(0, Math.min(1, (x - x0) / (x1 - x0))); }
    var fH;
    if (hFov < 20) fH = 0.2;
    else if (hFov < 30) fH = lerp(hFov, 20, 30, 0.2, 0.6);
    else if (hFov < 36) fH = lerp(hFov, 30, 36, 0.6, 0.9);
    else if (hFov < 55) fH = lerp(hFov, 36, 55, 0.9, 1.0);
    else if (hFov < 75) fH = lerp(hFov, 55, 75, 1.0, 0.7);
    else fH = lerp(hFov, 75, 90, 0.7, 0.3);
    var fE = elevation < 20 ? 1.0 : (elevation < 35 ? lerp(elevation, 20, 35, 1.0, 0.6) : lerp(elevation, 35, 60, 0.6, 0.2));
    var fO = offAxis < 5 ? 1.0 : (offAxis < 15 ? lerp(offAxis, 5, 15, 1.0, 0.7) : lerp(offAxis, 15, 30, 0.7, 0.3));
    var score = 0.4 * fH + 0.3 * fE + 0.3 * fO;
    var grade = score >= 0.90 ? "S" : score >= 0.78 ? "A" : score >= 0.62 ? "B" : score >= 0.45 ? "C" : "D";
    return { score: score, grade: grade };
  }

  window.SeatMetrics = {
    FORMAT_RATIOS: FORMAT_RATIOS,
    litArea: litArea,
    litPoints: litPoints,
    curveZ: curveZ,
    eyePosition: eyePosition,
    compute: compute,
    gradeOf: gradeOf
  };
})();
