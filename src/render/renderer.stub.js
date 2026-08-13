/**
 * src/render/renderer.stub.js — 저품질 폴백 렌더러 (Canvas 2D)
 *
 * 인터페이스 계약(§5)을 완전히 만족한다. renderer.js(three.js 본 구현, Codex 산출물)가
 * 로드되면 window.SeatPreviewRenderer 를 덮어써 이 스텁은 자동으로 대체된다.
 *
 * 스텁의 투영도 "그럴듯한 그림"이 아니라 계산이다:
 *  - 카메라 = 눈 위치(metrics.js 와 동일 좌표), 시선 = 점등 영역 중심
 *  - 수평 화각 60° 고정 핀홀 투영 (본 렌더러와 동일 규칙)
 *  - 마스킹·점등 영역은 이음새 없는 단일 경로 + 텍스처 패치 (경계 하이라인 방지)
 *  - SCREENX: 정면 스크린 모서리에서 끊김 없이 이어지는 좌우 벽면 투사, 거리별 점감광
 *  - 비상구: 달리는 사람 픽토그램 유도등 — 실제 극장 표준 위치
 *    (스크린 양측 전방 출구 + 객석 후방 측면 출입구. CGV 는 관별 비상구 좌표를
 *     공개하지 않으므로 다중이용업소 소방 기준의 표준 배치를 반영한 것임)
 */
(function () {
  "use strict";

  var canvas = null, ctx = null, scene = null, W = 0, H = 0;
  var cam = null;
  var anim = null;
  var raf = 0, needsDraw = false;

  var H_FOV = 60 * Math.PI / 180;

  /* ── 벡터·카메라 ── */
  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function cross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
  function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function norm(v) { var l = Math.sqrt(dot(v, v)) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; }
  function lookAtBasis(pos, target) {
    var f = norm(sub(target, pos));
    var r = norm(cross(f, { x: 0, y: 1, z: 0 }));
    var u = cross(r, f);
    return { f: f, r: r, u: u };
  }

  function project(p, basis) {
    var d = sub(p, cam.pos);
    var z = dot(d, basis.f);
    if (z < 0.05) return null;
    var x = dot(d, basis.r), y = dot(d, basis.u);
    var half = Math.tan(H_FOV / 2);
    return { x: W / 2 + (x / (z * half)) * (W / 2), y: H / 2 - (y / (z * half)) * (W / 2), z: z };
  }

  function poly(pts, fill) {
    for (var i = 0; i < pts.length; i++) if (!pts[i]) return false;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    return true;
  }

  /**
   * 텍스처 삼각형. 이음새(검은 하이라인) 방지:
   * 목적 삼각형을 무게중심 기준 픽셀 단위(1.5px)로 확장해 이웃 삼각형과 겹치게 그린다.
   */
  function texTri(img, s0, s1, s2, d0, d1, d2) {
    var cxp = (d0.x + d1.x + d2.x) / 3, cyp = (d0.y + d1.y + d2.y) / 3;
    function ex(p) {
      var dx = p.x - cxp, dy = p.y - cyp;
      var l = Math.sqrt(dx * dx + dy * dy) || 1;
      return { x: p.x + dx / l * 1.5 + dx * 0.01, y: p.y + dy / l * 1.5 + dy * 0.01 };
    }
    var e0 = ex(d0), e1 = ex(d1), e2 = ex(d2);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(e0.x, e0.y); ctx.lineTo(e1.x, e1.y); ctx.lineTo(e2.x, e2.y);
    ctx.closePath(); ctx.clip();
    var a11 = s1.x - s0.x, a12 = s1.y - s0.y, a21 = s2.x - s0.x, a22 = s2.y - s0.y;
    var det = a11 * a22 - a12 * a21;
    if (Math.abs(det) < 1e-9) { ctx.restore(); return; }
    var b11 = d1.x - d0.x, b12 = d1.y - d0.y, b21 = d2.x - d0.x, b22 = d2.y - d0.y;
    var m11 = (b11 * a22 - b21 * a12) / det, m12 = (b12 * a22 - b22 * a12) / det;
    var m21 = (b21 * a11 - b11 * a21) / det, m22 = (b22 * a11 - b12 * a21) / det;
    ctx.transform(m11, m12, m21, m22, d0.x - m11 * s0.x - m21 * s0.y, d0.y - m12 * s0.x - m22 * s0.y);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  function texQuad(img, s, d) {
    if (!d.TL || !d.TR || !d.BL || !d.BR) return;
    texTri(img, s.TL, s.TR, s.BL, d.TL, d.TR, d.BL);
    texTri(img, s.BR, s.BL, s.TR, d.BR, d.BL, d.TR);
  }

  /** 단위 정사각형 → 임의 사각형 아핀 (픽토그램 등 로컬 드로잉용) */
  function unitTransform(dTL, dTR, dBL) {
    ctx.setTransform(dTR.x - dTL.x, dTR.y - dTL.y, dBL.x - dTL.x, dBL.y - dTL.y, dTL.x, dTL.y);
  }

  /**
   * 비상구 유도등 + 출입문.
   * @param sign  월드 사각형 {TL,TR,BL,BR} (유도등 패널)
   * @param door  월드 사각형 또는 null (문 실루엣)
   */
  function drawExit(basis, sign, door) {
    if (door) {
      var dq = door.map(function (p) { return project(p, basis); });
      poly(dq, "#020203");
      // 문틀 라인
      if (dq.every(Boolean)) {
        ctx.strokeStyle = "#141418"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(dq[0].x, dq[0].y);
        for (var i = 1; i < dq.length; i++) ctx.lineTo(dq[i].x, dq[i].y);
        ctx.closePath(); ctx.stroke();
      }
    }
    var TL = project(sign.TL, basis), TR = project(sign.TR, basis),
        BL = project(sign.BL, basis), BR = project(sign.BR, basis);
    if (!TL || !TR || !BL || !BR) return;
    poly([TL, TR, BR, BL], "#1d5b28"); // 녹색 패널 (자발광 — 어둡게 톤 조정)
    var w = Math.hypot(TR.x - TL.x, TR.y - TL.y);
    if (w < 10) return; // 너무 멀면 픽토그램 생략
    ctx.save();
    unitTransform(TL, TR, BL);
    // ── 달리는 사람 픽토그램 (ISO 7010 E002 근사) ──
    ctx.fillStyle = "#cfe9cf";
    ctx.strokeStyle = "#cfe9cf";
    ctx.lineCap = "round";
    // 문
    ctx.fillRect(0.68, 0.14, 0.22, 0.72);
    ctx.fillStyle = "#1d5b28";
    ctx.fillRect(0.72, 0.20, 0.14, 0.60); // 문 안쪽(열린 공간)
    ctx.fillStyle = "#cfe9cf";
    // 머리
    ctx.beginPath(); ctx.arc(0.36, 0.24, 0.085, 0, Math.PI * 2); ctx.fill();
    // 몸통·팔·다리 (기울어진 달리기 자세)
    ctx.lineWidth = 0.10;
    ctx.beginPath(); ctx.moveTo(0.32, 0.36); ctx.lineTo(0.46, 0.58); ctx.stroke();          // 몸통
    ctx.lineWidth = 0.08;
    ctx.beginPath(); ctx.moveTo(0.34, 0.44); ctx.lineTo(0.18, 0.52); ctx.stroke();          // 뒤팔
    ctx.beginPath(); ctx.moveTo(0.38, 0.42); ctx.lineTo(0.55, 0.34); ctx.stroke();          // 앞팔(문 쪽)
    ctx.beginPath(); ctx.moveTo(0.46, 0.58); ctx.lineTo(0.28, 0.74); ctx.stroke();          // 뒷다리
    ctx.beginPath(); ctx.moveTo(0.46, 0.58); ctx.lineTo(0.58, 0.70); ctx.lineTo(0.62, 0.84); ctx.stroke(); // 앞다리
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /* ── 그리기 ── */
  function draw() {
    needsDraw = false;
    if (!ctx || !scene) return;
    var s = scene, scr = s.screen;
    var M = window.SeatMetrics;
    var P = M.litPoints(scr, s.format);
    var basis = lookAtBasis(cam.pos, cam.target);
    var img = s.posterImage;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#050506";
    ctx.fillRect(0, 0, W, H);

    var sw = scr.widthM, sh = scr.heightM, sb = scr.bottomHeightM;

    function screenPoint(x, y) {
      var tz = Math.sin((scr.tiltDeg || 0) * Math.PI / 180) * (y - sb);
      return { x: x, y: y, z: M.curveZ(scr, x) + tz };
    }

    /** 곡면을 따라 x0→x1 을 N 분할한 가장자리 점 목록 (이음새 없는 단일 경로용) */
    function edgePts(x0, x1, y, N) {
      var out = [];
      for (var i = 0; i <= N; i++) out.push(project(screenPoint(x0 + (x1 - x0) * i / N, y), basis));
      return out;
    }

    // ── 그리기 순서 = 물리적 가림 순서 ──
    // 커튼·전방 비상구는 스크린 뒷벽 쪽(z 0.2~0.6)에 있고, 곡면 스크린은 관객 쪽으로
    // 최대 수 m 불룩 나온다(curveZ). 따라서 이들을 스크린보다 먼저 그려야
    // 측면 좌석에서 스크린 위에 검은 판이 덮이는 오류가 없다.

    // ── 측면 커튼/흡음벽 (스크린보다 먼저) + 스크린 산란광 스필 ──
    [[-sw / 2 - 3.5, -sw / 2 - 0.3], [sw / 2 + 0.3, sw / 2 + 3.5]].forEach(function (xr) {
      poly([
        project({ x: xr[0], y: 0, z: 0.5 }, basis), project({ x: xr[1], y: 0, z: 0.2 }, basis),
        project({ x: xr[1], y: sb + sh + 2, z: 0.2 }, basis), project({ x: xr[0], y: sb + sh + 2, z: 0.5 }, basis)
      ], "#08080a");
      // 스크린에 가까운 커튼 자락은 화면 빛을 받아 미세하게 밝다
      var near = xr[0] < 0 ? xr[1] : xr[0];
      var far2 = xr[0] < 0 ? xr[1] - 1.1 : xr[0] + 1.1;
      ctx.save(); ctx.globalAlpha = 0.05;
      poly([
        project({ x: far2, y: 0.2, z: 0.38 }, basis), project({ x: near, y: 0.2, z: 0.3 }, basis),
        project({ x: near, y: sb + sh, z: 0.3 }, basis), project({ x: far2, y: sb + sh, z: 0.38 }, basis)
      ], "#c8c8d4");
      ctx.restore();
    });

    // ── 전방 비상구: 스크린 양측 출구 (스크린보다 먼저 — 곡면에 가려질 수 있음) ──
    [[-1, -sw / 2 - 1.6], [1, sw / 2 + 1.6]].forEach(function (d) {
      var xd = d[1];
      drawExit(basis,
        { TL: { x: xd - 0.32, y: 2.55, z: 0.58 }, TR: { x: xd + 0.32, y: 2.55, z: 0.58 },
          BL: { x: xd - 0.32, y: 2.25, z: 0.58 }, BR: { x: xd + 0.32, y: 2.25, z: 0.58 } },
        [{ x: xd - 0.5, y: 0, z: 0.6 }, { x: xd + 0.5, y: 0, z: 0.6 },
         { x: xd + 0.5, y: 2.1, z: 0.6 }, { x: xd - 0.5, y: 2.1, z: 0.6 }]);
    });

    // ── 스크린 유효 영역 전체: 단일 경로 (마스킹 = 미세 발광 짙은 회색) ──
    var botEdge = edgePts(-sw / 2, sw / 2, sb, 24);
    var topEdge = edgePts(sw / 2, -sw / 2, sb + sh, 24);
    poly(botEdge.concat(topEdge), "#0b0b0c");

    // ── 점등 영역: 단일 경로 베이스 → 텍스처 패치 (경계 하이라인 방지) ──
    var lit = P.lit;
    var yB = lit.centerY - lit.h / 2, yT = lit.centerY + lit.h / 2;
    poly(edgePts(-lit.w / 2, lit.w / 2, yB, 24).concat(edgePts(lit.w / 2, -lit.w / 2, yT, 24)),
      img ? "#1a1a1e" : "#55555f");

    var PX = 16, PY = 6;
    var sx = 0, sy = 0, sWd = 1, sHt = 1;
    if (img) {
      var imgAspect = img.width / img.height, litAspect = lit.w / lit.h;
      if (imgAspect > litAspect) { sHt = img.height; sWd = img.height * litAspect; sx = (img.width - sWd) / 2; }
      else { sWd = img.width; sHt = img.width / litAspect; sy = (img.height - sHt) / 2; }
      for (var j = 0; j < PX; j++) {
        for (var jy = 0; jy < PY; jy++) {
          var lx0 = -lit.w / 2 + lit.w * j / PX, lx1 = -lit.w / 2 + lit.w * (j + 1) / PX;
          var ly1 = yT - lit.h * jy / PY, ly0 = yT - lit.h * (jy + 1) / PY;
          var dTL = project(screenPoint(lx0, ly1), basis), dTR = project(screenPoint(lx1, ly1), basis),
              dBL = project(screenPoint(lx0, ly0), basis), dBR = project(screenPoint(lx1, ly0), basis);
          var u0 = sx + sWd * j / PX, u1 = sx + sWd * (j + 1) / PX;
          var v0 = sy + sHt * jy / PY, v1 = sy + sHt * (jy + 1) / PY;
          texQuad(img,
            { TL: { x: u0, y: v0 }, TR: { x: u1, y: v0 }, BL: { x: u0, y: v1 }, BR: { x: u1, y: v1 } },
            { TL: dTL, TR: dTR, BL: dBL, BR: dBR });

          // 스크린 게인 감쇠: 시선이 표면 법선에서 벗어날수록 어둡다 (핫스팟의 반대면).
          // 실린더 법선: n = (−sinθ, 0, cosθ), sinθ = x/R. 평면이면 (0,0,1).
          var pcx = (lx0 + lx1) / 2;
          var Pw = screenPoint(pcx, (ly0 + ly1) / 2);
          var n = { x: 0, y: 0, z: 1 };
          if (scr.curvatureRadiusM) {
            var sn = Math.max(-0.99, Math.min(0.99, pcx / scr.curvatureRadiusM));
            n = { x: -sn, y: 0, z: Math.sqrt(1 - sn * sn) };
          }
          var vd = norm(sub(cam.pos, Pw));
          var dcos = Math.max(0, dot(n, vd));
          var darkA = 0.30 * Math.pow(1 - dcos, 1.2);
          if (darkA > 0.015) {
            ctx.save(); ctx.globalAlpha = darkA;
            poly([dBL, dBR, dTR, dTL], "#000000");
            ctx.restore();
          }
        }
      }

      // 마스킹 커튼 그림자: 점등 영역 가장자리의 어두운 띠 (실제 마스킹이 드리우는 그늘)
      var borderB = edgePts(-lit.w / 2, lit.w / 2, yB, 24);
      var borderT = edgePts(lit.w / 2, -lit.w / 2, yT, 24);
      ctx.save();
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = Math.max(2, W * 0.003);
      ctx.beginPath();
      var bp = borderB.concat(borderT);
      if (bp.every(Boolean)) {
        ctx.moveTo(bp[0].x, bp[0].y);
        for (var bi = 1; bi < bp.length; bi++) ctx.lineTo(bp[bi].x, bp[bi].y);
        ctx.closePath(); ctx.stroke();
      }
      ctx.restore();
    }

    // ── 스크린 앞 바닥 반사광 (화면 빛이 바닥에 은은하게 비침) ──
    if (img && s.auditorium) {
      ctx.save(); ctx.globalAlpha = 0.05;
      poly([
        project({ x: -lit.w * 0.45, y: 0.01, z: 0.4 }, basis),
        project({ x: lit.w * 0.45, y: 0.01, z: 0.4 }, basis),
        project({ x: lit.w * 0.35, y: 0.01, z: Math.max(1.5, s.auditorium.firstRowZM * 0.85) }, basis),
        project({ x: -lit.w * 0.35, y: 0.01, z: Math.max(1.5, s.auditorium.firstRowZM * 0.85) }, basis)
      ], "#c8c8d4");
      ctx.restore();
    }

    // ── SCREENX 측면 투사 — 정면 모서리에서 끊김 없이 이어진다 ──
    if (s.format === "SCREENX" && scr.sideProjection && img) {
      var sideLen = scr.sideLenM || 12;
      var SEG = 10;
      [[-1, -lit.w / 2], [1, lit.w / 2]].forEach(function (side) {
        var sgn = side[0];
        // 시작점 = 점등 영역 모서리의 실제 3D 위치 (곡면·기울기 반영) → 이음 틈 없음
        var edge = screenPoint(side[1], (yB + yT) / 2);
        var zStart = edge.z + 0.001, xWall = side[1];
        var edgeW = sWd * 0.15;
        for (var k = 0; k < SEG; k++) {
          var z0 = zStart + (sideLen - zStart) * k / SEG, z1 = zStart + (sideLen - zStart) * (k + 1) / SEG;
          var dTL2 = project({ x: xWall, y: yT, z: sgn > 0 ? z0 : z1 }, basis),
              dTR2 = project({ x: xWall, y: yT, z: sgn > 0 ? z1 : z0 }, basis),
              dBL2 = project({ x: xWall, y: yB, z: sgn > 0 ? z0 : z1 }, basis),
              dBR2 = project({ x: xWall, y: yB, z: sgn > 0 ? z1 : z0 }, basis);
          // 미러링: 벽 안쪽 끝이 포스터 가장자리와 색이 이어지도록
          var m0 = sgn > 0 ? sx + sWd - edgeW * (k / SEG) : sx + edgeW * ((k + 1) / SEG);
          var m1 = sgn > 0 ? sx + sWd - edgeW * ((k + 1) / SEG) : sx + edgeW * (k / SEG);
          var q = { TL: dTL2, TR: dTR2, BL: dBL2, BR: dBR2 };
          if (sgn > 0) texQuad(img, { TL: { x: m0, y: sy }, TR: { x: m1, y: sy }, BL: { x: m0, y: sy + sHt }, BR: { x: m1, y: sy + sHt } }, q);
          else texQuad(img, { TL: { x: m1, y: sy }, TR: { x: m0, y: sy }, BL: { x: m1, y: sy + sHt }, BR: { x: m0, y: sy + sHt } }, q);
          // 점감광: 정면 모서리(15%)에서 벽 끝(55%)으로 갈수록 어둡게 — 연결부 자연스럽게
          var fade = 0.15 + 0.40 * ((k + 0.5) / SEG);
          ctx.save(); ctx.globalAlpha = fade;
          poly([q.BL, q.BR, q.TR, q.TL], "#050506");
          ctx.restore();
        }
      });
    }

    // ── 후방 비상구: 객석 측면 출입구 (입장 통로 — 관객 근처라 스크린에 가려지지 않음) ──
    var maxZ = 10;
    (s.seats || []).forEach(function (st) { if (st.zM > maxZ) maxZ = st.zM; });
    var rearZ = maxZ - 0.5, wallX = sw / 2 + 1.2;
    [[-1, -wallX], [1, wallX]].forEach(function (d) {
      var xw = d[1], sgn = d[0];
      var floorY = 0; // 후방 바닥은 단차 위 — 계단 위 통로 높이로 근사
      (s.seats || []).forEach(function (st) { if (Math.abs(st.zM - rearZ) < 1.2 && st.floorYM > floorY) floorY = st.floorYM; });
      // 문 (측벽 평면: x 고정, z 방향 폭)
      drawExit(basis,
        { TL: { x: xw, y: floorY + 2.55, z: rearZ - 0.32 * sgn }, TR: { x: xw, y: floorY + 2.55, z: rearZ + 0.32 * sgn },
          BL: { x: xw, y: floorY + 2.25, z: rearZ - 0.32 * sgn }, BR: { x: xw, y: floorY + 2.25, z: rearZ + 0.32 * sgn } },
        [{ x: xw, y: floorY, z: rearZ - 0.5 }, { x: xw, y: floorY, z: rearZ + 0.5 },
         { x: xw, y: floorY + 2.1, z: rearZ + 0.5 }, { x: xw, y: floorY + 2.1, z: rearZ - 0.5 }]);
    });

    // ── 앞좌석 등받이 + 머리 실루엣 ──
    var showOcc = !s.options || s.options.showOccupants !== false;
    var seats = (s.seats || []).slice().sort(function (a, b) { return b.zM - a.zM; });
    seats.forEach(function (st) {
      if (st.zM >= cam.pos.z - 0.2) return;
      var backTop = st.floorYM + 1.0, backW = 0.55;
      var a = project({ x: st.xM - backW / 2, y: st.floorYM + 0.3, z: st.zM }, basis),
          b = project({ x: st.xM + backW / 2, y: st.floorYM + 0.3, z: st.zM }, basis),
          c = project({ x: st.xM + backW / 2, y: backTop, z: st.zM }, basis),
          d = project({ x: st.xM - backW / 2, y: backTop, z: st.zM }, basis);
      if (!a || !b || !c || !d) return;
      poly([a, b, c, d], "#030304");
      ctx.strokeStyle = "#1d1d22"; ctx.lineWidth = Math.max(1, (c.x - d.x) * 0.02);
      ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(c.x, c.y); ctx.stroke();
      if (showOcc) {
        var hsh = 0, id = st.id || "";
        for (var k2 = 0; k2 < id.length; k2++) hsh = (hsh * 31 + id.charCodeAt(k2)) & 0xffff;
        if ((hsh % 10) < 6) {
          var hc = project({ x: st.xM, y: backTop + 0.13, z: st.zM }, basis);
          var hr = project({ x: st.xM + 0.11, y: backTop + 0.13, z: st.zM }, basis);
          if (hc && hr) {
            ctx.fillStyle = "#050507";
            ctx.beginPath(); ctx.arc(hc.x, hc.y, Math.abs(hr.x - hc.x), 0, Math.PI * 2); ctx.fill();
          }
        }
      }
    });

    // ── 통로 유도등 ──
    ctx.fillStyle = "#1c2b1a";
    for (var z = 4; z < cam.pos.z; z += 3) {
      [-sw / 2 - 1, sw / 2 + 1].forEach(function (x) {
        var p = project({ x: x, y: 0.05, z: z }, basis);
        if (p) { ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill(); }
      });
    }
  }

  function loop() {
    raf = 0;
    if (anim) {
      var t = Math.min(1, (performance.now() - anim.t0) / 260);
      var e = 1 - Math.pow(1 - t, 3);
      cam.pos = {
        x: anim.from.x + (anim.to.x - anim.from.x) * e,
        y: anim.from.y + (anim.to.y - anim.from.y) * e,
        z: anim.from.z + (anim.to.z - anim.from.z) * e
      };
      if (t >= 1) anim = null;
      needsDraw = true;
    }
    if (needsDraw) draw();
    if (anim || needsDraw) raf = requestAnimationFrame(loop);
  }
  function invalidate() { needsDraw = true; if (!raf) raf = requestAnimationFrame(loop); }

  function eyeOf(seat) {
    var a = scene.auditorium;
    return { x: seat.xM, y: seat.floorYM + a.eyeHeightM, z: seat.zM };
  }
  function targetOf() {
    return window.SeatMetrics.litPoints(scene.screen, scene.format).center;
  }

  window.SeatPreviewRenderer = {
    __isStub: true,

    init: function (c) { canvas = c; ctx = c.getContext("2d"); W = c.width; H = c.height; },

    setScene: function (sc) {
      scene = sc;
      cam = { pos: eyeOf(sc.activeSeat), target: targetOf() };
      anim = null;
      invalidate();
    },

    setSeat: function (seat) {
      if (!scene) return;
      scene.activeSeat = seat;
      anim = { from: { x: cam.pos.x, y: cam.pos.y, z: cam.pos.z }, to: eyeOf(seat), t0: performance.now() };
      cam.target = targetOf();
      invalidate();
    },

    resize: function (w, h) {
      if (!canvas) return;
      canvas.width = W = Math.round(w);
      canvas.height = H = Math.round(h);
      invalidate();
    },

    capture: function () {
      if (!canvas) return "";
      draw();
      try { return canvas.toDataURL("image/png"); } catch (e) { return ""; }
    },

    dispose: function () { if (raf) cancelAnimationFrame(raf); raf = 0; scene = null; ctx = null; canvas = null; }
  };
})();
