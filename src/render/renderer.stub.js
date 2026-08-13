/**
 * src/render/renderer.stub.js — 저품질 폴백 렌더러 (Canvas 2D)
 *
 * 인터페이스 계약(§5)을 완전히 만족한다. renderer.js(three.js 본 구현, Codex 산출물)가
 * 로드되면 window.SeatPreviewRenderer 를 덮어써 이 스텁은 자동으로 대체된다.
 *
 * 스텁의 투영도 "그럴듯한 그림"이 아니라 계산이다:
 *  - 카메라 = 눈 위치(metrics.js 와 동일 좌표), 시선 = 점등 영역 중심
 *  - 수평 화각 60° 고정 핀홀 투영 (본 렌더러와 동일 규칙)
 *  - 곡면 스크린은 12개 세로 스트립으로 근사, 마스킹·포스터 매핑 반영
 *  - 앞좌석 등받이·머리 실루엣 포함
 */
(function () {
  "use strict";

  var canvas = null, ctx = null, scene = null, W = 0, H = 0;
  var cam = null;          // {pos:{x,y,z}, target:{x,y,z}}
  var anim = null;         // 카메라 보간 상태
  var raf = 0, needsDraw = false;

  var H_FOV = 60 * Math.PI / 180;

  /* ── 카메라 수학 ── */
  function lookAtBasis(pos, target) {
    // 시선 -Z' 방향, up=+Y 고정 (머리 기울임 없음)
    var f = norm(sub(target, pos));               // forward
    var r = norm(cross(f, { x: 0, y: 1, z: 0 })); // right
    var u = cross(r, f);                          // up
    return { f: f, r: r, u: u };
  }
  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function cross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
  function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function norm(v) { var l = Math.sqrt(dot(v, v)) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; }

  /** 월드 점 → 화면 픽셀. 카메라 뒤면 null */
  function project(p, basis) {
    var d = sub(p, cam.pos);
    var z = dot(d, basis.f);              // 전방 거리
    if (z < 0.05) return null;
    var x = dot(d, basis.r), y = dot(d, basis.u);
    var half = Math.tan(H_FOV / 2);
    return {
      x: W / 2 + (x / (z * half)) * (W / 2),
      y: H / 2 - (y / (z * half)) * (W / 2), // 수평 화각 고정: 세로도 W 기준 스케일
      z: z
    };
  }

  /* ── 그리기 ── */
  function draw() {
    needsDraw = false;
    if (!ctx || !scene) return;
    var s = scene, scr = s.screen;
    var M = window.SeatMetrics;
    var P = M.litPoints(scr, s.format);
    var basis = lookAtBasis(cam.pos, cam.target);

    ctx.fillStyle = "#050506";
    ctx.fillRect(0, 0, W, H);

    // ── 스크린 전체(마스킹 포함 유효 영역): 세로 스트립으로 곡면 근사 ──
    var STRIPS = 12;
    function screenPoint(x, y) { // 스크린 위 (x: -W/2..W/2, y: 바닥기준높이) → 월드
      var tz = Math.sin((scr.tiltDeg || 0) * Math.PI / 180) * (y - scr.bottomHeightM);
      return { x: x, y: y, z: M.curveZ(scr, x) + tz };
    }
    function quad(x0, x1, yB, yT, fill) {
      var a = project(screenPoint(x0, yB), basis), b = project(screenPoint(x1, yB), basis),
          c = project(screenPoint(x1, yT), basis), d = project(screenPoint(x0, yT), basis);
      if (!a || !b || !c || !d) return null;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      return { a: a, b: b, c: c, d: d };
    }

    var sw = scr.widthM, sh = scr.heightM, sb = scr.bottomHeightM;
    for (var i = 0; i < STRIPS; i++) {
      var x0 = -sw / 2 + sw * i / STRIPS, x1 = -sw / 2 + sw * (i + 1) / STRIPS;
      quad(x0 - 0.01, x1 + 0.01, sb, sb + sh, "#0b0b0c"); // 마스킹: 미세 발광 짙은 회색
    }

    // ── 점등 영역 + 포스터 (16×6 패치 그리드로 원근·곡면 근사) ──
    var lit = P.lit;
    var yB = lit.centerY - lit.h / 2, yT = lit.centerY + lit.h / 2;
    var img = s.posterImage;
    var PX = 16, PY = 6;
    // 포스터 소스 영역: 점등 화면비에 맞춰 중앙 크롭
    var sx = 0, sy = 0, sWd = 1, sHt = 1;
    if (img) {
      var imgAspect = img.width / img.height, litAspect = lit.w / lit.h;
      if (imgAspect > litAspect) { sHt = img.height; sWd = img.height * litAspect; sx = (img.width - sWd) / 2; }
      else { sWd = img.width; sHt = img.width / litAspect; sy = (img.height - sHt) / 2; }
    }
    // 텍스처 삼각형: src(이미지픽셀) 3점 → dst(화면) 3점 정확 아핀 매핑
    function texTri(s0, s1, s2, d0, d1, d2) {
      // 이음새 방지: 목적 삼각형을 무게중심 기준 살짝 확장
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
    for (var j = 0; j < PX; j++) {
      for (var jy = 0; jy < PY; jy++) {
        var lx0 = -lit.w / 2 + lit.w * j / PX, lx1 = -lit.w / 2 + lit.w * (j + 1) / PX;
        var ly1 = yT - lit.h * jy / PY, ly0 = yT - lit.h * (jy + 1) / PY; // 위→아래
        // 월드 4모서리 → 화면 투영 (a:좌하 b:우하 c:우상 d:좌상)
        var pa = project(screenPoint(lx0, ly0), basis), pb = project(screenPoint(lx1, ly0), basis),
            pc = project(screenPoint(lx1, ly1), basis), pd = project(screenPoint(lx0, ly1), basis);
        if (!pa || !pb || !pc || !pd) continue;
        if (!img) {
          ctx.fillStyle = "#55555f";
          ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.lineTo(pc.x, pc.y); ctx.lineTo(pd.x, pd.y);
          ctx.closePath(); ctx.fill();
          continue;
        }
        var srcX0 = sx + sWd * j / PX, srcX1 = sx + sWd * (j + 1) / PX;
        var srcY0 = sy + sHt * jy / PY, srcY1 = sy + sHt * (jy + 1) / PY;
        var sTL = { x: srcX0, y: srcY0 }, sTR = { x: srcX1, y: srcY0 },
            sBL = { x: srcX0, y: srcY1 }, sBR = { x: srcX1, y: srcY1 };
        texTri(sTL, sTR, sBL, pd, pc, pa);
        texTri(sBR, sBL, sTR, pb, pa, pc);
      }
    }

    // ── 측면 커튼/흡음벽 (단순 사다리꼴) ──
    ctx.fillStyle = "#08080a";
    [[-1, -sw / 2 - 3.5, -sw / 2 - 0.3], [1, sw / 2 + 0.3, sw / 2 + 3.5]].forEach(function (side) {
      var a = project({ x: side[1], y: 0, z: 0.5 }, basis), b = project({ x: side[2], y: 0, z: 0.2 }, basis),
          c = project({ x: side[2], y: sb + sh + 2, z: 0.2 }, basis), d = project({ x: side[1], y: sb + sh + 2, z: 0.5 }, basis);
      if (a && b && c && d) {
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
        ctx.closePath(); ctx.fill();
      }
    });

    // ── 앞좌석 등받이 + 머리 실루엣 (카메라보다 앞열만) ──
    var showOcc = !s.options || s.options.showOccupants !== false;
    var seats = (s.seats || []).slice().sort(function (a, b) { return b.zM - a.zM; }); // 먼 것부터
    seats.forEach(function (st) {
      if (st.zM >= cam.pos.z - 0.2) return; // 뒤나 같은 열은 그리지 않음
      var backTop = st.floorYM + 1.0, backW = 0.5;
      var a = project({ x: st.xM - backW / 2, y: st.floorYM + 0.35, z: st.zM }, basis),
          b = project({ x: st.xM + backW / 2, y: st.floorYM + 0.35, z: st.zM }, basis),
          c = project({ x: st.xM + backW / 2, y: backTop, z: st.zM }, basis),
          d = project({ x: st.xM - backW / 2, y: backTop, z: st.zM }, basis);
      if (!a || !b || !c || !d) return;
      ctx.fillStyle = "#030304";
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
      ctx.closePath(); ctx.fill();
      // 고정 시드 의사난수(좌석 id 해시)로 60% 점유 → 머리 실루엣
      if (showOcc) {
        var hsh = 0, id = st.id || "";
        for (var k = 0; k < id.length; k++) hsh = (hsh * 31 + id.charCodeAt(k)) & 0xffff;
        if ((hsh % 10) < 6) {
          var hc = project({ x: st.xM, y: backTop + 0.13, z: st.zM }, basis);
          if (hc) {
            var hr = project({ x: st.xM + 0.11, y: backTop + 0.13, z: st.zM }, basis);
            var rad = hr ? Math.abs(hr.x - hc.x) : 3;
            ctx.beginPath(); ctx.arc(hc.x, hc.y, rad, 0, Math.PI * 2); ctx.fill();
          }
        }
      }
    });

    // ── 통로 유도등 (희미한 점) ──
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
      var e = 1 - Math.pow(1 - t, 3); // ease-out
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

    /** @param {HTMLCanvasElement} c */
    init: function (c) { canvas = c; ctx = c.getContext("2d"); W = c.width; H = c.height; },

    /** 씬 전체 교체 (상영관/포맷 변경) */
    setScene: function (sc) {
      scene = sc;
      cam = { pos: eyeOf(sc.activeSeat), target: targetOf() };
      anim = null;
      invalidate();
    },

    /** 좌석만 변경 — 카메라만 260ms 보간 이동 */
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

    /** 현재 프레임 PNG dataURL */
    capture: function () { if (!canvas) return ""; draw(); return canvas.toDataURL("image/png"); },

    dispose: function () { if (raf) cancelAnimationFrame(raf); raf = 0; scene = null; ctx = null; canvas = null; }
  };
})();
