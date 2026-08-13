# 좌석 시야 미리보기 — CGV

CGV 예매 좌석을 고르면 **그 좌석에서 스크린이 실제로 어떻게 보이는지**를 물리 계산으로 렌더링하는 데스크톱 웹앱.
로컬 서버 없이 동작한다 — `index.html` 을 더블클릭하면 끝.

## 실행

- `index.html` 더블클릭, 또는 `실행.bat`, 또는 바탕화면의 "좌석 시야 미리보기" 바로가기
- 대상: 최신 Chrome/Edge, 데스크톱 1280×800 이상

## 조작

| 입력 | 동작 |
|---|---|
| 오른쪽 패널 클릭 | 지역 → 극장 → 상영관 선택 (수집된 관만 선택 가능) |
| 좌석도 클릭 / 방향키 | 좌석 이동 — 왼쪽 시야가 즉시 갱신 |
| Enter | 좌석 확정 (하단 상태줄에 요약) |
| 포맷 칩 | IMAX 1.43 / 1.90 / 2.39 / 1.85 — 마스킹·계측 동시 갱신 |

## 데이터

- 지역 9 · 극장 178 (CGV 실제 분류) — **전 극장 좌석 배치 수집** (CGV 예매 좌석도 실데이터, 2026-08-13 수집. 수집일에 상영이 없던 일부 관은 "미수집")
- 좌석 데이터는 극장별 파일(`data/sites/{siteNo}.js`)로 분리되어 선택 시 지연 로딩된다
- 스크린 실측치는 CGV 비공개 → 용산 IMAX(31×22.4 m, 공개 수치)만 "실측", 나머지는 좌석 배치 기반 **추정** (`src/data/estimate.js`, UI에 표기)
- SCREENX 관은 좌우 벽면 투사(`sideProjection`)가 렌더·계측에 반영된다 (포맷 "SCREENX" 선택 시)
- 파이프라인: `data/raw-cgv-*.json`(수집 원본) → `node tools/import-cgv-raw.js` → `data/theaters.json`(인덱스, 편집용) + `data/sites/*.js` → `node tools/build-data.js` → `data/theaters.js`

## 포스터

`assets/poster-odyssey.jpg` 를 직접 넣으면 스크린에 표시된다 (저작권상 미동봉).
없으면 동일 종횡비 플레이스홀더로 폴백.

## 렌더러

- 현재: `src/render/renderer.stub.js` (Canvas 2D, 인터페이스 계약 완전 만족)
- 본 구현: `CODEX_PROMPT.md` 하나만 읽고 `src/render/renderer.js` (three.js) 를 만들면
  자동으로 스텁을 대체한다. `renderer.js` 를 지우면 다시 스텁으로 폴백.

## 바로가기 재생성

폴더를 옮겼다면:

```bash
powershell -ExecutionPolicy Bypass -File tools/make-shortcut.ps1
```

아이콘 재생성: `node tools/build-icon.js` (`assets/icon.svg` → `icon.ico`)

## 업데이트

하단 상태줄 "CHECK UPDATE" — [jykim5215/seat-preview](https://github.com/jykim5215/seat-preview) Releases 최신 버전과 비교 (공개 API, 인증 없음).
버전은 `version.json` + `src/app.js` 의 `APP_VERSION` 을 항상 함께 올린다.

## 웹 버전

로컬 실행과 동일한 앱이 GitHub Pages 로도 서비스된다:
**https://jykim5215.github.io/seat-preview/**

## 폴더 구조

```
index.html            앱 진입점 (더블클릭 실행)
version.json          semantic versioning
HANDOFF.md            Codex/Claude 교대용 핸드오프 브리프
CODEX_PROMPT.md       3D 렌더러 외주 프롬프트 (자기완결)
assets/               icon.svg·icon.ico·(poster-odyssey.jpg)
vendor/three.min.js   three.js r147 로컬 동봉
data/                 theaters.json(원본)·theaters.js(앱용)·raw-cgv-collected.json
src/geometry/         metrics.js — 계측 7종 단일 진리원
src/data/             layout.js(좌표 변환)·estimate.js(기하 추정)
src/render/           renderer.stub.js·(renderer.js ← Codex 산출물 자리)
src/ui/               panel.js·seatmap.js·metricsblock.js
tools/                build-data.js·import-cgv-raw.js·build-icon.js·make-shortcut.ps1
mockups/              스타일 후보 3안 (B안 채택)
```
