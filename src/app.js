/**
 * src/app.js — 부트스트랩 · 상태 · 렌더러/계측/UI 연결 · 키보드 · 업데이트 확인
 */
(function () {
  "use strict";

  /* version.json 과 항상 함께 갱신할 것 */
  var APP_VERSION = "0.6.0";
  /* GitHub 저장소 "owner/repo" */
  var GITHUB_REPO = "jykim5215/seat-preview";

  var state = {
    region: null, theater: null, screenRec: null,
    layout: null, seat: null, format: null,
    poster: null,
    // 실제 좌석에서의 몰입감은 60°, 공간 구성 확인은 별도의 90° 룸 뷰로 제공한다.
    renderOptions: { showOccupants: false, ambient: 1, fovMode: 60, viewMode: "seat" }
  };
  var dom = {};
  var announceTimer = 0;

  /* ── 포스터: assets/poster-odyssey.jpg, 없으면 절차적 플레이스홀더 ── */
  function loadPoster(cb) {
    var img = new Image();
    img.onload = function () { cb(img); };
    img.onerror = function () {
      // 플레이스홀더: 동일 종횡비(27:40), 제목 텍스트 + 단색. 외부 다운로드 없음.
      var c = document.createElement("canvas");
      c.width = 540; c.height = 800;
      var g = c.getContext("2d");
      g.fillStyle = "#8c8c96"; g.fillRect(0, 0, 540, 800); // 밝게 — "점등된 화면"으로 읽혀야 한다
      g.fillStyle = "#6f6f78"; g.fillRect(0, 610, 540, 190);
      g.beginPath(); g.arc(270, 300, 90, 0, Math.PI * 2); g.fillStyle = "#a0a0aa"; g.fill();
      g.fillStyle = "#2c2c31";
      g.font = "600 64px 'Segoe UI', 'Malgun Gothic', sans-serif";
      g.textAlign = "center";
      g.fillText("오 디 세 이", 270, 700);
      g.font = "400 22px Consolas, monospace";
      g.fillText("O D Y S S E Y", 270, 745);
      var ph = new Image();
      ph.onload = function () { cb(ph); };
      ph.src = c.toDataURL("image/png");
    };
    img.src = "assets/poster-odyssey.jpg";
  }

  /* ── 씬 구성 → 렌더러 ── */
  function pushScene() {
    var R = window.SeatPreviewRenderer;
    R.setScene({
      screen: state.layout.screen,
      auditorium: state.layout.auditorium,
      seats: state.layout.seats,
      activeSeat: state.seat,
      format: state.format,
      posterImage: state.poster,
      options: {
        showOccupants: state.renderOptions.showOccupants,
        ambient: state.renderOptions.ambient,
        fovMode: state.renderOptions.fovMode
      }
    });
    refreshMetrics();
    refreshHud();
  }

  function refreshMetrics() {
    var m = window.SeatMetrics.compute(state.layout.screen, state.layout.auditorium, state.seat, state.format);
    window.MetricsBlock.update(m);
    refreshInsight(m);
  }

  function refreshInsight(m) {
    if (!m || !dom.insightGrade || !dom.insightCopy) return;
    dom.insightGrade.textContent = m.grade;
    dom.insightGrade.setAttribute("data-grade", m.grade);
    var notes = [];
    if (!m.warnings.smpte) notes.push("화면이 작게 보임");
    else if (m.hFov > 75) notes.push("화면이 시야를 크게 채움");
    else if (m.warnings.thx) notes.push("THX 권장 시야 충족");
    else notes.push("SMPTE 권장 시야 충족");
    if (m.warnings.neck) notes.push("목 부담 주의");
    if (m.warnings.keystone) notes.push("측면 왜곡 주의");
    if (!m.warnings.neck && !m.warnings.keystone) notes.push("시선 부담 낮음");
    dom.insightCopy.textContent = state.seat.id + " · " + m.hFov.toFixed(1) + "° · " + notes.join(" · ");
  }

  function refreshHud() {
    var s = state.seat, a = state.layout.auditorium, scr = state.layout.screen;
    dom.hudTL.innerHTML = "VIEW — SEAT <b>" + s.id + "</b><br>EYE (" +
      s.xM.toFixed(2) + ", " + (s.floorYM + a.eyeHeightM).toFixed(2) + ", " + s.zM.toFixed(2) + ") m";
    var viewLabel = state.renderOptions.viewMode === "room" ? "ROOM VIEW" :
      (state.renderOptions.viewMode === "seat" ? "SEAT VIEW" : "CUSTOM VIEW");
    dom.hudBR.innerHTML = viewLabel + " · HORIZ. FOV " + state.renderOptions.fovMode + "° · " + state.format +
      "<br>SCREEN " + scr.widthM.toFixed(1) + " × " + scr.heightM.toFixed(1) + " m (" +
      (state.screenRec.geometrySource === "measured" ? "MEASURED" : "ESTIMATED") + ")" +
      (window.SeatPreviewRenderer.__isStub ? " · STUB RENDERER" : "");
    dom.headTheater.textContent = state.theater.name + " — " + state.screenRec.name;
    dom.headSeat.textContent = s.id + " (" + s.grade + ")";
    dom.headFormat.textContent = state.format;
  }

  /* ── 좌석 데이터 지연 로딩: data/sites/{siteNo}.js → window.SITE_SEATS[siteNo] ── */
  var siteLoading = {};
  function loadSiteSeats(siteNo, cb) {
    window.SITE_SEATS = window.SITE_SEATS || {};
    if (window.SITE_SEATS[siteNo]) { cb(true); return; }
    if (siteLoading[siteNo]) { siteLoading[siteNo].push(cb); return; }
    siteLoading[siteNo] = [cb];
    var el = document.createElement("script");
    el.src = "data/sites/" + siteNo + ".js";
    el.onload = function () { siteLoading[siteNo].forEach(function (f) { f(!!window.SITE_SEATS[siteNo]); }); delete siteLoading[siteNo]; };
    el.onerror = function () { siteLoading[siteNo].forEach(function (f) { f(false); }); delete siteLoading[siteNo]; };
    document.head.appendChild(el);
  }

  /* ── 선택 흐름 ── */
  function pickScreen(rg, th, sc) {
    loadSiteSeats(th.siteNo, function (ok) {
      var enc = ok && window.SITE_SEATS[th.siteNo] && window.SITE_SEATS[th.siteNo][sc.id.split("-")[1]];
      if (!enc || !enc.rows) {
        dom.status.textContent = "좌석 데이터를 불러올 수 없습니다: " + sc.name;
        return;
      }
      pickScreenLoaded(rg, th, sc, enc);
    });
  }

  function pickScreenLoaded(rg, th, sc, enc) {
    state.region = rg; state.theater = th; state.screenRec = sc;
    state.layout = window.SeatLayout.buildLayout(sc, enc);
    state.format = defaultFormatFor(sc, state.layout.screen);
    // 기본 좌석: 중앙 부근 (열 2/3 지점, 좌우 중앙)
    var seats = state.layout.seats;
    var maxRow = Math.max.apply(null, seats.map(function (s) { return s.rowIndex; }));
    var targetRow = Math.round(maxRow * 0.6);
    var best = seats[0], bestCost = Infinity;
    seats.forEach(function (s) {
      var c = Math.abs(s.rowIndex - targetRow) * 10 + Math.abs(s.xM);
      if (c < bestCost) { bestCost = c; best = s; }
    });
    // 첫 화면부터 스크린 전체와 객석 요소를 함께 판단할 수 있는 계측 최적 좌석을 우선한다.
    var recommended = findBestSeat();
    if (recommended) best = recommended;
    state.seat = best;
    window.SeatMapPlan.show(sc, state.layout, best.id);
    setControlsEnabled(true);
    pushScene();
  }

  function pickSeat(spec) {
    if (!spec || spec === state.seat) return;
    state.seat = spec;
    window.SeatPreviewRenderer.setSeat(spec); // 카메라만 이동 (씬 재구축 없음)
    window.SeatMapPlan.select(spec.id);
    refreshMetrics();
    refreshHud();
  }

  function defaultFormatFor(screenRec, screenGeometry) {
    var formats = screenRec.formats || [];
    var screen = screenGeometry || screenRec.screen || {};
    var ratio = Number(screen.widthM || 0) / Math.max(0.1, Number(screen.heightM || 1));
    if (formats.indexOf("SCREENX") >= 0) return "SCREENX";
    if (formats.indexOf("IMAX 1.43") >= 0 && ratio > 0 && ratio < 1.62) return "IMAX 1.43";
    if (formats.indexOf("IMAX 1.90") >= 0) return "IMAX 1.90";
    if (formats.indexOf("2.39") >= 0 && ratio >= 2.05) return "2.39";
    if (formats.indexOf("1.85") >= 0) return "1.85";
    return formats[0] || "1.85";
  }

  function setControlsEnabled(enabled) {
    [dom.viewSeat, dom.viewRoom, dom.best, dom.capture, dom.occupants, dom.ambient, dom.fov].forEach(function (control) {
      if (control) control.disabled = !enabled;
    });
  }

  function refreshViewButtons() {
    if (dom.viewSeat) dom.viewSeat.classList.toggle("on", state.renderOptions.viewMode === "seat");
    if (dom.viewRoom) dom.viewRoom.classList.toggle("on", state.renderOptions.viewMode === "room");
  }

  function setViewMode(mode) {
    var room = mode === "room";
    state.renderOptions.viewMode = room ? "room" : "seat";
    state.renderOptions.fovMode = room ? 90 : 60;
    dom.fov.value = String(state.renderOptions.fovMode);
    dom.fovValue.textContent = state.renderOptions.fovMode + "°";
    refreshViewButtons();
    applyRenderOptions();
    announce(room ? "극장 구조를 확인하는 90° 룸 뷰" : "실제 좌석 몰입감을 보는 60° 좌석 뷰");
  }

  function applyRenderOptions() {
    if (!state.layout || !state.seat) return;
    pushScene();
  }

  function findBestSeat() {
    if (!state.layout || !state.layout.seats.length) return null;
    var best = null;
    var bestRank = -Infinity;
    state.layout.seats.forEach(function (seat) {
      var m = window.SeatMetrics.compute(state.layout.screen, state.layout.auditorium, seat, state.format);
      // 공식 종합 점수를 우선하고, 동점이면 중앙·45° 부근의 담담한 시야를 선호한다.
      var rank = m.score * 1000 - m.offAxis * 1.2 - Math.abs(m.hFov - 45) * 0.12 - Math.abs(seat.xM) * 0.02;
      if (rank > bestRank) { bestRank = rank; best = seat; }
    });
    return best;
  }

  function goBestSeat() {
    var best = findBestSeat();
    if (!best) return;
    if (best !== state.seat) pickSeat(best);
    var m = window.SeatMetrics.compute(state.layout.screen, state.layout.auditorium, best, state.format);
    announce("추천 좌석 " + best.id + " · 등급 " + m.grade + " · 수평 시야각 " + m.hFov.toFixed(1) + "°");
  }

  function saveCapture() {
    if (!state.layout) return;
    var dataUrl = window.SeatPreviewRenderer.capture();
    if (!dataUrl) {
      announce("PNG 저장 실패 — 로컬 이미지 보안 제한이 적용되었습니다");
      return;
    }
    var link = document.createElement("a");
    var safeTheater = state.theater.name.replace(/[^0-9A-Za-z가-힣_-]+/g, "-");
    link.download = safeTheater + "-" + state.screenRec.name.replace(/[^0-9A-Za-z가-힣_-]+/g, "-") + "-" + state.seat.id + ".png";
    link.href = dataUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    announce("현재 시야를 PNG로 저장했습니다 · " + state.seat.id);
  }

  function announce(message) {
    dom.status.textContent = message;
    clearTimeout(announceTimer);
    announceTimer = setTimeout(function () {
      if (dom.status.textContent === message) dom.status.textContent = "";
    }, 5200);
  }

  /* ── 키보드: 방향키 이동 / Enter 확정 ── */
  function onKey(e) {
    if (!state.layout) return;
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target && e.target.tagName || "")) return;
    var dir = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }[e.key];
    if (dir) {
      e.preventDefault();
      var nx = window.SeatLayout.findNeighbor(state.layout, state.seat, dir);
      if (nx) pickSeat(nx);
    } else if (e.key === "Enter") {
      e.preventDefault();
      announce("좌석 확정: " + state.seat.id + " · " + state.screenRec.name + " · 등급 " +
        window.SeatMetrics.compute(state.layout.screen, state.layout.auditorium, state.seat, state.format).grade);
    } else if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      goBestSeat();
    } else if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      saveCapture();
    } else if (e.key === "v" || e.key === "V") {
      e.preventDefault();
      setViewMode(state.renderOptions.viewMode === "room" ? "seat" : "room");
    }
  }

  /* ── 캔버스 리사이즈 ── */
  function fitCanvas() {
    var box = dom.viewWrap.getBoundingClientRect();
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    window.SeatPreviewRenderer.resize(box.width * dpr, box.height * dpr);
    dom.canvas.style.width = box.width + "px";
    dom.canvas.style.height = box.height + "px";
  }

  /* ── 업데이트 확인 (외부 요청은 이 GitHub API 하나뿐) ── */
  function checkUpdate() {
    if (!GITHUB_REPO) {
      dom.status.textContent = "업데이트: GitHub 저장소 미설정 (v" + APP_VERSION + ")";
      return;
    }
    dom.status.textContent = "업데이트 확인 중…";
    fetch("https://api.github.com/repos/" + GITHUB_REPO + "/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (rel) {
        var latest = (rel.tag_name || "").replace(/^v/, "");
        if (!latest) throw new Error("no tag");
        if (cmpVer(latest, APP_VERSION) > 0) {
          var ok = window.confirm("새 버전 v" + latest + " 이 있습니다.\n\n변경 사항:\n" +
            (rel.body || "(설명 없음)").slice(0, 500) + "\n\n릴리즈 페이지를 열까요?");
          if (ok) window.open(rel.html_url, "_blank");
          dom.status.textContent = "새 버전 v" + latest + " 사용 가능 (현재 v" + APP_VERSION + ")";
        } else {
          dom.status.textContent = "최신 버전입니다 (v" + APP_VERSION + ")";
        }
      })
      .catch(function () {
        // 실패해도 앱 사용에는 지장 없음 — 조용한 한 줄만
        dom.status.textContent = "업데이트 확인 실패 — 오프라인이거나 저장소에 접근할 수 없습니다";
      });
  }
  function cmpVer(a, b) {
    var pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (var i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
    return 0;
  }

  /* ── 부트스트랩 ── */
  function boot() {
    dom.canvas = document.getElementById("view-canvas");
    dom.viewWrap = document.getElementById("view-wrap");
    dom.hudTL = document.getElementById("hud-tl");
    dom.hudBR = document.getElementById("hud-br");
    dom.headTheater = document.getElementById("head-theater");
    dom.headSeat = document.getElementById("head-seat");
    dom.headFormat = document.getElementById("head-format");
    dom.status = document.getElementById("status-msg");
    dom.insightGrade = document.getElementById("insight-grade");
    dom.insightCopy = document.getElementById("insight-copy");
    dom.best = document.getElementById("btn-best");
    dom.viewSeat = document.getElementById("btn-view-seat");
    dom.viewRoom = document.getElementById("btn-view-room");
    dom.capture = document.getElementById("btn-capture");
    dom.occupants = document.getElementById("opt-occupants");
    dom.ambient = document.getElementById("opt-ambient");
    dom.ambientValue = document.getElementById("opt-ambient-value");
    dom.fov = document.getElementById("opt-fov");
    dom.fovValue = document.getElementById("opt-fov-value");
    document.getElementById("btn-update").addEventListener("click", checkUpdate);
    document.getElementById("app-version").textContent = "v" + APP_VERSION;

    dom.best.addEventListener("click", goBestSeat);
    dom.viewSeat.addEventListener("click", function () { setViewMode("seat"); });
    dom.viewRoom.addEventListener("click", function () { setViewMode("room"); });
    dom.capture.addEventListener("click", saveCapture);
    dom.occupants.addEventListener("change", function () {
      state.renderOptions.showOccupants = dom.occupants.checked;
      applyRenderOptions();
      announce(dom.occupants.checked ? "관객 실루엣을 표시합니다" : "관객 실루엣을 숨겼습니다");
    });
    dom.ambient.addEventListener("input", function () {
      dom.ambientValue.textContent = Math.round(Number(dom.ambient.value) * 100) + "%";
    });
    dom.ambient.addEventListener("change", function () {
      state.renderOptions.ambient = Number(dom.ambient.value);
      applyRenderOptions();
      announce("객석 환경광 " + dom.ambientValue.textContent);
    });
    dom.fov.addEventListener("input", function () {
      dom.fovValue.textContent = dom.fov.value + "°";
    });
    dom.fov.addEventListener("change", function () {
      state.renderOptions.fovMode = Number(dom.fov.value);
      state.renderOptions.viewMode = state.renderOptions.fovMode === 60 ? "seat" :
        (state.renderOptions.fovMode === 90 ? "room" : "custom");
      refreshViewButtons();
      applyRenderOptions();
      announce("수평 시야각 " + dom.fovValue.textContent);
    });

    window.SelectionPanel.init(document.getElementById("panel"), { onPick: pickScreen });
    window.SeatMapPlan.init(document.getElementById("seatmap"), { onSeat: pickSeat });
    window.MetricsBlock.init(document.getElementById("metricsblock"));

    window.SeatPreviewRenderer.init(dom.canvas);
    fitCanvas();
    window.addEventListener("resize", fitCanvas);
    window.addEventListener("keydown", onKey);

    loadPoster(function (img) {
      state.poster = img;
      // 기본 선택: 서울 → 용산아이파크몰 → IMAX관
      var rg = window.THEATER_DATA.regions[0];
      var th = null, sc = null;
      window.THEATER_DATA.regions.forEach(function (r) {
        r.theaters.forEach(function (t) {
          t.screens.forEach(function (s) {
            if (s.id === "0013-018") { rg = r; th = t; sc = s; }
          });
        });
      });
      if (!sc) { // 폴백: 데이터가 있는 첫 상영관
        outer: for (var i = 0; i < window.THEATER_DATA.regions.length; i++) {
          var r = window.THEATER_DATA.regions[i];
          for (var j = 0; j < r.theaters.length; j++) {
            for (var k = 0; k < r.theaters[j].screens.length; k++) {
              if (r.theaters[j].screens[k].hasRows) { rg = r; th = r.theaters[j]; sc = r.theaters[j].screens[k]; break outer; }
            }
          }
        }
      }
      window.SelectionPanel.select(rg.id, th.id, sc.id);
      pickScreen(rg, th, sc);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
