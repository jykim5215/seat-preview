/**
 * src/ui/panel.js — 오른쪽 선택 패널 (지역 → 극장 → 상영관, 접히는 목록 하나)
 * 도면 목차 스타일. 페이지·모달 없음. 포맷 칩 포함.
 */
(function () {
  "use strict";

  var root = null, onPick = null, onFormat = null;
  var state = { regionId: null, theaterId: null, screenId: null, format: null, selLabel: null };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function render() {
    var data = window.THEATER_DATA;
    root.textContent = "";

    var secH = el("div", "sec-h", "1. 극장 선택");
    if (state.selLabel && !state.regionId) {
      var sum = el("span", "meta", state.selLabel);
      sum.style.cssText = "margin-left:8px;letter-spacing:0;text-transform:none;color:#e8e8ea;font-weight:400";
      secH.appendChild(sum);
    }
    root.appendChild(secH);
    var tree = el("div", "tree");
    root.appendChild(tree);

    data.regions.forEach(function (rg, ri) {
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
        trow.appendChild(el("span", "", th.name.replace(/^CGV /, "")));
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
            state.format = sc.formats[0];
            state.selLabel = th.name.replace(/^CGV /, "") + " · " + sc.name;
            state.regionId = null; // 선택 후 목록을 접어 좌석도가 보이게 한다
            state.theaterId = null;
            if (onPick) onPick(rg, th, sc);
            render();
          });
          tree.appendChild(srow);
        });
      });
    });

    // ── 포맷 칩 ──
    var current = findScreen(state.screenId);
    if (current) {
      root.appendChild(el("div", "sec-h", "2. 상영 포맷"));
      var chips = el("div", "chips");
      current.formats.forEach(function (f) {
        var c = el("div", "chip" + (f === state.format ? " on" : ""), f);
        c.addEventListener("click", function () {
          state.format = f;
          if (onFormat) onFormat(f);
          render();
        });
        chips.appendChild(c);
      });
      root.appendChild(chips);
    }
  }

  function findScreen(id) {
    if (!id) return null;
    var found = null;
    window.THEATER_DATA.regions.forEach(function (rg) {
      rg.theaters.forEach(function (th) {
        th.screens.forEach(function (sc) { if (sc.id === id) found = sc; });
      });
    });
    return found;
  }

  window.SelectionPanel = {
    init: function (rootEl, opts) {
      root = rootEl;
      onPick = opts.onPick;
      onFormat = opts.onFormat;
    },
    /** 초기 선택 상태를 지정하고 그린다 */
    select: function (regionId, theaterId, screenId, format) {
      state.regionId = null;   // 초기에도 접힌 상태로 시작 (좌석도 우선)
      state.theaterId = null;
      state.screenId = screenId;
      state.format = format;
      var sc = findScreen(screenId);
      if (sc) {
        window.THEATER_DATA.regions.forEach(function (rg) {
          rg.theaters.forEach(function (th) {
            th.screens.forEach(function (s) {
              if (s.id === screenId) state.selLabel = th.name.replace(/^CGV /, "") + " · " + s.name;
            });
          });
        });
      }
      render();
    },
    getFormat: function () { return state.format; }
  };
})();
