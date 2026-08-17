/**
 * src/ui/metricsblock.js — 도면 주기(title block) 스타일 계측 표
 * 값 계산은 전적으로 src/geometry/metrics.js (여기서는 표시만 한다)
 */
(function () {
  "use strict";

  var root = null;

  function cell(label, value, note, warn) {
    return '<td><span class="cap">' + label + '</span><div class="num' + (warn ? " warn" : "") + '">' + value +
      '</div><span class="note">' + note + "</span></td>";
  }

  window.MetricsBlock = {
    init: function (el) { root = el; },
    /** @param {Object} m SeatMetrics.compute() 결과 */
    update: function (m) {
      if (!m) { root.innerHTML = ""; return; }
      var thxNote = m.warnings.thx ? "THX 36° 충족" : m.warnings.smpte ? "SMPTE 30° 충족" : "SMPTE 30° 미달";
      if (m.sideWrapDeg) thxNote += " · 측면 투사 포함 " + m.sideWrapDeg.toFixed(0) + "°";
      var sightlineValue = m.sightline ? Math.round(m.sightline.valueM * 1000) + "<small> mm</small>" : "—";
      var sightlineNote = !m.sightline ? "앞좌석 없음" :
        (m.sightline.quality === "good" ? "GOOD · 앞좌석 " :
         m.sightline.quality === "acceptable" ? "허용 · 앞좌석 " :
         m.sightline.quality === "poor" ? "POOR · 앞좌석 " : "가림 위험 · 앞좌석 ") + m.sightline.obstructionId;
      var html = "<table><tr>" +
        cell("거리", m.distance.toFixed(1) + " <small>m</small>", "눈→점등 중심") +
        cell("수평 시야각", m.hFov.toFixed(1) + "<small>°</small>", thxNote, !m.warnings.smpte) +
        cell("수직 시야각", m.vFov.toFixed(1) + "<small>°</small>", "점등 상하단 각") +
        cell("시선 올림각", m.elevation.toFixed(1) + "<small>°</small>", m.warnings.neck ? "목 부담 (35° 초과)" : "한계 35° 이내", m.warnings.neck) +
        cell("좌우 이탈각", m.offAxis.toFixed(1) + "<small>°</small>", m.warnings.keystone ? "사다리꼴 왜곡 (15° 초과)" : "한계 15° 이내", m.warnings.keystone) +
        cell("화면 채움률", (m.fill * 100).toFixed(1) + "<small>%</small>", "전방 반구 대비 입체각") +
        cell("시야선 여유", sightlineValue, sightlineNote, m.warnings.sightline) +
        cell("종합 등급", m.grade, "점수 " + m.score.toFixed(2) + " / S·A·B·C·D") +
        "</tr></table>";
      root.innerHTML = html;
    }
  };
})();
