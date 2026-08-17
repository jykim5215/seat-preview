/**
 * src/ui/panel.js — 오른쪽 선택 패널 (브랜드 → 지역 → 극장 → 상영관, 접히는 목록 하나)
 * 도면 목차 스타일. 페이지·모달 없음. 포맷은 상영관 데이터에서 자동 결정한다.
 */
(function () {
  "use strict";

  var root = null, onPick = null;
  var state = { brandId: null, regionId: null, theaterId: null, screenId: null, selLabel: null };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function brands() { return window.THEATER_DATA.brands; }
  function brandOf(id) {
    var list = brands();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
  }
  /** 극장 이름에서 브랜드 접두사를 뗀다 ("CGV 강남" → "강남") */
  function shortName(brand, name) {
    return name.indexOf(brand.name + " ") === 0 ? name.slice(brand.name.length + 1) : name;
  }

  function render() {
    var brand = brandOf(state.brandId);
    root.textContent = "";

    var secH = el("div", "sec-h", "1. 극장 선택");
    if (state.selLabel && !state.regionId) {
      var sum = el("span", "meta", state.selLabel);
      sum.style.cssText = "margin-left:8px;letter-spacing:0;text-transform:none;color:#e8e8ea;font-weight:400";
      secH.appendChild(sum);
    }
    root.appendChild(secH);

    /* ── 브랜드 탭 ── */
    var tabs = el("div", "brand-tabs");
    brands().forEach(function (b) {
      var on = b.id === brand.id;
      var t = el("button", "brand-tab" + (on ? " on" : ""), b.name);
      t.style.setProperty("--accent", b.accent);
      var n = b.regions.reduce(function (a, r) { return a + r.theaters.length; }, 0);
      t.title = b.name + " 극장 " + n;
      t.addEventListener("click", function () {
        if (b.id === state.brandId) return;
        state.brandId = b.id;
        state.regionId = null;
        state.theaterId = null;
        render();
      });
      tabs.appendChild(t);
    });
    root.appendChild(tabs);

    var tree = el("div", "tree");
    root.appendChild(tree);

    brand.regions.forEach(function (rg, ri) {
      var open = rg.id === state.regionId;
      var row = el("div", "row region" + (open ? " on" : ""));
      row.appendChild(el("span", "no", "1." + (ri + 1)));
      row.appendChild(el("span", "", rg.name));
      var nCollected = rg.theaters.filter(function (t) { return t.screens.some(function (s) { return s.hasRows; }); }).length;
      var meta = el("span", "meta", "극장 " + rg.theaters.length + (nCollected ? " · 수집 " + nCollected : ""));
      row.appendChild(el("span", "dots"));
      row.appendChild(meta);
      row.addEventListener("click", function () {
        state.regionId = open ? null : rg.id;
        render();
      });
      tree.appendChild(row);

      if (!open) return;
      rg.theaters.forEach(function (th) {
        var hasData = th.screens.some(function (s) { return s.hasRows; });
        var tOpen = th.id === state.theaterId;
        var trow = el("div", "row depth2" + (tOpen ? " on" : "") + (hasData ? "" : " dim"));
        trow.appendChild(el("span", "no"));
        trow.appendChild(el("span", "", shortName(brand, th.name)));
        trow.appendChild(el("span", "dots"));
        trow.appendChild(el("span", "meta", hasData ? th.screens.length + "관" : "미수집"));
        trow.addEventListener("click", function () {
          if (!hasData) return;
          state.theaterId = tOpen ? null : th.id;
          render();
        });
        tree.appendChild(trow);

        if (!tOpen) return;
        th.screens.forEach(function (sc) {
          var selectable = !!sc.hasRows;
          var sOn = sc.id === state.screenId;
          var srow = el("div", "row depth3" + (sOn ? " on sel-screen" : "") + (selectable ? "" : " dim"));
          srow.appendChild(el("span", "no"));
          srow.appendChild(el("span", "", sc.name));
          srow.appendChild(el("span", "dots"));
          var m = el("span", "meta", sc.totalSeats + "석");
          if (selectable && sc.geometrySource === "estimated") m.appendChild(el("span", "est", "추정"));
          if (selectable && sc.geometrySource === "measured") m.appendChild(el("span", "est measured", "실측"));
          if (!selectable) m.textContent = sc.totalSeats + "석 · 배치 미수집";
          srow.appendChild(m);
          if (selectable) srow.addEventListener("click", function () {
            state.screenId = sc.id;
            state.selLabel = shortName(brand, th.name) + " · " + sc.name;
            state.regionId = null; // 선택 후 목록을 접어 좌석도가 보이게 한다
            state.theaterId = null;
            if (onPick) onPick(brand, rg, th, sc);
            render();
          });
          tree.appendChild(srow);
        });
      });
    });
  }

  /** 상영관 id 로 (브랜드, 지역, 극장, 상영관) 을 찾는다 */
  function locate(screenId) {
    var found = null;
    brands().forEach(function (b) {
      b.regions.forEach(function (rg) {
        rg.theaters.forEach(function (th) {
          th.screens.forEach(function (sc) { if (sc.id === screenId) found = { brand: b, region: rg, theater: th, screen: sc }; });
        });
      });
    });
    return found;
  }

  window.SelectionPanel = {
    init: function (rootEl, opts) {
      root = rootEl;
      onPick = opts.onPick;
    },
    locate: locate,
    /** 초기 선택 상태를 지정하고 그린다 */
    select: function (screenId) {
      var hit = locate(screenId);
      state.regionId = null;   // 초기에도 접힌 상태로 시작 (좌석도 우선)
      state.theaterId = null;
      state.screenId = screenId;
      state.brandId = hit ? hit.brand.id : brands()[0].id;
      state.selLabel = hit ? shortName(hit.brand, hit.theater.name) + " · " + hit.screen.name : null;
      render();
    }
  };
})();
