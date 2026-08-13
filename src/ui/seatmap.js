/**
 * src/ui/seatmap.js — 좌석 배치 평면도 (건축 도면 스타일 SVG)
 * 스크린 위 · 좌석 아래, 열 라벨 양쪽, 선 위주, 채움 최소.
 * 선택 좌석만 CGV 레드, 지시선(leader)으로 좌석 정보 주기.
 */
(function () {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";
  var root = null, onSeat = null;
  var current = { rec: null, layout: null, selectedId: null };

  function sv(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function txt(x, y, str, attrs) {
    var t = sv("text", Object.assign({ x: x, y: y, "font-size": 7, fill: "#8a8a8f", "font-family": "Consolas, monospace" }, attrs || {}));
    t.textContent = str;
    return t;
  }

  var U = 6; // 1 그리드단위 = 6 SVG px

  function render() {
    var rec = current.rec, layout = current.layout;
    root.textContent = "";
    if (!rec) return;

    var g = layout.grid;
    var mapW = (g.maxX - g.minX) * U;
    var padL = 26, padR = 40, padT = 46, padB = 66;
    var mapH = g.maxY * U;
    var vbW = mapW + padL + padR, vbH = mapH + padT + padB;

    var svg = sv("svg", { viewBox: "0 0 " + vbW + " " + vbH, "font-family": "Consolas, monospace" });
    root.appendChild(svg);

    function X(gx) { return padL + (gx - g.minX) * U; }
    function Y(gy) { return padT + gy * U; }

    // ── 스크린 (곡면이면 호, 평면이면 직선) ──
    var scr = layout.screen;
    var x0 = X(g.minX), x1 = X(g.maxX);
    var midX = (x0 + x1) / 2;
    var sag = scr.curvatureRadiusM ? 8 : 0;
    var arc = sv("path", {
      d: "M " + x0 + " " + (padT - 26 + sag) + " Q " + midX + " " + (padT - 26 - sag) + " " + x1 + " " + (padT - 26 + sag),
      fill: "none", stroke: "#8a8a8f", "stroke-width": 1
    });
    svg.appendChild(arc);
    svg.appendChild(txt(midX, padT - 31, "SCREEN", { "text-anchor": "middle", "letter-spacing": 4, "font-size": 8 }));

    // 치수선: 스크린 폭
    var dimY = padT - 14;
    svg.appendChild(sv("line", { x1: x0, y1: dimY, x2: x1, y2: dimY, stroke: "#1e1e21" }));
    svg.appendChild(sv("line", { x1: x0, y1: dimY - 4, x2: x0, y2: dimY + 4, stroke: "#1e1e21" }));
    svg.appendChild(sv("line", { x1: x1, y1: dimY - 4, x2: x1, y2: dimY + 4, stroke: "#1e1e21" }));
    svg.appendChild(txt(midX, dimY + 9, "SCREEN W " + scr.widthM.toFixed(1) + " m" + (current.rec.geometrySource === "estimated" ? " (추정)" : ""), { "text-anchor": "middle" }));

    // ── 좌석 ──
    var selSeat = null;
    var strokeFor = function (grade) {
      return /일반/.test(grade) ? "#3a3a3f" : "#6f6f75"; // 특수 등급은 밝은 이중톤
    };
    layout.rows.forEach(function (row) {
      row.seats.forEach(function (spec) {
        var isSel = spec.id === current.selectedId;
        var r = sv("rect", {
          x: X(spec.gx), y: Y(spec.gy), width: U * spec.gw - 1, height: U * spec.gh - 2,
          fill: isSel ? "#d40000" : "none",
          stroke: isSel ? "#d40000" : strokeFor(spec.grade),
          "stroke-width": 1, "data-id": spec.id
        });
        r.style.cursor = "pointer";
        r.addEventListener("click", function () { if (onSeat) onSeat(spec); });
        svg.appendChild(r);
        if (isSel) selSeat = { s: spec, row: row, spec: spec };
      });
      // 열 라벨 (양쪽)
      var yLbl = Y(row.gy) + U + 2;
      svg.appendChild(txt(padL - 14, yLbl, row.label));
      svg.appendChild(txt(X(g.maxX) + 8, yLbl, row.label));
    });

    // 치수선: 최전열 거리 (오른쪽 세로)
    var zX = X(g.maxX) + 24;
    svg.appendChild(sv("line", { x1: zX, y1: padT - 26, x2: zX, y2: Y(1), stroke: "#1e1e21" }));
    svg.appendChild(sv("line", { x1: zX - 4, y1: padT - 26, x2: zX + 4, y2: padT - 26, stroke: "#1e1e21" }));
    svg.appendChild(sv("line", { x1: zX - 4, y1: Y(1), x2: zX + 4, y2: Y(1), stroke: "#1e1e21" }));
    svg.appendChild(txt(zX + 3, (padT - 26 + Y(1)) / 2, layout.auditorium.firstRowZM.toFixed(1) + "m", { "font-size": 6.5 }));

    // ── 선택 좌석 지시선 + 주기 ──
    if (selSeat) {
      var sx = X(selSeat.s.gx) + U, sy = Y(selSeat.s.gy) + U * 2;
      var lx = Math.min(sx + 44, vbW - padR - 100), ly = mapH + padT + 16;
      svg.appendChild(sv("line", { x1: sx, y1: sy, x2: lx, y2: ly, stroke: "#8a8a8f", "stroke-width": 0.7 }));
      svg.appendChild(sv("line", { x1: lx, y1: ly, x2: lx + 96, y2: ly, stroke: "#8a8a8f", "stroke-width": 0.7 }));
      svg.appendChild(txt(lx + 3, ly - 3,
        selSeat.spec.id + " · " + selSeat.spec.grade + " · z=" + selSeat.spec.zM.toFixed(2) + "m", { fill: "#e8e8ea" }));
    }

    // ── 범례 + 주기 ──
    var legY = mapH + padT + 32;
    var lx0 = padL;
    svg.appendChild(sv("rect", { x: lx0, y: legY, width: 11, height: 9, fill: "none", stroke: "#3a3a3f" }));
    svg.appendChild(txt(lx0 + 16, legY + 8, "일반"));
    svg.appendChild(sv("rect", { x: lx0 + 50, y: legY, width: 11, height: 9, fill: "none", stroke: "#6f6f75" }));
    svg.appendChild(txt(lx0 + 66, legY + 8, "특수(스위트/프라임 등)"));
    svg.appendChild(sv("rect", { x: lx0 + 178, y: legY, width: 11, height: 9, fill: "#d40000", stroke: "#d40000" }));
    svg.appendChild(txt(lx0 + 194, legY + 8, "선택"));

    var noteY = legY + 22;
    svg.appendChild(txt(padL, noteY, "NOTE 1. 좌석 좌표: CGV 예매 좌석도 그리드 실데이터 (1단위=" + layout.seatsUnitNote + ")"));
    svg.appendChild(txt(padL, noteY + 11, "NOTE 2. " + (current.rec.geometrySource === "measured" ? "스크린 치수 실측(공개 자료), 객석 기하 추정." : "스크린·객석 치수는 좌석 배치 기반 추정값.")));
    svg.appendChild(txt(padL, noteY + 22, "NOTE 3. 방향키 좌석 이동 · ENTER 확정 · 시야 즉시 갱신."));
  }

  window.SeatMapPlan = {
    init: function (rootEl, opts) { root = rootEl; onSeat = opts.onSeat; },
    show: function (screenRec, layout, selectedId) {
      layout.seatsUnitNote = "0.28 m";
      current.rec = screenRec; current.layout = layout; current.selectedId = selectedId;
      render();
    },
    select: function (id) { current.selectedId = id; render(); }
  };
})();
