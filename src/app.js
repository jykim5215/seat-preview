/**
 * src/app.js — 부트스트랩 · 상태 · 렌더러/계측/UI 연결 · 키보드 · 업데이트 확인
 */
(function () {
  "use strict";

  /* version.json 과 항상 함께 갱신할 것 */
  var APP_VERSION = "0.9.1";
  /* GitHub 저장소 "owner/repo" */
  var GITHUB_REPO = "jykim5215/seat-preview";

  var state = {
    brand: null, region: null, theater: null, screenRec: null,
    layout: null, seat: null, format: null,
    poster: null, panorama: null, calibration: false,
    // 실제 좌석에서의 몰입감은 60°, 공간 구성 확인은 별도의 90° 룸 뷰로 제공한다.
    renderOptions: { showOccupants: false, ambient: 1, fovMode: 60, viewMode: "seat" }
  };
  var dom = {};
  var announceTimer = 0;

  var posterCache = {};
  var pickSerial = 0;

  function hashText(value) {
    var hash = 2166136261;
    value = String(value || "");
    for (var i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function sceneFor(rg, th, sc) {
    var pool = window.scenePoolFor(rg.name) || [];
    if (!pool.length) return "assets/poster-odyssey.jpg";
    return pool[hashText(th.siteNo + ":" + sc.id) % pool.length];
  }

  function screenXSceneFor(rg, th, sc) {
    // 지역 id 는 브랜드마다 체계가 달라(CGV r01 · 메가박스 mr01 · 롯데 lr0001) 이름으로 고른다
    var pool = window.screenxPoolFor(rg.name) || [];
    if (!pool.length) return null;
    return pool[hashText("screenx:" + th.siteNo + ":" + sc.id) % pool.length];
  }

  var calibrationCache = {};
  function calibrationFrame(panorama) {
    var key = panorama ? "panorama" : "front";
    if (calibrationCache[key]) return calibrationCache[key];
    var c = document.createElement("canvas");
    c.width = panorama ? 1536 : 1024;
    c.height = panorama ? 512 : 428;
    var g = c.getContext("2d");
    var bands = ["#050506", "#171719", "#3a3a3d", "#77777b", "#b8b8ba", "#f1f1ee"];
    var bandW = c.width / bands.length;
    bands.forEach(function (color, i) {
      g.fillStyle = color;
      g.fillRect(i * bandW, 0, Math.ceil(bandW), c.height * 0.54);
    });
    var colors = ["#b33a35", "#b08b36", "#4c8a55", "#3c748f", "#5b4f84", "#8e4771"];
    colors.forEach(function (color, i) {
      g.fillStyle = color;
      g.fillRect(i * bandW, c.height * 0.54, Math.ceil(bandW), c.height * 0.27);
    });
    g.fillStyle = "#0b0b0c";
    g.fillRect(0, c.height * 0.81, c.width, c.height * 0.19);
    for (var x = 0; x < c.width; x += Math.max(8, Math.round(c.width / 96))) {
      var v = Math.round(255 * x / c.width);
      g.fillStyle = "rgb(" + v + "," + v + "," + v + ")";
      g.fillRect(x, c.height * 0.87, Math.max(8, Math.round(c.width / 96)), c.height * 0.07);
    }
    if (panorama) {
      g.strokeStyle = "rgba(255,255,255,.72)";
      g.lineWidth = 3;
      [0.21, 0.79].forEach(function (u) {
        g.beginPath(); g.moveTo(c.width * u, 0); g.lineTo(c.width * u, c.height); g.stroke();
      });
    }
    calibrationCache[key] = c;
    return c;
  }

  /* ── 지역·상영관별 영화 장면. 누락 시 절차적 플레이스홀더 ── */
  function loadPoster(path, cb) {
    if (posterCache[path]) { cb(posterCache[path]); return; }
    var img = new Image();
    img.decoding = "async";
    img.onload = function () { posterCache[path] = img; cb(img); };
    img.onerror = function () {
      // 외부 요청 없이 동작하는 밝은 2.39:1 플레이스홀더.
      var c = document.createElement("canvas");
      c.width = 960; c.height = 402;
      var g = c.getContext("2d");
      var gradient = g.createLinearGradient(0, 0, 960, 402);
      gradient.addColorStop(0, "#35475a"); gradient.addColorStop(0.55, "#8b775f"); gradient.addColorStop(1, "#d6c7a7");
      g.fillStyle = gradient; g.fillRect(0, 0, 960, 402);
      g.fillStyle = "rgba(7,12,18,.78)";
      g.font = "600 54px 'Segoe UI', 'Malgun Gothic', sans-serif";
      g.textAlign = "center";
      g.fillText("좌석 시야 미리보기", 480, 202);
      var ph = new Image();
      ph.onload = function () { posterCache[path] = ph; cb(ph); };
      ph.src = c.toDataURL("image/png");
    };
    img.src = path;
  }

  /* ── 씬 구성 → 렌더러 ── */
  function pushScene() {
    var R = window.SeatPreviewRenderer;
    var poster = state.calibration ? calibrationFrame(false) : state.poster;
    var panorama = state.calibration ? calibrationFrame(true) : state.panorama;
    R.setScene({
      brand: state.brand && state.brand.id,
      hall: state.screenRec.hall || null,
      geometrySource: state.screenRec.geometrySource,
      exitsMeasured: !!(state.layout.exits && state.layout.exits.length),
      screen: state.layout.screen,
      auditorium: state.layout.auditorium,
      seats: state.layout.seats,
      exits: state.layout.exits,
      activeSeat: state.seat,
      format: state.format,
      posterImage: poster,
      panoramaImage: panorama,
      options: {
        showOccupants: state.renderOptions.showOccupants,
        ambient: state.renderOptions.ambient,
        fovMode: state.renderOptions.fovMode,
        viewMode: state.renderOptions.viewMode
      }
    });
    refreshMetrics();
    refreshHud();
  }

  function refreshMetrics() {
    var m = window.SeatMetrics.compute(state.layout.screen, state.layout.auditorium, state.seat, state.format, state.layout.seats);
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
    if (m.warnings.sightline) notes.push("앞사람 가림 주의");
    if (!m.warnings.neck && !m.warnings.keystone && !m.warnings.sightline) notes.push("시선 부담 낮음");
    dom.insightCopy.textContent = state.seat.id + " · " + m.hFov.toFixed(1) + "° · " + notes.join(" · ");
  }

  function refreshHud() {
    var s = state.seat, a = state.layout.auditorium, scr = state.layout.screen;
    var eye = window.SeatMetrics.eyePosition(s, a);
    dom.hudTL.innerHTML = "VIEW — SEAT <b>" + s.id + "</b><br>EYE (" +
      eye.x.toFixed(2) + ", " + eye.y.toFixed(2) + ", " + eye.z.toFixed(2) + ") m";
    var viewLabel = state.renderOptions.viewMode === "room" ? "ROOM VIEW" :
      (state.renderOptions.viewMode === "seat" ? "SEAT VIEW" : "SCREENX VIEW");
    dom.hudBR.innerHTML = viewLabel + " · HORIZ. FOV " + state.renderOptions.fovMode + "° · " + state.format +
      "<br>SCREEN " + scr.widthM.toFixed(1) + " × " + scr.heightM.toFixed(1) + " m (" +
      (state.screenRec.geometrySource === "measured" ? "MEASURED" : "ESTIMATED") + ")" +
      " · DISPLAY-RELATIVE LIGHT" +
      (state.layout.exits && state.layout.exits.length ? " · EXITS ACTUAL" : " · EXITS STANDARD") +
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
    // 배포 버전이 바뀌면 GitHub Pages/브라우저의 오래된 좌석 파일 캐시를 우회한다.
    el.src = "data/sites/" + siteNo + ".js?v=" + encodeURIComponent(APP_VERSION);
    el.onload = function () { siteLoading[siteNo].forEach(function (f) { f(!!window.SITE_SEATS[siteNo]); }); delete siteLoading[siteNo]; };
    el.onerror = function () { siteLoading[siteNo].forEach(function (f) { f(false); }); delete siteLoading[siteNo]; };
    document.head.appendChild(el);
  }

  /* ── 선택 흐름 ── */
  function pickScreen(brand, rg, th, sc) {
    var serial = ++pickSerial;
    dom.status.textContent = "지역별 영화 장면을 불러오는 중…";
    loadSiteSeats(th.siteNo, function (ok) {
      // 상영관 id 는 "{siteNo}-{관번호}" — siteNo 에 하이픈이 없으므로 마지막 조각이 관번호다
      var scnNo = sc.id.slice(th.siteNo.length + 1);
      var enc = ok && window.SITE_SEATS[th.siteNo] && window.SITE_SEATS[th.siteNo][scnNo];
      if (!enc || !enc.rows) {
        dom.status.textContent = "좌석 데이터를 불러올 수 없습니다: " + sc.name;
        return;
      }
      var path = sceneFor(rg, th, sc);
      var isScreenX = (sc.formats || []).indexOf("SCREENX") >= 0;
      var panoramaPath = isScreenX ? screenXSceneFor(rg, th, sc) : null;
      loadPoster(path, function (img) {
        if (serial !== pickSerial) return;
        if (!panoramaPath) {
          state.poster = img; state.panorama = null;
          pickScreenLoaded(brand, rg, th, sc, enc);
          dom.status.textContent = "";
          return;
        }
        loadPoster(panoramaPath, function (panorama) {
          if (serial !== pickSerial) return;
          state.poster = img; state.panorama = panorama;
          pickScreenLoaded(brand, rg, th, sc, enc);
          dom.status.textContent = "";
        });
      });
    });
  }

  function pickScreenLoaded(brand, rg, th, sc, enc) {
    state.brand = brand; state.region = rg; state.theater = th; state.screenRec = sc;
    document.body.style.setProperty("--brand", brand.accent);
    state.layout = window.SeatLayout.buildLayout(sc, enc);
    state.format = defaultFormatFor(sc, state.layout.screen);
    state.calibration = false;
    state.renderOptions.viewMode = state.format === "SCREENX" ? "panorama" : "seat";
    state.renderOptions.fovMode = state.format === "SCREENX" ? 120 : 60;
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
    if (dom.fov) dom.fov.value = String(state.renderOptions.fovMode);
    if (dom.fovValue) dom.fovValue.textContent = state.renderOptions.fovMode + "°";
    if (dom.calibration) dom.calibration.classList.remove("on");
    refreshViewButtons();
    window.SeatMapPlan.show(sc, state.layout, best.id, brand);
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
    [dom.viewSeat, dom.viewRoom, dom.best, dom.capture, dom.occupants, dom.ambient, dom.fov, dom.calibration].forEach(function (control) {
      if (control) control.disabled = !enabled;
    });
    if (dom.viewPanorama) {
      dom.viewPanorama.hidden = state.format !== "SCREENX";
      dom.viewPanorama.disabled = !enabled || state.format !== "SCREENX";
    }
  }

  function refreshViewButtons() {
    if (dom.viewSeat) dom.viewSeat.classList.toggle("on", state.renderOptions.viewMode === "seat");
    if (dom.viewRoom) dom.viewRoom.classList.toggle("on", state.renderOptions.viewMode === "room");
    if (dom.viewPanorama) dom.viewPanorama.classList.toggle("on", state.renderOptions.viewMode === "panorama");
  }

  function setViewMode(mode) {
    var panorama = mode === "panorama" && state.format === "SCREENX";
    var room = mode === "room";
    state.renderOptions.viewMode = panorama ? "panorama" : (room ? "room" : "seat");
    state.renderOptions.fovMode = panorama ? 120 : (room ? 90 : 60);
    dom.fov.value = String(state.renderOptions.fovMode);
    dom.fovValue.textContent = state.renderOptions.fovMode + "°";
    refreshViewButtons();
    applyRenderOptions();
    announce(panorama ? "좌우 투사 연결을 확인하는 120° ScreenX 파노라마 뷰" :
      (room ? "극장 구조를 확인하는 90° 룸 뷰" : "실제 좌석 몰입감을 보는 60° 좌석 뷰"));
  }

  function toggleCalibration() {
    state.calibration = !state.calibration;
    if (dom.calibration) dom.calibration.classList.toggle("on", state.calibration);
    applyRenderOptions();
    announce(state.calibration ? "동일한 명암·이음선 기준 프레임을 표시합니다" : "지역별 영화 장면으로 돌아왔습니다");
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
      var m = window.SeatMetrics.compute(state.layout.screen, state.layout.auditorium, seat, state.format, state.layout.seats);
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
    var m = window.SeatMetrics.compute(state.layout.screen, state.layout.auditorium, best, state.format, state.layout.seats);
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
        window.SeatMetrics.compute(state.layout.screen, state.layout.auditorium, state.seat, state.format, state.layout.seats).grade);
    } else if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      goBestSeat();
    } else if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      saveCapture();
    } else if (e.key === "v" || e.key === "V") {
      e.preventDefault();
      if (state.format === "SCREENX") {
        setViewMode(state.renderOptions.viewMode === "seat" ? "room" :
          (state.renderOptions.viewMode === "room" ? "panorama" : "seat"));
      } else setViewMode(state.renderOptions.viewMode === "room" ? "seat" : "room");
    } else if (e.key === "c" || e.key === "C") {
      e.preventDefault();
      toggleCalibration();
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

  /** 좌석 배치가 수집된 첫 상영관 (기본 선택 폴백) */
  function firstCollectedScreen() {
    var brands = window.THEATER_DATA.brands;
    for (var b = 0; b < brands.length; b++) {
      for (var i = 0; i < brands[b].regions.length; i++) {
        var rg = brands[b].regions[i];
        for (var j = 0; j < rg.theaters.length; j++) {
          for (var k = 0; k < rg.theaters[j].screens.length; k++) {
            var sc = rg.theaters[j].screens[k];
            if (sc.hasRows) return { brand: brands[b], region: rg, theater: rg.theaters[j], screen: sc };
          }
        }
      }
    }
    return null;
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
    dom.viewPanorama = document.getElementById("btn-view-panorama");
    dom.calibration = document.getElementById("btn-calibration");
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
    dom.viewPanorama.addEventListener("click", function () { setViewMode("panorama"); });
    dom.calibration.addEventListener("click", toggleCalibration);
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

    // 기본 선택: CGV 서울 → 용산아이파크몰 → IMAX관 (없으면 데이터가 있는 첫 상영관)
    var hit = window.SelectionPanel.locate("0013-018") || firstCollectedScreen();
    window.SelectionPanel.select(hit.screen.id);
    pickScreen(hit.brand, hit.region, hit.theater, hit.screen);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
