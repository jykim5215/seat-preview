/**
 * src/render/renderer.stub.js — 저품질 폴백 렌더러 (Canvas 2D)
 *
 * 인터페이스 계약(§5)을 완전히 만족한다. renderer.js(three.js 본 구현, Codex 산출물)가
 * 로드되면 window.SeatPreviewRenderer 를 덮어써 이 스텁은 자동으로 대체된다.
 *
 * 스텁의 투영도 "그럴듯한 그림"이 아니라 계산이다:
 *  - 카메라 = 눈 위치(metrics.js 와 동일 좌표), 시선 = 점등 영역 중심
 *  - 수평 화각 60° 고정 핀홀 투영 (본 렌더러와 동일 규칙)
 *  - 곡면 스크린은 패치 분할로 근사, 마스킹·포스터 매핑 반영
 *  - SCREENX: 좌우 벽면 투사 (포스터 가장자리를 미러링·감광해 연장 — 실제 ScreenX 방식 근사)
 *  - 앞좌석 등받이·머리 실루엣, 비상구 유도등·출입구, 통로 유도등
 */
(function () {
  "use strict";

  var canvas = null, ctx = null, scene = null, W = 0, H = 0;
  var cam = null;          // {pos:{x,y,z}, target:{x,y,z}}
  var anim = null;         // 카메라 보간 상태
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

  /** 월드 점 → 화면 픽셀. 카메라 뒤면 null */
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

  /** 텍스처 삼각형: src(이미지픽셀) 3점 → dst(화면) 3점 정확 아핀 매핑 */
  function texTri(img, s0, s1, s2, d0, d1, d2) {
    var cxp = (d0.x + d1.x + d2.x) / 3, cyp = (d0.y + d1.y + d2.y) / 3;
    function ex(p) { return { x: p.x + (p.x - cxp) * 0.012 + (p.x > cxp ? 0.4 : -0.4), y: p.y + (p.y - cyp) * 0.012 + (p.y > cyp ? 0.4 : -0.4) }; }
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

  /** 텍스처 사각 패치 (2 삼각형). src/dst 모두 {TL,TR,BL,BR} */
  function texQuad(img, s, d) {
    if (!d.TL || !d.TR || !d.BL || !d.BR) return;
    texTri(img, s.TL, s.TR, s.BL, d.TL, d.TR, d.BL);
    texTri(img, s.BR, s.BL, s.TR, d.BR, d.BL, d.TR);
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

    ctx.fillStyle = "#050506";
    ctx.fillRect(0, 0, W, H);

    var sw = scr.widthM, sh = scr.heightM, sb = scr.bottomHeightM;

    function screenPoint(x, y) {
      var tz = Math.sin((scr.tiltDeg || 0) * Math.PI / 180) * (y - sb);
      return { x: x, y: y, z: M.curveZ(scr, x) + tz };
    }

    // ── 스크린 유효 영역 (마스킹: 미세 발광 짙은 회색) ──
    var STRIPS = 12;
    for (var i = 0; i < STRIPS; i++) {
      var x0 = -sw / 2 + sw * i / STRIPS, x1 = -sw / 2 + sw * (i + 1) / STRIPS;
      poly([
        project(screenPoint(x0 - 0.01, sb), basis), project(screenPoint(x1 + 0.01, sb), basis),
        project(screenPoint(x1 + 0.01, sb + sh), basis), project(screenPoint(x0 - 0.01, sb + sh), basis)
      ], "#0b0b0c");
    }

    // ── 점등 영역 + 포스터 (16×6 패치) ──
    var lit = P.lit;
    var yB = lit.centerY - lit.h / 2, yT = lit.centerY + lit.h / 2;
    var PX = 16, PY = 6;
    var sx = 0, sy = 0, sWd = 1, sHt = 1;
    if (img) {
      var imgAspect = img.width / img.height, litAspect = lit.w / lit.h;
      if (imgAspect > litAspect) { sHt = img.height; sWd = img.height * litAspect; sx = (img.width - sWd) / 2; }
      else { sWd = img.width; sHt = img.width / litAspect; sy = (img.height - sHt) / 2; }
    }
    for (var j = 0; j < PX; j++) {
      for (var jy = 0; jy < PY; jy++) {
        var lx0 = -lit.w / 2 + lit.w * j / PX, lx1 = -lit.w / 2 + lit.w * (j + 1) / PX;
        var ly1 = yT - lit.h * jy / PY, ly0 = yT - lit.h * (jy + 1) / PY;
        var dTL = project(screenPoint(lx0, ly1), basis), dTR = project(screenPoint(lx1, ly1), basis),
            dBL = project(screenPoint(lx0, ly0), basis), dBR = project(screenPoint(lx1, ly0), basis);
        if (!img) { poly([dBL, dBR, dTR, dTL], "#55555f"); continue; }
        var u0 = sx + sWd * j / PX, u1 = sx + sWd * (j + 1) / PX;
        var v0 = sy + sHt * jy / PY, v1 = sy + sHt * (jy + 1) / PY;
        texQuad(img,
          { TL: { x: u0, y: v0 }, TR: { x: u1, y: v0 }, BL: { x: u0, y: v1 }, BR: { x: u1, y: v1 } },
          { TL: dTL, TR: dTR, BL: dBL, BR: dBR });
      }
    }

    // ── SCREENX 측면 투사 — 좌우 벽면으로 영상이 이어진다 ──
    // 실제 ScreenX 는 측면 전용 소스를 쓰지만, 스텁은 포스터 가장자리 15% 를
    // 미러링해 벽면에 매핑하고 45% 감광한다 (본 렌더러 요구는 CODEX_PROMPT 참조)
    if (s.format === "SCREENX" && scr.sideProjection) {
      var sideLen = scr.sideLenM || 12;
      var SEG = 8;
      [[-1, -sw / 2], [1, sw / 2]].forEach(function (side) {
        var sgn = side[0], wx = side[1];
        var edgeW = sWd * 0.15;
        for (var k = 0; k < SEG; k++) {
          var z0 = 0.3 + (sideLen - 0.3) * k / SEG, z1 = 0.3 + (sideLen - 0.3) * (k + 1) / SEG;
          var dTL2 = project({ x: wx, y: yT, z: z0 }, basis), dTR2 = project({ x: wx, y: yT, z: z1 }, basis),
              dBL2 = project({ x: wx, y: yB, z: z0 }, basis), dBR2 = project({ x: wx, y: yB, z: z1 }, basis);
          if (img) {
            // 미러링: 벽 안쪽(스크린 쪽)이 포스터 가장자리와 이어지게 u 반전
            var mu0 = sgn < 0 ? sx + edgeW * (k / SEG) : sx + sWd - edgeW * (k / SEG);
            var mu1 = sgn < 0 ? sx + edgeW * ((k + 1) / SEG) : sx + sWd - edgeW * ((k + 1) / SEG);
            texQuad(img,
              { TL: { x: mu0, y: sy }, TR: { x: mu1, y: sy }, BL: { x: mu0, y: sy + sHt }, BR: { x: mu1, y: sy + sHt } },
              { TL: dTL2, TR: dTR2, BL: dBL2, BR: dBR2 });
          }
          // 감광 (측면 투사는 정면보다 어둡고 게인이 낮다)
          ctx.save(); ctx.globalAlpha = 0.45;
          poly([dBL2, dBR2, dTR2, dTL2], "#050506");
          ctx.restore();
        }
      });
    }

    // ── 측면 커튼/흡음벽 ──
    ctx.fillStyle = "#08080a";
    [[-sw / 2 - 3.5, -sw / 2 - 0.3], [sw / 2 + 0.3, sw / 2 + 3.5]].forEach(function (xr) {
      poly([
        project({ x: xr[0], y: 0, z: 0.5 }, basis), project({ x: xr[1], y: 0, z: 0.2 }, basis),
        project({ x: xr[1], y: sb + sh + 2, z: 0.2 }, basis), project({ x: xr[0], y: sb + sh + 2, z: 0.5 }, basis)
      ], "#08080a");
    });

    // ── 비상구: 출입구 프레임 + 녹색 유도등 (스크린 좌우 하단 — 실제 극장 위치) ──
    [[-1, -sw / 2 - 1.6], [1, sw / 2 + 1.6]].forEach(function (d) {
      var xd = d[1];
      // 출입구 (문 실루엣)
      poly([
        project({ x: xd - 0.5, y: 0, z: 0.6 }, basis), project({ x: xd + 0.5, y: 0, z: 0.6 }, basis),
        project({ x: xd + 0.5, y: 2.1, z: 0.6 }, basis), project({ x: xd - 0.5, y: 2.1, z: 0.6 }, basis)
      ], "#030304");
      // 유도등 (문 위, 은은한 녹색 발광)
      var ok = poly([
        project({ x: xd - 0.32, y: 2.25, z: 0.58 }, basis), project({ x: xd + 0.32, y: 2.25, z: 0.58 }, basis),
        project({ x: xd + 0.32, y: 2.55, z: 0.58 }, basis), project({ x: xd - 0.32, y: 2.55, z: 0.58 }, basis)
      ], "#1c4a22");
      if (ok) {
        poly([
          project({ x: xd - 0.24, y: 2.31, z: 0.575 }, basis), project({ x: xd + 0.24, y: 2.31, z: 0.575 }, basis),
          project({ x: xd + 0.24, y: 2.49, z: 0.575 }, basis), project({ x: xd - 0.24, y: 2.49, z: 0.575 }, basis)
        ], "#3fae4c");
      }
    });

    // ── 앞좌석 등받이 + 머리 실루엣 (카메라보다 앞열만, 먼 것부터) ──
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
      // 상단 모서리 림 (스크린 빛을 받는 얇은 경계 — 좌석이 어둠에 묻히지 않게)
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
      // file:// 에서는 포스터 이미지가 캔버스를 오염시켜 toDataURL 이 SecurityError 를
      // 던질 수 있다 (Chrome 의 file 출처 정책). 실패 시 빈 문자열 — 앱은 계속 동작.
      try { return canvas.toDataURL("image/png"); } catch (e) { return ""; }
    },

    dispose: function () { if (raf) cancelAnimationFrame(raf); raf = 0; scene = null; ctx = null; canvas = null; }
  };
})();
