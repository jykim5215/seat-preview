/**
 * src/app.js — 부트스트랩 · 상태 · 렌더러/계측/UI 연결 · 키보드 · 업데이트 확인
 */
(function () {
  "use strict";

  /* version.json 과 항상 함께 갱신할 것 */
  var APP_VERSION = "0.2.0";
  /* GitHub 저장소 "owner/repo" */
  var GITHUB_REPO = "jykim5215/seat-preview";

  var state = {
    region: null, theater: null, screenRec: null,
    layout: null, seat: null, format: null,
    poster: null
  };
  var dom = {};

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
      options: { showOccupants: true, ambient: 1, fovMode: 60 }
    });
    refreshMetrics();
    refreshHud();
  }

  function refreshMetrics() {
    var m = window.SeatMetrics.compute(state.layout.screen, state.layout.auditorium, state.seat, state.format);
    window.MetricsBlock.update(m);
  }

  function refreshHud() {
    var s = state.seat, a = state.layout.auditorium, scr = state.layout.screen;
    dom.hudTL.innerHTML = "VIEW — SEAT <b>" + s.id + "</b><br>EYE (" +
      s.xM.toFixed(2) + ", " + (s.floorYM + a.eyeHeightM).toFixed(2) + ", " + s.zM.toFixed(2) + ") m";
    dom.hudBR.innerHTML = "HORIZ. FOV 60° · " + state.format +
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
    state.format = window.SelectionPanel.getFormat() || sc.formats[0];
    // 기본 좌석: 중앙 부근 (열 2/3 지점, 좌우 중앙)
    var seats = state.layout.seats;
    var maxRow = Math.max.apply(null, seats.map(function (s) { return s.rowIndex; }));
    var targetRow = Math.round(maxRow * 0.6);
    var best = seats[0], bestCost = Infinity;
    seats.forEach(function (s) {
      var c = Math.abs(s.rowIndex - targetRow) * 10 + Math.abs(s.xM);
      if (c < bestCost) { bestCost = c; best = s; }
    });
    state.seat = best;
    window.SeatMapPlan.show(sc, state.layout, best.id);
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

  function changeFormat(f) {
    state.format = f;
    pushScene(); // 마스킹이 바뀌므로 씬 교체
  }

  /* ── 키보드: 방향키 이동 / Enter 확정 ── */
  function onKey(e) {
    if (!state.layout) return;
    var dir = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }[e.key];
    if (dir) {
      e.preventDefault();
      var nx = window.SeatLayout.findNeighbor(state.layout, state.seat, dir);
      if (nx) pickSeat(nx);
    } else if (e.key === "Enter") {
      e.preventDefault();
      dom.status.textContent = "좌석 확정: " + state.seat.id + " · " + state.screenRec.name + " · 등급 " +
        window.SeatMetrics.compute(state.layout.screen, state.layout.auditorium, state.seat, state.format).grade;
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
    document.getElementById("btn-update").addEventListener("click", checkUpdate);
    document.getElementById("app-version").textContent = "v" + APP_VERSION;

    window.SelectionPanel.init(document.getElementById("panel"), { onPick: pickScreen, onFormat: changeFormat });
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
      window.SelectionPanel.select(rg.id, th.id, sc.id, sc.formats[0]);
      pickScreen(rg, th, sc);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
